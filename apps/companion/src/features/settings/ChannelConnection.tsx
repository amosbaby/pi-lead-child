import { Button, Card, ChoiceGroup, Column, Row, Switch, Text } from '@pi-lead-child/components';
import type { ChannelConnectionDto, ChannelSourceSettingsDto } from '@pi-lead-child/protocol';
import { useCallback, useEffect, useState } from 'react';

import { useLocale } from '@/i18n';
import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useLeadName } from '@/state/hooks';

import { channelsMessages } from './channels.messages';
import { channelErrorText } from './channelSettingsModel';

// 设置 → 消息通道里一个来源的连接方式（2026-11-02 视觉稿，.scratch/slack-session 规格 5.7、工单 06）。
// 只有有几种连接方式的来源才有这一块（GET …/connection 回 404 时不画）。改动都走操作层（channel_connection），
// 和 Lead 的 perform_action 是同一个函数；登录和打开「代你发消息」只有你本人能做。
//   - 选一种要登录的方式：不马上换，风险说明在原地展开（P5.3），点「接受风险并登录」才打开登录窗口。
//   - 等你登录：按钮写「正在等你登录…」并停用（P5.4），写剩余时间，可以取消。每 2 秒读一次结果。
//   - 选一种不用登录的方式（换回 Slack 应用）：马上换，来源重连。
//   - 现在的方式有「代你往来源里写」开关时，画一行开关（缺省关，改了马上生效）。
// 来源连上、断开、出错时网关推 snapshot.required，source 跟着换，这里再读一次。

const POLL_MS = 2_000;

export type ChannelConnectionView = {
  connection: ChannelConnectionDto | null;
  // 选了一种要登录、还没有换过去的方式（风险说明展开着）。
  picked: string | null;
  setPicked: (mode: string | null) => void;
  reload: () => void;
};

/** 读一个来源的连接方式，并在等登录时每 2 秒再读一次。source 变了（网关推了新的状态）也再读。 */
export function useChannelConnection(source: ChannelSourceSettingsDto): ChannelConnectionView {
  const runtime = useCompanionRuntime();
  const [connection, setConnection] = useState<ChannelConnectionDto | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    runtime.channelConnection(source.source, controller.signal)
      .then((dto) => {
        setConnection(dto);
        // 登录成功、换过去了：风险说明收起来。
        if (dto.signIn?.state === 'done' && picked === dto.mode) setPicked(null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setConnection(null);
      });
    return () => controller.abort();
    // picked 只在读到结果时用来收起风险说明，变了不用再读。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, source, version]);
  const waiting = connection?.signIn?.state === 'waiting';
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, reload]);
  return { connection, picked, setPicked, reload };
}

function remaining(expiresAt: string | null, now: number): string {
  if (!expiresAt) return '';
  const seconds = Math.max(Math.round((Date.parse(expiresAt) - now) / 1000), 0);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function ChannelConnectionBlock({ source, view }: { source: ChannelSourceSettingsDto; view: ChannelConnectionView }) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const locale = useLocale();
  const m = channelsMessages(locale);
  const { connection, picked, setPicked, reload } = view;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const signIn = connection?.signIn ?? null;
  const waiting = signIn?.state === 'waiting';
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [waiting]);
  if (!connection || !source.editable) return null;
  const id = source.source;
  const name = (mode: string) => m.modeName(id, mode);
  const act = (action: string, input: Record<string, unknown> = {}) => {
    setPending(true);
    setError(null);
    runtime.performUiAction('channel_connection', id, action, { input })
      .then(reload)
      .catch((reason: unknown) => setError(m.connectionFailed(channelErrorText(reason, leadName, locale))))
      .finally(() => setPending(false));
  };
  const select = (mode: string) => {
    setError(null);
    if (mode === connection.mode) {
      setPicked(null);
      return;
    }
    const target = connection.modes.find((item) => item.mode === mode);
    if (target?.needsSignIn) setPicked(mode);
    else act('use_mode', { mode });
  };
  // 等登录时选中的是正在登录的那一种；选了还没登录时是选的那一种。
  // 不写 signIn!：React Compiler 会把它提到条件外面，signIn 是 null 时网页上崩掉（vitest 不编译它）。
  const waitingMode = waiting && signIn ? signIn.mode : null;
  const expiresAt = waiting && signIn ? signIn.expiresAt : null;
  const shown = waitingMode ?? picked ?? connection.mode;
  const pendingMode = waitingMode ?? picked;
  const result = signIn && signIn.state !== 'waiting' && signIn.state !== 'done' && signIn.code && pendingMode === signIn.mode
    ? { text: m.signInResult[signIn.code], error: signIn.state === 'failed' }
    : null;

  return (
    <Column testID={`channel-${id}-connection`} gap="card-row">
      <Text size="label" weight="semibold" tone="secondary">{m.connectionTitle}</Text>
      <ChoiceGroup
        variant="radio"
        value={shown}
        recommended={connection.modes[0]?.mode}
        accessibilityLabel={m.connectionTitle}
        disabled={pending || waiting}
        onSelect={select}
        testID={`channel-${id}-connection-modes`}
        optionTestID={(mode) => `channel-${id}-connection-mode-${mode}`}
        options={connection.modes.map((item) => ({
          id: item.mode,
          label: name(item.mode),
          description: m.modeDescription(id, item.mode),
          ...(item.mode === pendingMode ? { aside: m.notActive } : {}),
        }))}
      />

      {picked && !waiting ? (
        <Column testID={`channel-${id}-connection-risks`} gap="card-row">
          <Text size="secondary" tone="strong">{m.switchNote}</Text>
          <Card tone="subtle" rounded="lg" px="inset-x" py="inset-y" gap="stacked-card">
            <Text size="label" weight="semibold" tone="warning-dark">{m.riskTitle}</Text>
            {(['api', 'power', 'breaks', 'label'] as const).map((key, index) => (
              <Row key={key} items="flex-start" gap="inline-item">
                {/* spacing-exempt: 序号列宽 */}
                <Text w={14} size="meta" mono tone="secondary">{index + 1}</Text>
                <Text flex={1} minW={0} size="secondary" tone="strong">{m.risks[key]}</Text>
              </Row>
            ))}
          </Card>
          <Row items="center" gap="actions" flexWrap="wrap">
            <Button
              testID={`channel-${id}-connection-sign-in`}
              label={m.acceptAndSignIn}
              size="sm"
              disabled={pending}
              onPress={() => act('sign_in', { mode: picked })}
            />
            <Button label={m.cancel} variant="ghost" tone="neutral" size="sm" disabled={pending} onPress={() => setPicked(null)} />
          </Row>
        </Column>
      ) : null}

      {waiting ? (
        <Column testID={`channel-${id}-connection-waiting`} gap="card-row">
          <Text size="secondary" tone="strong">{m.waiting}</Text>
          <Text size="meta" tone="secondary">{m.timeLeft(remaining(expiresAt, now))}</Text>
          <Row items="center" gap="actions" flexWrap="wrap">
            <Button label={m.waitingButton} size="sm" disabled onPress={() => {}} />
            <Button
              testID={`channel-${id}-connection-cancel`}
              label={m.cancel}
              variant="ghost"
              tone="neutral"
              size="sm"
              disabled={pending}
              onPress={() => act('cancel_sign_in')}
            />
          </Row>
        </Column>
      ) : null}

      {result ? (
        <Text testID={`channel-${id}-connection-result`} size="note" tone={result.error ? 'danger-dark' : 'secondary'}>{result.text}</Text>
      ) : null}

      {error ? <Text testID={`channel-${id}-connection-error`} size="note" tone="danger-dark">{error}</Text> : null}
    </Column>
  );
}

/**
 * 「代你往来源里写」开关（缺省关，改了马上生效）。只在现在的方式有这个开关时画；视觉稿里它在会话那几行下面，
 * 上面一条细线，下面是会话的按钮。
 */
export function ChannelWritesSwitch({ source, view }: { source: ChannelSourceSettingsDto; view: ChannelConnectionView }) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const locale = useLocale();
  const m = channelsMessages(locale);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const writes = view.connection?.writes ?? null;
  if (writes === null) return null;
  const id = source.source;
  const change = (next: boolean) => {
    setPending(true);
    setError(null);
    runtime.performUiAction('channel_connection', id, next ? 'allow_writes' : 'block_writes', { input: {} })
      .then(view.reload)
      .catch((reason: unknown) => setError(m.connectionFailed(channelErrorText(reason, leadName, locale))))
      .finally(() => setPending(false));
  };
  return (
    <Column testID={`channel-${id}-connection-writes`} gap="text-stack" pt="card-row" borderTopWidth={1} borderTopColor="border-soft">
      <Switch
        testID={`channel-${id}-connection-writes-switch`}
        value={writes}
        label={m.writesLabel(leadName)}
        disabled={pending}
        onValueChange={change}
      />
      <Text size="secondary" tone="secondary">{m.writesDescription(leadName)}</Text>
      {error ? <Text size="note" tone="danger-dark">{error}</Text> : null}
    </Column>
  );
}
