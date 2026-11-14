import { Button, Column, KeyboardArea, Screen, Text } from '@pi-lead-child/components';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { ConnectedTicketThread } from '@/features/tickets/ConnectedTicketThread';
import { ticketThreadMessages } from '@/features/tickets/ticketThread.messages';
import { resolveWorkspaceTicket } from '@/features/workspace/model';
import { useLocale, useMessages } from '@/i18n';
import { useConnectionPhase, useTickets, useWorkItems } from '@/state/hooks';

export default function TicketDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const phase = useConnectionPhase();
  const tickets = useTickets();
  const { items: workItems } = useWorkItems();
  const locale = useLocale();
  const m = useMessages(ticketThreadMessages).page;
  const ticket = resolveWorkspaceTicket(phase === 'ready', tickets, id ?? null, workItems, locale);
  const loading = phase === 'loading' || phase === 'connecting';
  return (
    <Screen edges={['top', 'bottom']}>
      {/* 工单对话的输入框在底部：键盘弹出时整页顶上去（2026-11-12）。 */}
      <KeyboardArea>
      {ticket ? (
        <ConnectedTicketThread
          ticket={ticket}
          standalone
          onClose={() => router.back()}
          onOpenTicket={(ticketId) => router.push({ pathname: '/ticket/[id]', params: { id: String(ticketId) } })}
        />
      ) : loading ? (
        <Column flex={1} items="center" justify="center" px="page-x">
          <Text size="secondary" tone="muted" align="center">{m.loading}</Text>
        </Column>
      ) : (
        <Column flex={1} items="center" justify="center" px="page-x">
          <Column w="100%" maxW={420} p="card" items="center" gap="card-row">
            <Text size="section-title" weight="extrabold" align="center">{m.notFound(id ?? null)}</Text>
            <Text size="secondary" tone="muted" align="center">{m.notFoundBody}</Text>
            <Button testID="ticket-not-found-back" label={m.back} onPress={() => router.back()} />
          </Column>
        </Column>
      )}
      </KeyboardArea>
    </Screen>
  );
}
