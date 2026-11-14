import { Box, Icon, ListGroup, Pressable, Row, Column, Text } from '@pi-lead-child/components';
import { ticketNeedsUserLabel } from '@pi-lead-child/protocol';

import { clockTimeLabel } from '@/features/tickets/timeLabels';
import { useLocale, useMessages } from '@/i18n';

import { projectDisplayName, ticketDisplayTitle, type Ticket } from './model';
import { ticketsPageMessages } from './ticketsPage.messages';

// 最近结束的工单最多列几张。更早的在工作台和工单详情里。
const RECENT_ENDED = 10;

type Group = 'waiting' | 'running' | 'ended';

// 工单页的三组（画板 FTickets）：等你、在执行、最近结束。一行高 60：状态标记，标题和「状态 · 工单 #N · 项目」，右边时间。
// 状态标记：等你是琥珀点，在执行是蓝点，结束是绿色勾；状态词用同一个色调（不只靠颜色：旁边有状态词，P13.3）。
export function TicketGroups({ items, onSelect }: { items: readonly Ticket[]; onSelect: (id: string) => void }) {
  const m = useMessages(ticketsPageMessages);
  const waiting = items.filter((ticket) => ticket.needsUser != null);
  const running = items.filter((ticket) => ticket.needsUser == null && ticket.turn === 'running');
  const ended = items
    .filter((ticket) => ticket.needsUser == null && ticket.turn === 'ended')
    .sort((left, right) => (right.stageChangedAt ?? '').localeCompare(left.stageChangedAt ?? ''))
    .slice(0, RECENT_ENDED);
  return (
    <Column testID="ticket-groups" gap="page-section">
      <Text testID="ticket-groups-summary" size="label" tone="secondary" px="section-label-x">{m.summary(waiting.length, running.length)}</Text>
      {waiting.length ? (
        <ListGroup testID="ticket-group-waiting" title={m.waiting} count={waiting.length} tone="warning">
          {waiting.map((ticket) => <TicketRow key={ticket.id} ticket={ticket} group="waiting" onPress={() => onSelect(ticket.id)} />)}
        </ListGroup>
      ) : null}
      {running.length ? (
        <ListGroup testID="ticket-group-running" title={m.running} count={running.length}>
          {running.map((ticket) => <TicketRow key={ticket.id} ticket={ticket} group="running" onPress={() => onSelect(ticket.id)} />)}
        </ListGroup>
      ) : null}
      {ended.length ? (
        <ListGroup testID="ticket-group-ended" title={m.recent}>
          {ended.map((ticket) => <TicketRow key={ticket.id} ticket={ticket} group="ended" onPress={() => onSelect(ticket.id)} />)}
        </ListGroup>
      ) : null}
      {!items.length ? <Text size="body" tone="secondary" px="section-label-x">{m.empty}</Text> : null}
    </Column>
  );
}

function TicketRow({ ticket, group, onPress }: { ticket: Ticket; group: Group; onPress: () => void }) {
  const locale = useLocale();
  const m = useMessages(ticketsPageMessages);
  const word = group === 'waiting' && ticket.needsUser ? ticketNeedsUserLabel(ticket.needsUser, locale) : ticket.statusLabel;
  const tone = group === 'waiting' ? 'warning-dark' : group === 'running' ? 'accent' : 'success-dark';
  const project = ticket.project ? projectDisplayName(ticket.project, locale) : null;
  return (
    <Pressable testID={`ticket-row-${ticket.id}`} onPress={onPress} feedback="highlight" px="row-x" py="row-y">
      <Row items="center" gap="side-item">
        {group === 'ended'
          ? <Icon name="check" size={12} color="success-dark" weight="bold" />
          : <Box w={7} h={7} rounded="full" bg={group === 'waiting' ? 'warning' : 'accent'} />}
        <Column flex={1} minW={0} gap="text-stack">
          <Text size="card-title" weight="semibold" numberOfLines={1}>{ticketDisplayTitle(ticket)}</Text>
          <Text size="label" tone="secondary" numberOfLines={1}>
            <Text size="label" tone={tone}>{word}</Text>
            {` · ${m.line(ticket.id, project)}`}
          </Text>
        </Column>
        {ticket.stageChangedAt ? <Text size="meta" mono tone="secondary">{shortWhen(ticket.stageChangedAt)}</Text> : null}
      </Row>
    </Pressable>
  );
}

// 今天的写钟点，更早的写月/日。
function shortWhen(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return clockTimeLabel(value);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}
