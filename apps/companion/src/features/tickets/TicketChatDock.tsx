import { Box, Button, ChatDock, ChatList, Column, ConversationColumn, Dot, Row, Spinner, Text } from '@pi-lead-child/components';
import type { TicketChatResume, TicketReplyActionId } from '@pi-lead-child/protocol';
import { useCallback, useEffect, useMemo, type ReactNode } from 'react';

import { formatConversationTime, latestSentMessageKey } from '@/features/chat/LeadConversation';
import { presentTurnFailure } from '@/features/chat/failurePresentation';
import { MessageComposer } from '@/features/chat/MessageComposer';
import { useControlPlaneStore } from '@/state/CompanionStateProvider';
import { useLocale, useMessages } from '@/i18n';
import { useLeadName, useMessage, useMessagePart, useMessageParts, useTurn } from '@/state/hooks';

import { replyActionButtons } from './replyActions';
import {
  TicketConversationBlockView, ticketConversationSenderLabel, useTicketConversationBlocks, type TicketConversationBlock,
} from './TicketConversation';
import { ticketChatMessages } from './ticketChat.messages';
import {
  elapsedText, ticketChatDestination, type TicketActionReceipt, type TicketRunProgress,
} from './ticketChatStatus';
/** 回复可能在问的一个动作（daemon 的快模型判断的 replyActions），对应页面上同一个工单操作。 */
export type TicketChatAction = {
  id: TicketReplyActionId;
  label: string;
  tone: 'primary' | 'neutral' | 'danger';
  recommended: boolean;
  disabled: boolean;
};

export type TicketChatDockProps = {
  ticketId: number;
  ticketDisplayId: string;
  messageIds: readonly string[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** 你已经看过的最后一条消息。之后来的 agent 回复算新回复。 */
  seenMessageId: string | null;
  onSeen: (messageId: string) => void;
  /** 你在这张工单上做的最近一个动作（回执）。 */
  receipt: TicketActionReceipt | null;
  /** 正在跑的那次 Run（实时进度）。 */
  liveRun: TicketRunProgress | null;
  /** 回答工单对话的 agent，例如 Claude Code。 */
  agentName: string | null;
  /** 这张工单的 runtime（codex、claude、pi）：决定在跑的 Run 能不能中途接收消息。 */
  runtimeName?: string | null;
  /** 没有 Run 在跑时，消息续接的会话（工单 08）。没有可续接的会话时为 null。输入框据此写预估成本。 */
  chatResume?: TicketChatResume | null;
  /** 没连上时没有：输入框禁用。 */
  onSendMessage?: (message: string) => void;
  /** 工单现在能做的动作。最后一条回复在问其中几个时（daemon 的快模型判断），回复下面给按钮（复核 P1-9）。 */
  actions?: readonly TicketChatAction[];
  /** 和底部操作栏走同一个入口。 */
  onAction?: (id: TicketReplyActionId) => void;
  /** 对话坞上面的底部操作栏（ActionBar），和对话坞共用一个外框（第四轮画板）。 */
  bar?: ReactNode;
  /** 输入框的草稿被外面改过（例如「拆成子工单」预填了一句话）：换一个值，输入框重新读草稿。 */
  composerRevision?: number;
};

// 工单详情底部的对话坞（方案 D）。收起时露出最新一条（对话、或你刚做的动作）、正在跑的 Run 和输入框；
// 展开时对话占满工单面板，贴着底部跟随新消息。输入框一直在，手机上也在。
export function TicketChatDock({
  ticketId,
  ticketDisplayId,
  messageIds,
  expanded,
  onExpandedChange,
  seenMessageId,
  onSeen,
  receipt,
  liveRun,
  runtimeName = null,
  chatResume = null,
  onSendMessage,
  actions = [],
  onAction,
  bar,
  composerRevision = 0,
}: TicketChatDockProps) {
  const locale = useLocale();
  const m = useMessages(ticketChatMessages);
  const lastId = messageIds[messageIds.length - 1] ?? null;
  const lastMessage = useMessage(lastId ?? '');
  const lastTurn = useTurn(lastMessage?.turnId ?? '');
  // 消息交给这张工单的 agent（2026-10-19）：说明写现在是谁在跑、消息会去哪里；续接已结束的会话时写预估成本。
  const destination = ticketChatDestination({ ticketDisplayId, liveRun, runtimeName, resume: chatResume, locale });
  // 回复下面的按钮：最后一条是 agent 答完的回复，你在它之后还没做过动作；按钮是快模型说它在问的动作 ∩ 工单现在能做的动作。
  const answered = lastMessage?.role === 'assistant' && lastMessage.state !== 'streaming' && !lastMessage.failure
    && !(receipt && receipt.createdAt > lastMessage.createdAt);
  const replyButtons = onAction && answered ? replyActionButtons(lastTurn?.replyActions, actions) : [];
  const replyActionRow = onAction && replyButtons.length > 0
    ? <ReplyActionRow actions={replyButtons} onAction={onAction} />
    : null;
  // 第一次打开这张工单时，已有的消息都算看过；之后来的 agent 回复才是新回复。展开着时随看随记。
  useEffect(() => {
    if (lastId === null) return;
    if (seenMessageId === null || expanded) onSeen(lastId);
  }, [expanded, lastId, onSeen, seenMessageId]);
  const unread = !expanded && lastId !== null && seenMessageId !== null && lastId !== seenMessageId
    && lastMessage?.role === 'assistant' && lastMessage.state !== 'streaming';

  const send = onSendMessage
    ? (message: string) => {
        onSendMessage(message);
        // 发出去以后展开：你要看到自己的消息和回答。
        onExpandedChange(true);
      }
    : undefined;

  return (
    <ChatDock
      testID="ticket-chat-dock"
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      title={m.title}
      count={messageIds.length > 0 ? String(messageIds.length) : undefined}
      unread={unread}
      unreadLabel={m.newReply}
      bar={bar}
      preview={(
        // 收着时只有一行最后的回复（主题 11.21 T-13，画板 M3Wait）。Run 的状态在属性表和执行详情里；只有 Run 可能卡住时才在这里提醒。
        <Column gap="card-row">
          <DockPreview ticketId={ticketId} lastId={lastId} receipt={receipt} />
          {liveRun?.stalled ? <LiveRunRow progress={liveRun} /> : null}
        </Column>
      )}
      composer={(
        // 和对话同一个内容列（2026-10-16）：同样 16 的留白、最宽 700、居中，输入框和上面的对话对齐。
        // spacing-exempt: 对话坞自己的规格
        <Column px="page-x" pt={8} pb={10}>
          <ConversationColumn testID="ticket-chat-composer-column" gap="field">
          {/* 收起时按钮放在预览下面。预览本身可以点开，按钮不能放进它里面。 */}
          {/* spacing-exempt: 光学对齐 */}
          {!expanded && replyActionRow ? <Column pb={2}>{replyActionRow}</Column> : null}
          {/* 收着时一行小字说消息会去哪里（主题 T-13，2026-10-15 用户定的），续接时带上预估成本；展开以后写完整的说明。 */}
          {!expanded ? (
            <Text testID="ticket-chat-brief" size="note" tone={destination.cost ? 'warning-dark' : 'secondary'} numberOfLines={1}>
              {destination.brief}
            </Text>
          ) : null}
          {expanded ? (
            <Column gap="text-stack">
              <Text testID="ticket-chat-identity" size="note" tone="secondary" numberOfLines={1}>
                {destination.hint}
              </Text>
              {destination.cost ? (
                <Text testID="ticket-chat-cost" size="note" weight="semibold" tone="warning-dark" numberOfLines={1}>
                  {destination.cost}
                </Text>
              ) : null}
            </Column>
          ) : null}
          <MessageComposer
            key={composerRevision}
            contextKey={`ticket:${ticketId}`}
            placeholder={send ? destination.placeholder : m.connectToSend}
            compact
            minimal
            disabled={!send}
            onSend={(message) => send?.(message)}
          />
          </ConversationColumn>
        </Column>
      )}
    >
      <ExpandedConversation
        ticketId={ticketId}
        messageIds={messageIds}
        liveRun={liveRun}
        onResend={send}
        replyFooter={replyActionRow}
      />
    </ChatDock>
  );
}

// 收起时的预览：最新的一件事。你刚做的动作比最后一条消息新时，先说你的动作。
function DockPreview({ ticketId, lastId, receipt }: { ticketId: number; lastId: string | null; receipt: TicketActionReceipt | null }) {
  const message = useMessage(lastId ?? '');
  const turn = useTurn(message?.turnId ?? '');
  const textPart = useMessagePart(lastId ? `${lastId}:text` : '');
  const parts = useMessageParts(lastId ?? '');
  const userPart = useMessagePart(turn ? `${turn.userMessageId}:text` : '');
  const leadName = useLeadName();
  const locale = useLocale();
  const m = useMessages(ticketChatMessages);
  const clock = (value: string) => formatConversationTime(value, undefined, locale);
  if (receipt && (!message || receipt.createdAt > message.createdAt)) {
    return (
      <Row testID="ticket-chat-receipt" items="center" gap="icon-label">
        <Dot color="accent" size={7} />
        <Text flex={1} minW={0} size="card-title" weight="bold" numberOfLines={1}>{receipt.title}</Text>
        <Text size="meta" mono tone="secondary">{clock(receipt.createdAt)}</Text>
      </Row>
    );
  }
  if (!message) {
    return <Text size="secondary" tone="secondary" numberOfLines={1}>{m.emptyShort}</Text>;
  }
  const user = message.role === 'user';
  const who = user ? m.you : ticketConversationSenderLabel(turn?.originKind, leadName, locale);
  // queued：在跑的 Run 不能中途接收消息，消息排着队，Run 结束后转交（2026-10-15）。
  const when = message.state === 'streaming' ? m.answering : message.state === 'queued' ? m.queued : clock(message.updatedAt);
  const text = textPart?.kind === 'text' ? plainPreview(textPart.text) : '';
  // 失败时和展开后的失败行用同一条规则（failurePresentation）：agent 调过工具时工单可能变了，也不给「重发」。
  const failure = message.failure ? presentTurnFailure({
    locale,
    failure: message.failure,
    originKind: turn?.originKind,
    ticketId,
    userText: userPart?.kind === 'text' ? userPart.text : null,
    lead: undefined,
    clock,
    tools: parts.flatMap((part) => part.kind === 'tool' ? [part] : []),
  }) : null;
  const body = failure
    ? failure.actions.includes('resend') ? m.noAnswerResend : failure.headline
    : text || (message.state === 'streaming' ? m.answeringNow : m.noText);
  return (
    // 一行：谁、说了什么、什么时候（T-13，行高 40）。
    <Row testID="ticket-chat-preview" items="center" gap="icon-label" minH={40}>
      <Text size="meta" weight="semibold" tone="secondary" numberOfLines={1}>{who}</Text>
      <Text flex={1} minW={0} size="body" tone={message.failure ? 'danger-dark' : 'default'} numberOfLines={1}>{body}</Text>
      <Text size="meta" mono tone="muted" numberOfLines={1}>{when}</Text>
    </Row>
  );
}

// 正在跑的那次 Run。准备超过一分钟还没开始，就说它可能卡住了（#66 的核查 Run #73）。
function LiveRunRow({ progress }: { progress: TicketRunProgress }) {
  const locale = useLocale();
  const m = useMessages(ticketChatMessages);
  return (
    <Row
      testID="ticket-chat-live-run"
      items="center"
      gap="side-item"
      px="banner-x"
      py="banner-y"
      rounded="md"
      borderWidth={1}
      borderColor={progress.stalled ? 'warning-line' : 'border-soft'}
      borderLeftWidth={3}
      borderLeftColor={progress.stalled ? 'warning' : 'accent'}
      bg="surface"
    >
      <Spinner size={12} color="accent" />
      <Column flex={1} minW={0} gap="text-stack">
        <Text size="card-title" weight="bold" numberOfLines={1}>{progress.label}</Text>
        {progress.stalled ? (
          <Text size="secondary" tone="warning-dark">{m.stalled}</Text>
        ) : null}
      </Column>
      <Text size="meta" mono tone="secondary">{elapsedText(progress.elapsedMs, locale)}</Text>
    </Row>
  );
}

// 展开后的对话（ChatList，2026-11-04 换成 Legend List）：打开或切换工单时落在最底下；贴底时跟随新消息和流式输出；
// 你往上翻时不拽回来，只给「新消息 ↓」；你发了消息就回到底部。换一张工单就是一个新列表（key）。一条消息一块。
function ExpandedConversation({
  ticketId,
  messageIds,
  liveRun,
  onResend,
  replyFooter,
}: {
  ticketId: number;
  messageIds: readonly string[];
  liveRun: TicketRunProgress | null;
  onResend?: (text: string) => void;
  /** 最后一条回复下面的按钮。 */
  replyFooter: ReactNode;
}) {
  const m = useMessages(ticketChatMessages);
  // 你在这台设备上发的最后一条消息。它变了，说明你刚发了消息（和主会话同一个规则，latestSentMessageKey）。
  const lastUserMessageId = useControlPlaneStore((state) => latestSentMessageKey(
    messageIds.flatMap((id) => state.messagesById[id] ? [state.messagesById[id]!] : []),
  ));
  const blocks = useTicketConversationBlocks(messageIds);
  const blockContext = useMemo(() => ({ ticketId, onResend }), [onResend, ticketId]);
  // 和主会话同一个规则（2026-10-16）：面板窄时占满减 16 的留白；宽时（手机和平板上全屏打开）最宽 700、居中。
  const renderBlock = useCallback((block: TicketConversationBlock) => (
    <Box px="page-x">
      <ConversationColumn testID="ticket-chat-column">
        <TicketConversationBlockView ticketId={blockContext.ticketId} block={block} onResend={blockContext.onResend} />
      </ConversationColumn>
    </Box>
  ), [blockContext]);
  const tail = replyFooter || liveRun;
  return (
    <ChatList
      key={ticketId}
      testID="ticket-chat-scroll"
      data={blocks}
      keyExtractor={ticketBlockKey}
      renderItem={renderBlock}
      extraData={blockContext}
      followKey={lastUserMessageId}
      // spacing-exempt: 对话坞自己的规格
      header={<Box pt={8} />}
      footer={(
        // spacing-exempt: 对话坞自己的规格
        <Box px="page-x" pb={14}>
          {tail ? (
            <Box pt={messageIds.length ? 'conversation-block' : 0}>
              <ConversationColumn testID="ticket-chat-tail" gap="conversation-block">
                {replyFooter}
                {liveRun ? <LiveRunRow progress={liveRun} /> : null}
              </ConversationColumn>
            </Box>
          ) : null}
        </Box>
      )}
      empty={(
        <Box px="page-x">
          <ConversationColumn testID="ticket-chat-column">
            <Text size="secondary" tone="secondary" align="center">{m.empty}</Text>
          </ConversationColumn>
        </Box>
      )}
    />
  );
}

const ticketBlockKey = (block: TicketConversationBlock) => block.key;

// 回复问到的动作。推荐的那个用强调色，有风险的用红色，和决策卡一致。
function ReplyActionRow({ actions, onAction }: { actions: readonly TicketChatAction[]; onAction: (id: TicketReplyActionId) => void }) {
  return (
    <Row testID="ticket-chat-actions" flexWrap="wrap" gap="actions">
      {actions.map((action) => (
        <Button
          key={action.id}
          label={action.label}
          onPress={() => onAction(action.id)}
          disabled={action.disabled}
          testID={`ticket-chat-action-${action.id}`}
          variant="outline"
          tone={action.tone === 'danger' ? 'danger' : action.recommended ? 'accent' : 'neutral'}
          size="xs"
        />
      ))}
    </Row>
  );
}

// 预览只放两行纯文字：去掉 Markdown 的标记，把换行压成空格。
function plainPreview(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
    .replace(/^\s*(?:[-*•]|\d+\.)\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
