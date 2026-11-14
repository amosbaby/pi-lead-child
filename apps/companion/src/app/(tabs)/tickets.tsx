import { useRouter } from 'expo-router';

import { SecondaryScreen } from '@/components/SecondaryScreen';
import { TicketGroups } from '@/features/workspace/TicketGroups';
import { resolveWorkspaceTickets } from '@/features/workspace/model';
import { ticketsPageMessages } from '@/features/workspace/ticketsPage.messages';
import { useLocale, useMessages } from '@/i18n';
import { navigationMessages } from '@/navigation/navigation.messages';
import { useConnectionPhase, useLeadName, useTickets, useWorkItems } from '@/state/hooks';

// 工单页（主题 11.20，画板 FTickets，2026-11-14 方案 F）：顶栏左上角返回、标题居中；三组工单；底部一行发给 Lead 的输入框。
// 点一行进入工单详情（整页，从右边推入，P13.2d）。
export default function TicketsScreen() {
  const router = useRouter();
  const phase = useConnectionPhase();
  const leadName = useLeadName();
  const locale = useLocale();
  const nav = useMessages(navigationMessages);
  const m = useMessages(ticketsPageMessages);
  const tickets = useTickets();
  const { items: workItems } = useWorkItems();
  const items = resolveWorkspaceTickets(phase === 'ready', tickets, workItems, locale);
  return (
    <SecondaryScreen testID="tickets-page" title={nav.tickets} composerPlaceholder={m.composer(leadName)}>
      <TicketGroups items={items} onSelect={(id) => router.push(`/ticket/${id}`)} />
    </SecondaryScreen>
  );
}
