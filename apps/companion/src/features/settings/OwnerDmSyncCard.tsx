import { Card, Column, Switch, Text } from '@pi-lead-child/components';
import { useEffect, useState } from 'react';

import { useLocale } from '@/i18n';
import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useLeadName } from '@/state/hooks';

import { channelsMessages } from './channels.messages';
import { channelErrorText } from './channelSettingsModel';

/**
 * 「我不在看 App 时，把 Lead 的消息同步到我的 Slack 私信」开关（工单 #88，缺省关，改了马上生效）。读和改都走操作层的 owner_dm_sync
 * （和 Lead 的 list_actions、perform_action 同一个函数）：开着时能做的是 disable，关着时是 enable。
 */
export function OwnerDmSyncCard() {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const locale = useLocale();
  const m = channelsMessages(locale);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => runtime.listUiActions('owner_dm_sync', 'user').then((actions) => {
    const disable = actions.find((action) => action.id === 'disable');
    setEnabled(disable ? disable.available : null);
  });

  useEffect(() => {
    load().catch((reason: unknown) => setError(m.ownerDmSyncLoadFailed(channelErrorText(reason, leadName, locale))));
    // 只在打开设置页时读一次；改完以后由 change 重读。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime]);

  const change = (next: boolean) => {
    setPending(true);
    setError(null);
    runtime.performUiAction('owner_dm_sync', 'user', next ? 'enable' : 'disable', { input: {} })
      .then(load)
      .catch((reason: unknown) => setError(m.ownerDmSyncFailed(channelErrorText(reason, leadName, locale))))
      .finally(() => setPending(false));
  };

  return (
    <Card testID="owner-dm-sync" rounded="xl" p="page-card" gap="card-section">
      <Text size="card-title" weight="bold">{m.ownerDmSyncTitle}</Text>
      <Column gap="text-stack">
        {enabled !== null ? (
          <Switch
            testID="owner-dm-sync-switch"
            value={enabled}
            label={m.ownerDmSyncLabel(leadName)}
            disabled={pending}
            onValueChange={change}
          />
        ) : null}
        <Text size="secondary" tone="secondary">{m.ownerDmSyncDescription(leadName)}</Text>
        {error ? <Text testID="owner-dm-sync-error" size="note" tone="danger-dark">{error}</Text> : null}
      </Column>
    </Card>
  );
}
