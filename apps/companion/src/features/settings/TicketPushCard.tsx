import { Card, Column, Switch, Text } from '@pi-lead-child/components';
import { useEffect, useState } from 'react';

import { useLocale } from '@/i18n';
import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useLeadName } from '@/state/hooks';

import { channelsMessages } from './channels.messages';
import { channelErrorText } from './channelSettingsModel';

type PushChannel = 'slack_dm' | 'desktop';
const CHANNELS: readonly PushChannel[] = ['slack_dm', 'desktop'];

/**
 * 「待你处理推送」的两个开关（计划 Task 12，缺省都开，改了马上生效）：推到 Slack 私信（slack_dm）、弹桌面通知（desktop）。
 * 和 OwnerDmSyncCard 同一个样子。读和改都走操作层的 ticket_push（和 Lead 的 list_actions、perform_action 同一个函数）：
 * 开着时能做的是 disable，关着时是 enable。
 */
export function TicketPushCard() {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const locale = useLocale();
  const m = channelsMessages(locale);
  const [enabled, setEnabled] = useState<Record<PushChannel, boolean | null>>({ slack_dm: null, desktop: null });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = (channel: PushChannel) => runtime.listUiActions('ticket_push', channel).then((actions) => {
    const disable = actions.find((action) => action.id === 'disable');
    setEnabled((current) => ({ ...current, [channel]: disable ? disable.available : null }));
  });

  useEffect(() => {
    Promise.all(CHANNELS.map(load))
      .catch((reason: unknown) => setError(m.ticketPushLoadFailed(channelErrorText(reason, leadName, locale))));
    // 只在打开设置页时读一次；改完以后由 change 重读。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime]);

  const change = (channel: PushChannel, next: boolean) => {
    setPending(true);
    setError(null);
    runtime.performUiAction('ticket_push', channel, next ? 'enable' : 'disable', { input: {} })
      .then(() => load(channel))
      .catch((reason: unknown) => setError(m.ticketPushFailed(channelErrorText(reason, leadName, locale))))
      .finally(() => setPending(false));
  };

  const labels: Record<PushChannel, string> = { slack_dm: m.ticketPushSlackLabel, desktop: m.ticketPushDesktopLabel };

  return (
    <Card testID="ticket-push" rounded="xl" p="page-card" gap="card-section">
      <Text size="card-title" weight="bold">{m.ticketPushTitle}</Text>
      <Column gap="text-stack">
        {CHANNELS.map((channel) => {
          const value = enabled[channel];
          return value !== null ? (
            <Switch
              key={channel}
              testID={`ticket-push-${channel}-switch`}
              value={value}
              label={labels[channel]}
              disabled={pending}
              onValueChange={(next: boolean) => change(channel, next)}
            />
          ) : null;
        })}
        <Text size="secondary" tone="secondary">{m.ticketPushDescription(leadName)}</Text>
        {error ? <Text testID="ticket-push-error" size="note" tone="danger-dark">{error}</Text> : null}
      </Column>
    </Card>
  );
}
