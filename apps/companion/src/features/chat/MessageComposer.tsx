import {
  Box, Button, ChatInput, Column, elevation, IconButton, ImageThumbnail, ImageViewer, Row, SegmentedControl, Spacer, Text, type ChatInputHandle,
} from '@pi-lead-child/components';
import {
  CHAT_IMAGE_MAX_COUNT, CHAT_IMAGES_MAX_TOTAL_BASE64_LENGTH, parseCompactCommand, type ChatImageInput, type ChatPlacement,
  type ChatQuoteInput, type CompactLeadContextRequest,
} from '@pi-lead-child/protocol';
import { useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';

import { useLocale, type Locale } from '@/i18n';
import {
  canPickImages, canTakePhoto, ChatImageError, pickImageFiles, prepareChatImage, type ChatImageSource, type ComposerImage, type PickedImage,
} from '@/data/chatImagePicker';
import { useCompanionRuntime } from '@/state/CompanionStateProvider';

import type { CompactNotice } from './compactCommand';
import { composerMessages } from './composer.messages';
import { QuotingSlot, QuoteTray } from './QuoteTray';
import { quoteDrafts, useQuoteDrafts } from './quoteDrafts';

type MessageComposerProps = {
  contextKey: string;
  placeholder: string;
  // images：随消息发的图片（只有给了 attachImages 的输入框才会有）。quotes：引用的几段话（只有给了 quotes 的输入框才会有）。
  onSend: (message: string, images: ChatImageInput[], quotes?: ChatQuoteInput[]) => void;
  compact?: boolean;
  // 工单对话坞里的输入框：一行，只有文字和发送按钮。
  minimal?: boolean;
  disabled?: boolean;
  // 能不能带图片：Lead 的会话，daemon 也收图片（CHAT_IMAGES_CAPABILITY）。这个平台还不能选图片时（canPickImages）也没有「+」。
  attachImages?: boolean;
  // 输入 /model 发送时（只有 Lead 的会话给）：不发给 Lead，在输入框上方打开换模型的浮层（模型配置方案 C 的 S4）。
  onModelCommand?: () => void;
  // /compact [model] [-- instructions] (only Lead's conversation gives it): compact Lead's context, do not send it to Lead.
  // Resolves to one line for the user under the input (compactCommand.ts): a status, or a refusal (tone danger).
  onCompactCommand?: (request: CompactLeadContextRequest) => Promise<CompactNotice>;
  // 输入区上面的小标签，例如「只这一条」的单轮模型（TurnModelChip）。
  chip?: ReactNode;
  // 工具栏右边、发送按钮前面的模型名（桌面上的 Lead 会话：LeadModelComposerTrigger，写着模型 id 和推理强度，点开换模型）。
  modelControl?: ReactNode;
  // Lead 正忙时，这条消息插话还是排队（工单 04，spec D6）。给出时，输入框上面多一个选择。
  placement?: { value: ChatPlacement; onChange: (value: ChatPlacement) => void };
  // 那一行右边的状态（工单 10：Lead 忙时排着的外部消息，LeadQueueBar）。只和 placement 一起出现，不让那一行变高。
  placementStatus?: ReactNode;
  // 输入卡片上半截的状态栏（主题 11.13，2026-10-28）：排着的事。row 是卡片里的那一行；drawer 是展开时从这一行
  // 往上长出来的列表，盖在会话上，不推动会话。展开时卡片上面两个角变成直角，和列表接成一块。
  tray?: ComposerTray | null;
  // 手机首页的悬浮输入框（主题 H-6，2026-11-14 方案 F）：圆角 28、一档阴影、没有边框；字大一号；
  // 下面一行只有加号和发送两颗 44 的圆钮，不显示模型。点加号调 onPlus，由页面升起加号面板（H-7）。
  float?: boolean;
  onPlus?: () => void;
  // 页面拿来从加号面板里选图片（选好的图片加进这张输入框）。
  ref?: Ref<MessageComposerHandle>;
  // 能不能带引用（设计规范 P17）：Lead 的会话，daemon 也收引用（CHAT_QUOTES_CAPABILITY）。给了时卡片上半截有引用托盘；
  // 手机（float）上正在引用的一段在输入区上面，这时输入的字是对这一段的说明（Q-5）。
  quotes?: boolean;
};

// focus：手机上开始引用一段以后，聚焦输入框、弹出键盘（设计规范 P17.10）。
export type MessageComposerHandle = {
  pickImages: (source?: ChatImageSource) => void;
  canAttach: boolean;
  // 这台设备能拍照（手机上的加号面板有「拍照」）。
  canTakePhoto: boolean;
  focus: () => void;
};

export type ComposerTray = { row: ReactNode; drawer: ReactNode; open: boolean };

function placementOptions(locale: Locale) {
  const placement = composerMessages(locale).placement;
  return [
    { value: 'steer', label: placement.steer },
    { value: 'followUp', label: placement.followUp },
  ] as const;
}

export function MessageComposer(props: MessageComposerProps) {
  const locale = useLocale();
  const field = <MessageComposerField key={`${props.contextKey}:${props.disabled ? 'disabled' : 'enabled'}`} {...props} />;
  if (!props.placement) return field;
  // 插话：在 Lead 当前这批工具调用之后加进这一轮。排队：Lead 答完这一轮再答，连着排队的几条一起答。
  return (
    <Column gap="field">
      <Row items="center" gap="inline-item">
        <SegmentedControl
          testID="composer-placement"
          optionTestID={(value) => `composer-placement-${value}`}
          size="sm"
          options={placementOptions(locale)}
          value={props.placement.value}
          onChange={props.placement.onChange}
        />
        {props.placementStatus ? <Box flex={1} minW={0}>{props.placementStatus}</Box> : null}
      </Row>
      {field}
    </Column>
  );
}

// 消息输入框（2026-10-25，参考 Kimi）：一张白色圆角卡片。上面是待发的图片（64×64 的小图，可以删掉单张），
// 中间是文字（缺省一行高，内容多了自动长高），下面一行工具栏：左边「+」选图片，右边模型名和圆形的发送按钮。
// web 上 Enter 发送、Shift+Enter 换行；可以粘贴剪贴板里的图片。草稿按 contextKey 存在工作区里，失去焦点时保存（图片不存）。
function MessageComposerField({
  contextKey, placeholder, onSend, compact = false, minimal = false, disabled = false, attachImages = false, onModelCommand, onCompactCommand,
  chip, modelControl, tray,
  float = false, onPlus, ref, quotes = false,
}: MessageComposerProps) {
  const locale = useLocale();
  const m = composerMessages(locale);
  const workspace = useCompanionRuntime().workspace;
  const [text, setText] = useState(() => workspace.getState().composerDraftByContext[contextKey] ?? '');
  // 待发的图片，和图片加不进来的原因（不是图片、太多、太大；下一次加图片、删图片或发送时清掉）。放在一起，用一次更新改。
  const [attachments, setAttachments] = useState<{ images: ComposerImage[]; notice: string | null }>(EMPTY_ATTACHMENTS);
  const { images, notice } = attachments;
  // 正在处理（读取、缩小）的图片张数：处理完之前不能发送。
  const [preparing, setPreparing] = useState(0);
  // What the last /compact did: a status line, or the error (tone danger). Cleared by the next send.
  const [commandNotice, setCommandNotice] = useState<{ text: string; tone: 'muted' | 'danger' } | null>(null);
  const canAttach = attachImages && canPickImages && !minimal;
  const quoteCount = useQuoteDrafts((state) => (quotes ? state.drafts.length + (state.pending ? 1 : 0) : 0));
  const pendingQuote = useQuoteDrafts((state) => (quotes ? state.pending : null));
  // 手机上正在引用：输入框写的是对这一段的说明，存在引用里（Q-5）；平常的草稿留着，加上或取消以后回来。
  const noteMode = float && pendingQuote !== null;
  const ready = !disabled && preparing === 0 && (text.trim().length > 0 || images.length > 0 || quoteCount > 0);
  const inputRef = useRef<ChatInputHandle>(null);

  const send = () => {
    if (!ready) return;
    // /model 是界面自己的命令：打开换模型的浮层，这句话不发给 Lead（daemon 的 /fairyeye、/stop 才交给 daemon）。
    if (onModelCommand && isModelCommand(text) && images.length === 0) {
      setText('');
      workspace.getState().clearComposerDraft(contextKey);
      onModelCommand();
      return;
    }
    const compactRequest = onCompactCommand && images.length === 0 ? parseCompactCommand(text) : null;
    if (onCompactCommand && compactRequest) {
      setText('');
      workspace.getState().clearComposerDraft(contextKey);
      setCommandNotice({ text: m.compact.sending, tone: 'muted' });
      onCompactCommand(compactRequest).then(
        (notice) => setCommandNotice(notice),
        () => setCommandNotice({ text: m.compact.failed, tone: 'danger' }),
      );
      inputRef.current?.focus();
      return;
    }
    setCommandNotice(null);
    const taken = quotes ? quoteDrafts.getState().take() : [];
    const sentImages = images.map(({ mimeType, data }) => ({ mimeType, data }));
    if (taken.length) onSend(text.trim(), sentImages, taken);
    else onSend(text.trim(), sentImages);
    setText('');
    setAttachments(EMPTY_ATTACHMENTS);
    workspace.getState().clearComposerDraft(contextKey);
    // 发完以后焦点回到输入框，好接着打字（2026-11-02）。点发送按钮时焦点在按钮上，按钮随后变灰，焦点会掉到页面上。
    inputRef.current?.focus();
  };

  const addFiles = async (files: readonly PickedImage[]) => {
    if (!canAttach || !files.length) return;
    setPreparing((count) => count + files.length);
    const results = await Promise.allSettled(files.map((file) => prepareChatImage(file, locale)));
    setPreparing((count) => count - files.length);
    const prepared = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    const failed = failure ? (failure.reason instanceof ChatImageError ? failure.reason.message : m.imageFailed) : null;
    setAttachments((current) => appendImages(current.images, prepared, failed, m.tooManyImages(CHAT_IMAGE_MAX_COUNT)));
  };

  // 打开系统的选图（或相机）。没有权限、打不开时，原因写在输入框里。
  const pickImages = (source: ChatImageSource = 'library') => {
    pickImageFiles(source, locale).then(addFiles, (error: unknown) => {
      setAttachments((current) => ({ ...current, notice: error instanceof ChatImageError ? error.message : m.imageFailed }));
    });
  };
  useImperativeHandle(ref, () => ({ pickImages, canAttach, canTakePhoto: canAttach && canTakePhoto, focus: () => inputRef.current?.focus() }));
  // 点一张待发的小图：全屏看大图（通用的 ImageViewer），下面一颗「删掉这张」。
  const [viewing, setViewing] = useState<number | null>(null);
  const viewer = (
    <ImageViewer
      testID="composer-image-viewer"
      open={viewing !== null}
      items={images.map((image, index) => ({ key: image.key, uri: image.uri, label: m.image(index + 1) }))}
      initialIndex={viewing ?? 0}
      onClose={() => setViewing(null)}
      actions={[{ id: 'remove', label: m.removeThisImage, icon: 'trash', onPress: (index) => { const image = images[index]; if (image) removeImage(image.key); } }]}
    />
  );

  const removeImage = (key: string) => {
    setAttachments((current) => ({ images: current.images.filter((image) => image.key !== key), notice: null }));
  };

  const input = (
    <ChatInput
      ref={inputRef}
      value={noteMode ? pendingQuote.note : text}
      onChangeText={noteMode ? (note: string) => quoteDrafts.getState().setPendingNote(note) : setText}
      placeholder={noteMode ? m.quoteNotePlaceholder : placeholder}
      disabled={disabled}
      onSubmit={send}
      {...(canAttach ? { onPasteFiles: (files: Blob[]) => void addFiles(files) } : {})}
      onBlur={() => workspace.getState().setComposerDraft(contextKey, text)}
      large={float}
      testID="composer-input"
    />
  );
  const sendButton = (
    <IconButton
      testID="send-message"
      icon="arrow-up"
      label={m.send}
      variant="solid"
      // 没有可发的内容时是灰色（Kimi 的样式），有了变成主色。
      tone={ready ? 'accent' : 'neutral'}
      size={minimal ? 'sm' : 'md'}
      rounded="full"
      disabled={!ready}
      onPress={send}
    />
  );

  if (float) {
    // 发送键：没有字时 surface-muted 底、text-secondary 图标；有字时 accent 底、白色图标（H-6）。
    // 没有字时不用停用的样子（会整体变淡），按下也不发。
    return (
      <Column
        testID="composer"
        rounded="6xl"
        bg="surface"
        boxShadow={elevation.float}
        p="float-composer"
        gap="composer-row"
        opacity={disabled ? 0.62 : 1}
      >
        {images.length ? (
          <Row testID="composer-images" flexWrap="wrap" gap="thumbnails" px="inline-item">
            {images.map((image, index) => (
              <ImageThumbnail
                key={image.key}
                testID={`composer-image-${index}`}
                uri={image.uri}
                label={m.image(index + 1)}
                removeLabel={m.removeImage(index + 1)}
                onPress={() => setViewing(index)}
                onRemove={() => removeImage(image.key)}
              />
            ))}
          </Row>
        ) : null}
        {quotes ? <QuoteTray compact /> : null}
        {notice ? <Text testID="composer-notice" size="note" tone="danger" px="inline-item">{notice}</Text> : null}
        {commandNotice ? <Text testID="composer-command-notice" size="note" tone={commandNotice.tone} px="inline-item">{commandNotice.text}</Text> : null}
        {chip ? <Box px="inline-item" pt="inline-item">{chip}</Box> : null}
        {noteMode ? <QuotingSlot onFocusInput={() => inputRef.current?.focus()} /> : null}
        <Box px="inline-item" py="inline-item">{input}</Box>
        <Row items="center" gap="inline-item">
          {onPlus ? (
            <IconButton
              testID="composer-plus"
              icon="plus"
              label={m.plus}
              variant="soft"
              tone="neutral"
              size="xl"
              rounded="full"
              iconColor="text"
              disabled={disabled}
              onPress={onPlus}
            />
          ) : null}
          {preparing > 0 ? <Text testID="composer-preparing" size="note" tone="muted">{m.preparingImages}</Text> : null}
          <Spacer />
          {noteMode ? (
            // Q-6：正在引用时多一颗「加上」：收进托盘，接着引用别处（P17.5）。改托盘里的一条时是「删掉」和「保存」。
            pendingQuote.editingId ? (
              <>
                <Button testID="quote-remove" label={m.quoteRemove} variant="soft" tone="neutral" size="lg" shape="pill"
                  onPress={() => quoteDrafts.getState().remove(pendingQuote.editingId!)} />
                <Button testID="quote-save" label={m.quoteSave} icon="check" tone="accent" size="lg" shape="pill"
                  onPress={() => quoteDrafts.getState().commit()} />
              </>
            ) : (
              <Button testID="quote-add" label={m.quoteAdd} icon="plus" variant="soft" tone="neutral" size="lg" shape="pill"
                onPress={() => quoteDrafts.getState().commit()} />
            )
          ) : null}
          {noteMode && pendingQuote.editingId ? null : <IconButton
            testID="send-message"
            icon="arrow-up"
            label={m.send}
            variant={ready ? 'solid' : 'soft'}
            tone={ready ? 'accent' : 'neutral'}
            size="xl"
            rounded="full"
            iconColor={ready ? 'surface' : 'text-secondary'}
            onPress={send}
          />}
        </Row>
        {viewer}
      </Column>
    );
  }

  if (minimal) {
    // 工单对话坞：文字和发送按钮在一行，发送按钮贴着底边，文字长高时它留在最后一行旁边。
    return (
      // 工单对话坞的输入框（主题 11.21）：灰底的胶囊，没有描边，贴在对话卡片的底部。
      <Row
        testID="composer"
        items="flex-end"
        gap="side-item"
        px="composer-x"
        py="composer-y"
        rounded="full"
        bg="surface-muted"
        opacity={disabled ? 0.62 : 1}
      >
        {/* spacing-exempt: 文字一行高 24，发送按钮 34，上下各留 5 让一行字和按钮居中对齐 */}
        <Box flex={1} minW={0} py={5}>{input}</Box>
        {sendButton}
      </Row>
    );
  }

  const body = (
    <Column gap="composer-row" px="composer-x" py="composer-y">
      {images.length ? (
        <Row testID="composer-images" flexWrap="wrap" gap="thumbnails">
          {images.map((image, index) => (
            <ImageThumbnail
              key={image.key}
              testID={`composer-image-${index}`}
              uri={image.uri}
              label={m.image(index + 1)}
              removeLabel={m.removeImage(index + 1)}
              onPress={() => setViewing(index)}
              onRemove={() => removeImage(image.key)}
            />
          ))}
        </Row>
      ) : null}
      {notice ? <Text testID="composer-notice" size="note" tone="danger">{notice}</Text> : null}
      {commandNotice ? <Text testID="composer-command-notice" size="note" tone={commandNotice.tone}>{commandNotice.text}</Text> : null}
      {chip ?? null}
      {input}
      <Row items="center" gap="inline-item">
        {canAttach ? (
          <IconButton
            testID="composer-attach"
            icon="plus"
            label={m.addImage}
            variant="ghost"
            size="md"
            iconColor="text-secondary"
            disabled={disabled}
            onPress={() => pickImages()}
          />
        ) : null}
        {preparing > 0 ? <Text testID="composer-preparing" size="note" tone="muted">{m.preparingImages}</Text> : null}
        <Spacer />
        {modelControl ?? null}
        {sendButton}
      </Row>
    </Column>
  );
  const open = Boolean(tray?.open);
  const card = (
    <Column
      testID="composer"
      rounded="4xl"
      {...(open ? { borderTopLeftRadius: 0, borderTopRightRadius: 0 } : {})}
      borderWidth={1}
      borderColor="border-input"
      bg="surface"
      boxShadow={compact ? '0 4px 14px rgba(16,24,40,0.06)' : '0 6px 20px rgba(16,24,40,0.08)'}
      opacity={disabled ? 0.62 : 1}
      // 状态栏和引用托盘的底色是方角：裁到卡片的圆角里，不盖住上面两个角的边框。
      overflow={tray || quotes ? 'hidden' : undefined}
    >
      {tray ? tray.row : null}
      {quotes ? <QuoteTray /> : null}
      {body}
    </Column>
  );
  // 展开的列表盖在会话上（P1、P2）：贴着卡片的上沿，宽度和卡片一样。
  // 外面这一层一直在：状态栏出现、消失时输入框不会重新挂载（不丢焦点，不丢正在打的字）。
  return (
    <Box position="relative">
      {tray ? tray.drawer : null}
      {card}
      {viewer}
    </Box>
  );
}

// 整条消息只有 /model（不分大小写，两头的空白不算）。
export function isModelCommand(text: string): boolean {
  return /^\/model$/i.test(text.trim());
}

const EMPTY_ATTACHMENTS: { images: ComposerImage[]; notice: string | null } = { images: [], notice: null };

// 加上新处理好的图片：最多 CHAT_IMAGE_MAX_COUNT 张，base64 加起来不超过上限，多出来的不加，提示一句。
function appendImages(
  current: readonly ComposerImage[], added: readonly ComposerImage[], failed: string | null, tooMany: string,
): { images: ComposerImage[]; notice: string | null } {
  const images = [...current];
  let total = images.reduce((sum, image) => sum + image.data.length, 0);
  let dropped = false;
  for (const image of added) {
    if (images.length >= CHAT_IMAGE_MAX_COUNT || total + image.data.length > CHAT_IMAGES_MAX_TOTAL_BASE64_LENGTH) {
      dropped = true;
      continue;
    }
    images.push(image);
    total += image.data.length;
  }
  return { images, notice: dropped ? tooMany : failed };
}
