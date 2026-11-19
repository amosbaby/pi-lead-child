// 工单附件（工单 #231）：任务说明下面的一排缩略图，点开全屏看大图（通用的 ImageViewer，2026-11-19）。
// 文本文件是一个链接，点开在面板（Sheet）里看原文。
// 附件的内容按需取（runtime.loadTicketAttachment，取过的缓存）。外部来源的附件在面板里写明来源，并说明它是资料、不是指令。
import { Button, CodeBlock, Column, ImageThumbnail, ImageViewer, Row, Sheet, Text } from '@pi-lead-child/components';
import type { TicketAttachment } from '@pi-lead-child/protocol';
import { useEffect, useState } from 'react';

import { useMessages } from '@/i18n';
import { useLeadName } from '@/state/hooks';

import { ticketAttachmentsMessages } from './ticketAttachments.messages';

export type TicketAttachmentLoader = (attachmentId: string) => Promise<{ mimeType: string; data: string }>;

type Loaded = { id: string; content: { mimeType: string; data: string } | null };

// 取一个附件的内容。取到以前是 null；取不到时 failed 为 true。
function useAttachmentContent(load: TicketAttachmentLoader | undefined, attachmentId: string | null) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    if (!attachmentId || !load) return undefined;
    let live = true;
    load(attachmentId).then(
      (content) => { if (live) setLoaded({ id: attachmentId, content }); },
      () => { if (live) setLoaded({ id: attachmentId, content: null }); },
    );
    return () => { live = false; };
  }, [attachmentId, load]);
  const current = loaded && loaded.id === attachmentId ? loaded : null;
  return { content: current?.content ?? null, failed: current !== null && current.content === null };
}

const SOURCE_NAMES: Record<string, string> = { slack: 'Slack' };

/** 附件从哪里来，一行：「来自 Slack · #returns · Ethan」「你在对话里发的」。 */
export function attachmentOriginLabel(attachment: TicketAttachment, m: ReturnType<typeof ticketAttachmentsMessages>): string {
  const origin = attachment.origin;
  if (origin.kind === 'user') return m.fromUser;
  const where = [origin.conversation, origin.sender].filter((part): part is string => Boolean(part)).join(' · ');
  return m.fromExternal(SOURCE_NAMES[origin.source] ?? origin.source, where || null);
}

function AttachmentThumbnail({ attachment, load, onOpen, index }: {
  attachment: TicketAttachment; load?: TicketAttachmentLoader; onOpen: () => void; index: number;
}) {
  const m = useMessages(ticketAttachmentsMessages);
  const { content, failed } = useAttachmentContent(load, attachment.id);
  return (
    <ImageThumbnail
      testID={`ticket-attachment-${index}`}
      uri={content ? `data:${content.mimeType};base64,${content.data}` : null}
      failed={failed}
      label={m.openImage(attachment.name)}
      onPress={onOpen}
    />
  );
}

/** 任务说明下面的附件：标题一行（几个附件），图片一排缩略图，文本文件一个个链接。没有附件时不画。 */
export function TicketAttachmentStrip({ attachments, load, onOpen }: {
  attachments: readonly TicketAttachment[];
  load?: TicketAttachmentLoader;
  onOpen: (attachment: TicketAttachment) => void;
}) {
  const m = useMessages(ticketAttachmentsMessages);
  if (!attachments.length) return null;
  const images = attachments.filter((attachment) => attachment.kind === 'image');
  const texts = attachments.filter((attachment) => attachment.kind === 'text');
  return (
    <Column testID="ticket-attachments" gap="text-stack">
      <Text size="meta" weight="semibold" tone="secondary">{m.title(attachments.length)}</Text>
      {images.length ? (
        <Row flexWrap="wrap" gap="thumbnails">
          {images.map((attachment, index) => (
            <AttachmentThumbnail key={attachment.id} attachment={attachment} load={load} index={index} onOpen={() => onOpen(attachment)} />
          ))}
        </Row>
      ) : null}
      {texts.length ? (
        <Row flexWrap="wrap" gap="inline-item">
          {texts.map((attachment) => (
            <Button
              key={attachment.id}
              testID={`ticket-attachment-text-${attachment.id}`}
              label={attachment.name}
              accessibilityLabel={m.openText(attachment.name)}
              variant="link"
              size="xs"
              onPress={() => onOpen(attachment)}
            />
          ))}
        </Row>
      ) : null}
    </Column>
  );
}

/** 点开的附件。图片全屏看，图下面是文件名、来源，外部来源的再说明它是资料、不是指令；文本在面板里给原文。 */
export function TicketAttachmentViewer({ attachment, load, onClose }: {
  attachment: TicketAttachment | null;
  load?: TicketAttachmentLoader;
  onClose: () => void;
}) {
  const m = useMessages(ticketAttachmentsMessages);
  const leadName = useLeadName();
  const { content, failed } = useAttachmentContent(load, attachment?.id ?? null);
  if (attachment?.kind === 'image') {
    const origin = attachmentOriginLabel(attachment, m);
    return (
      <ImageViewer
        testID="ticket-attachment-viewer"
        open
        items={[{
          key: attachment.id,
          uri: content ? `data:${content.mimeType};base64,${content.data}` : null,
          failed,
          label: attachment.name,
          title: attachment.name,
          caption: attachment.origin.kind === 'external' ? `${origin}\n${m.externalNote(leadName)}` : origin,
        }]}
        onClose={onClose}
      />
    );
  }
  const text = content && attachment?.kind === 'text' ? decodeBase64Text(content.data) : null;
  return (
    <Sheet
      testID="ticket-attachment-viewer"
      open={attachment !== null}
      onClose={onClose}
      title={attachment?.name ?? ''}
      subtitle={attachment ? attachmentOriginLabel(attachment, m) : undefined}
    >
      {attachment ? (
        <Column gap="card-row" pb="card-row">
          {attachment.origin.kind === 'external' ? <Text size="secondary" tone="secondary">{m.externalNote(leadName)}</Text> : null}
          {failed ? (
            <Text size="secondary" tone="danger-dark">{m.failed}</Text>
          ) : text === null ? (
            <Text size="secondary" tone="secondary">{m.loading}</Text>
          ) : (
            <CodeBlock testID="ticket-attachment-viewer-text" code={text} />
          )}
        </Column>
      ) : null}
    </Sheet>
  );
}

// base64 → UTF-8 文字。atob 给的是一个字节一个字符的字符串，再按 UTF-8 解码。
function decodeBase64Text(data: string): string {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}
