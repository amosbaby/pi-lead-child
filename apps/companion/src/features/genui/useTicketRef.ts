import { ticketNeedsUser } from '@pi-lead-child/protocol';

import { useMessages } from '@/i18n';

import { useConversationItemDetail, useTicketSummary } from '../../state/hooks';
import { useOpenAgenda } from '../chat/useOpenAgenda';
import { useOpenTicket } from '../chat/useOpenTicket';
import { ticketDisplayTitle, ticketSummaryToTicket } from '../workspace/model';
import { genuiMessages } from './genui.messages';

// 卡片里按编号引用的工单（TicketRef、表格里的 { ticket } 格子）：标题和状态从 TicketSummary 实时读取。
// 状态标签和会话里的工单卡、顶栏用同一个 statusLabel；用户欠着决定时 needs 为 true。
// 不在工单列表里的事项（提醒、刚建好的工单）按编号取它的 TicketDetail。提醒点开日程，不打开工单详情。
export function useTicketRef(ticketId: number) {
  const m = useMessages(genuiMessages).ticketRef;
  const listed = useTicketSummary(ticketId);
  const { detail, resource } = useConversationItemDetail(ticketId, !listed);
  const summary = listed ?? detail?.ticket;
  const openTicket = useOpenTicket();
  const openAgenda = useOpenAgenda();
  const ticket = summary ? ticketSummaryToTicket(summary) : null;
  const reminder = summary?.kind === 'reminder';
  return {
    title: ticket ? ticketDisplayTitle(ticket) : resource?.state === 'error' ? m.loadFailed : m.loading,
    status: ticket?.statusLabel ?? null,
    needs: summary ? ticketNeedsUser(summary) : false,
    // 取不到这张工单（列表里没有，详情也读不到）。文字里的工单链接这时只显示文字（P14.8）。
    missing: !summary && resource?.state === 'error',
    label: reminder ? m.reminder(ticketId) : m.ticket(ticketId),
    open: () => (reminder ? openAgenda() : openTicket(ticketId)),
  };
}
