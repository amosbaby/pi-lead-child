import { Box, Column, Icon, Row, Text } from '@pi-lead-child/components';
import { TOPIC_TURN_ERRORS, type TopicDto } from '@pi-lead-child/protocol';
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { ConversationDateDivider } from '@/features/chat/ConversationDateDivider';
import { ConversationMessage } from '@/features/chat/LeadConversation';
import { formatConversationDate, formatConversationTime } from '@/features/chat/conversationTime';
import type { ConversationScope } from '@/features/chat/conversationScope';
import { useLocale, useMessages, type Locale } from '@/i18n';
import { useControlPlaneStore } from '@/state/CompanionStateProvider';
import { useLeadName, useTurn } from '@/state/hooks';

import { topicsMessages } from './topics.messages';

// The conversation of a topic (design rules P18, theme 11.26). It reads the same message entities as the main
// conversation, from the topic's own session in the store, and draws each one with the main conversation's own
// message component: your message, its images and files, Lead's reply with the tool summary, a failure.
// A block is one message; the first message of a day has a date line above it.
export type TopicConversationBlock = { key: string; messageId: string; divider: string | null };

export function topicConversationBlocks(
  messageIds: readonly string[], dates: readonly string[], now: Date, locale: Locale,
): TopicConversationBlock[] {
  let previousDay = '';
  return messageIds.map((messageId, index) => {
    const day = dates[index] ? formatConversationDate(dates[index]!, now, locale) : '';
    const divider = day && day !== previousDay ? day : null;
    if (day) previousDay = day;
    return { key: messageId, messageId, divider };
  });
}

export function useTopicConversationBlocks(messageIds: readonly string[], now?: Date): TopicConversationBlock[] {
  const locale = useLocale();
  const dates = useControlPlaneStore(useShallow((state) => messageIds.map((id) => state.messagesById[id]?.createdAt ?? '')));
  const at = now?.getTime();
  return useMemo(
    () => topicConversationBlocks(messageIds, dates, at === undefined ? new Date() : new Date(at), locale),
    [messageIds, dates, at, locale],
  );
}

// One message of a topic is the message component of the main conversation (ConversationMessage), with no cards.
// compact: the phone page. latest: the newest message from Lead (its avatar is the live one, theme F-5).
const NO_CARD_IDS: readonly string[] = [];
const NO_CARDS = {};
const NO_COLLAPSED: ReadonlySet<string> = new Set();

export function TopicConversationBlockView({ block, compact, latest }: {
  block: TopicConversationBlock;
  compact: boolean;
  latest: boolean;
}) {
  return (
    <Column gap="conversation-block">
      {block.divider ? <ConversationDateDivider label={block.divider} /> : null}
      <ConversationMessage
        messageId={block.messageId}
        compact={compact}
        latest={latest}
        cardIds={NO_CARD_IDS}
        cardsById={NO_CARDS}
        collapsedCardIds={NO_COLLAPSED}
        dispatchScopes={NO_CARDS}
        selectedTicketId={null}
      />
    </Column>
  );
}

// What differs from the main conversation for the messages of a topic (features/chat/conversationScope.ts): where
// "Send again" goes, and the wording of the topic's fixed errors. They come as codes (protocol's TOPIC_TURN_ERRORS);
// an error from the model comes as the provider wrote it and gets the same wording as in the main conversation.
export function useTopicConversationScope(send: ConversationScope['send']): ConversationScope {
  const m = useMessages(topicsMessages);
  const leadName = useLeadName();
  return useMemo(() => ({
    send,
    fixedFailure: (code) => {
      const model = `${TOPIC_TURN_ERRORS.modelUnavailable}: `;
      const details = code === TOPIC_TURN_ERRORS.emptyReply ? m.failedDetail.emptyReply(leadName)
        : code === TOPIC_TURN_ERRORS.restarted ? m.failedDetail.restarted
          : code === TOPIC_TURN_ERRORS.sessionUnavailable ? m.failedDetail.sessionUnavailable
            : code.startsWith(model) ? m.failedDetail.modelUnavailable(code.slice(model.length))
              : null;
      return details === null ? null : { headline: m.failed, details };
    },
  }), [leadName, m, send]);
}

// The text the topic started from (theme 11.26): above the first message, on a subtle surface. It names where the
// text is from. The words are the stored selection: the daemon checked that they are in that turn.
export function TopicOriginQuote({ topic }: { topic: TopicDto }) {
  const m = useMessages(topicsMessages);
  const locale = useLocale();
  const leadName = useLeadName();
  const origin = useTurn(topic.originTurnId ?? '');
  if (!topic.originQuote) return null;
  const who = topic.originRole === 'user' ? m.you : leadName;
  const time = origin ? formatConversationTime(origin.createdAt, undefined, locale) : '';
  return (
    <Box testID="topic-origin-quote" bg="surface-subtle" rounded="md" px="inset-x" py="inset-y">
      <Row gap="icon-label" items="flex-start">
        <Box pt={2}>{/* spacing-exempt: optical alignment of the icon with the first text line */}
          <Icon name="reply" size={14} color="text-secondary" />
        </Box>
        <Column flex={1} minW={0} gap="text-stack">
          <Text size="meta" tone="secondary">{m.fromMain(who, time).trim()}</Text>
          <Text size="secondary" tone="strong" numberOfLines={6}>{topic.originQuote}</Text>
        </Column>
      </Row>
    </Box>
  );
}
