import type { TicketOperationProjection } from '@pi-lead-child/protocol';

import { useMessages, type Locale } from '@/i18n';

import type { ConversationCardEntity } from '../../state/types';
import type { Ticket } from '../workspace/model';
import { EmbeddedTicketCard } from './EmbeddedTicketCard';
import { EndRow } from './EndRow';
import { ticketCardMessages } from './ticketCard.messages';

const MAX_VISIBLE_OPERATIONS = 16;
const MAX_COLLAPSED_OPERATIONS = 4;

type TicketExecutionConversationCard = ConversationCardEntity & { kind: 'ticket_execution' };

export type TicketExecutionViewModel = {
  ticketId: string;
  title: string;
  statusLabel: string | null;
  priorityLabel: string | null;
  project: string | null;
  operations: TicketOperationProjection[];
  operationsTruncated: boolean;
};

export function buildTicketExecutionViewModel(
  card: TicketExecutionConversationCard,
  ticket?: Ticket,
  locale: Locale = 'en',
): TicketExecutionViewModel {
  return {
    ticketId: String(card.ticketId),
    title: ticket?.title ?? ticketCardMessages(locale).ticketNumber(card.ticketId),
    statusLabel: ticket?.statusLabel ?? null,
    priorityLabel: ticket?.priorityLabel ?? null,
    project: ticket?.project ?? null,
    operations: boundTicketExecutionOperations(card.operations),
    operationsTruncated: card.operationsTruncated || card.operations.length > MAX_VISIBLE_OPERATIONS,
  };
}

// 会话里一轮 Lead 回复碰到的工单（方案 A）：只画紧凑的工单卡。这一轮做了哪些操作已经在消息头的工具摘要里，
// 卡片下面不再列操作（2026-10-15 用户决定：卡片要紧凑，不列英文工具名）。完整记录在工单线程里。
// 还没有工单摘要时（刚建好、列表还没刷新），卡片说操作自己的结果（fallback），不写「正在同步」一直等下去。
export function TicketExecutionCard({
  card,
  ticket,
  compact = false,
  onOpenTicket,
  fallback = null,
}: {
  card: TicketExecutionConversationCard;
  ticket?: Ticket;
  compact?: boolean;
  onOpenTicket: (ticketId: number) => void;
  fallback?: string | null;
}) {
  const m = useMessages(ticketCardMessages);
  if (!ticket) {
    // 还没取到是什么（刚建好、或者不在工单列表里，正在按编号取）：一行结束行，和会话里别的一行对齐；
    // 取到以后换成工单卡或者提醒卡（2026-11-15 用户截图：这里原来是一张写着「打开这张工单看看」的空卡片）。
    return (
      <EndRow
        testID={`open-ticket-${card.ticketId}`}
        label={m.openTicket(card.ticketId, fallback ?? m.openToSee)}
        icon="tickets"
        title={`#${card.ticketId}`}
        line={fallback ?? m.openToSee}
        onPress={() => onOpenTicket(card.ticketId)}
      />
    );
  }
  return <EmbeddedTicketCard compact={compact} onPress={() => onOpenTicket(card.ticketId)} ticket={ticket} />;
}

function boundTicketExecutionOperations(
  operations: readonly TicketOperationProjection[],
): TicketOperationProjection[] {
  if (operations.length <= MAX_VISIBLE_OPERATIONS) return [...operations];
  return [operations[0]!, ...operations.slice(-(MAX_VISIBLE_OPERATIONS - 1))];
}

export function selectTicketExecutionOperations(
  operations: readonly TicketOperationProjection[],
  showAll: boolean,
): TicketOperationProjection[] {
  if (showAll || operations.length <= MAX_COLLAPSED_OPERATIONS) return [...operations];
  return [operations[0]!, ...operations.slice(-(MAX_COLLAPSED_OPERATIONS - 1))];
}
