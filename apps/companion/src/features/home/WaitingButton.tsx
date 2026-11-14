import { FloatingButton } from '@pi-lead-child/components';
import { ticketsNeedingUser } from '@pi-lead-child/protocol';
import { useRouter } from 'expo-router';

import { useMessages } from '@/i18n';
import { useWorkspaceStore } from '@/state/CompanionStateProvider';
import { useTickets } from '@/state/hooks';

import { homeMessages } from './home.messages';
import { WaitingStackIcon } from './WaitingStackIcon';

// 「等你」的那一叠（主题 H-2）：首页和二级页面的右上角同一个。件数和角标、收件箱同一条规则（ticketNeedsUser）。
// 没有事等你时不显示。点了进入等你的工单。
export function WaitingButton() {
  const router = useRouter();
  const m = useMessages(homeMessages);
  const count = ticketsNeedingUser(useTickets()).length;
  const setTicketFilter = useWorkspaceStore((state) => state.setTicketFilter);
  if (count === 0) return null;
  return (
    <FloatingButton
      testID="home-waiting"
      label={m.waiting(count)}
      onPress={() => {
        setTicketFilter('todo');
        router.push('/tickets');
      }}
    >
      <WaitingStackIcon count={count} />
    </FloatingButton>
  );
}
