import { useRouter } from 'expo-router';

import { SecondaryScreen } from '@/components/SecondaryScreen';
import { AgendaPage } from '@/features/workspace/AgendaPage';
import { agendaPageMessages } from '@/features/workspace/agendaPage.messages';
import { useMessages } from '@/i18n';
import { navigationMessages } from '@/navigation/navigation.messages';
import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useConnectionPhase, useLeadName, useTimeline } from '@/state/hooks';

// 日程页（主题 11.20，画板 FAgenda，2026-11-14 方案 F）。
export default function AgendaScreen() {
  const router = useRouter();
  const runtime = useCompanionRuntime();
  const phase = useConnectionPhase();
  const timeline = useTimeline();
  const leadName = useLeadName();
  const nav = useMessages(navigationMessages);
  const m = useMessages(agendaPageMessages);
  return (
    <SecondaryScreen testID="agenda" title={nav.agenda} composerPlaceholder={m.composer(leadName)}>
      <AgendaPage
        timeline={phase === 'ready' ? timeline : null}
        onOpenTicket={(ticketId) => router.push(`/ticket/${ticketId}`)}
        onToggleReminder={async (entryId, muted) => { await runtime.performUiAction('agenda_entry', String(entryId), 'update', { input: { muted } }); }}
      />
    </SecondaryScreen>
  );
}
