import { Box, Button, Column, Dot, Row, Text } from '@pi-lead-child/components';
import type { RuleChangeConfirmationDto, RuleChangeDecision } from '@pi-lead-child/protocol';
import { useCallback, useEffect, useState } from 'react';

import { shortTime, standingOrderErrorText } from '@/features/settings/standingOrderModel';
import { waitedText } from '@/features/workspace/inboxModel';
import { useLocale, useMessages } from '@/i18n';
import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useConnectionPhase, useLeadName } from '@/state/hooks';

import { genuiMessages } from './genui.messages';

type RuleChangeText = ReturnType<typeof genuiMessages>['ruleChange'];

// 改规则被拦下以后的一次性确认卡（统一的消息事件 spec D10 的放行，工单 09）。Lead 把系统给的 user_action
// （confirm_rule_change）原样放进 UserAction，卡片只带确认号：要改什么、参数、为什么改、为什么被拦都从
// /v1/rule-changes/:id 读（docs/design P8.1、P8.3：卡的外壳和参数由系统画，Lead 写的原因原样显示）。
// 「确认这一次」「不改」走只有用户能按到的路由（approvals:respond）。确认以后 daemon 只执行卡上存下的那一个操作。
// 样子是审批模式（P9.2，主题 11.4）：头部是状态点和状态词、谁要做什么、等了多久；参数放在等宽字的框里；
// 原因和被拦的原因是左边一列宽 56 的标签加右边的值；操作组右对齐，只有「确认这一次」是主按钮。处理过以后操作组原地换成结果（P5.5）。

type StateLook = { dot: 'warning' | 'accent' | 'success' | 'danger' | 'text-faint'; tone: 'warning-dark' | 'accent' | 'success-dark' | 'danger-dark' | 'secondary' };

// 状态按主题的五类状态画（P7.1，主题 C-11 到 C-15）。
const STATE: Record<RuleChangeConfirmationDto['state'], StateLook> = {
  pending: { dot: 'warning', tone: 'warning-dark' },
  running: { dot: 'accent', tone: 'accent' },
  done: { dot: 'success', tone: 'success-dark' },
  failed: { dot: 'danger', tone: 'danger-dark' },
  declined: { dot: 'text-faint', tone: 'secondary' },
  expired: { dot: 'text-faint', tone: 'secondary' },
};

// 主题 11.4：后果一列标签宽 56。
const LABEL_WIDTH = 56;
// sm 按钮的高度（Button.shared.ts 的 SIZES.sm）。
const BUTTON_ROW_HEIGHT = 32;

function errorStatus(reason: unknown): number | undefined {
  return typeof reason === 'object' && reason !== null ? (reason as { status?: number }).status : undefined;
}

function settledText(confirmation: RuleChangeConfirmationDto, leadName: string, m: RuleChangeText): string | null {
  switch (confirmation.state) {
    case 'done':
    case 'failed':
      return confirmation.resultPreview;
    case 'declined':
      return m.declined;
    case 'expired':
      return m.expired(leadName);
    case 'running':
      return m.running;
    default:
      return null;
  }
}

const PENDING_POLL_MS = 10_000;
const RUNNING_POLL_MS = 2_000;

export function RuleChangeConfirmCard({ confirmation: id }: { confirmation: string }) {
  const runtime = useCompanionRuntime();
  // 连上 daemon 以后才读（刷新页面时设备可能还在重连）。
  const ready = useConnectionPhase() === 'ready';
  const m = useMessages(genuiMessages).ruleChange;
  const [value, setValue] = useState<RuleChangeConfirmationDto | null>(null);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((signal?: AbortSignal) => runtime.ruleChangeConfirmation(id, signal).then(
    (confirmation) => { if (!signal?.aborted) setValue(confirmation); },
    (reason: unknown) => {
      if (signal?.aborted) return;
      if (errorStatus(reason) === 404) setGone(true);
      else setError(standingOrderErrorText(reason));
    },
  ), [id, runtime]);

  useEffect(() => {
    if (!ready) return undefined;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, ready]);

  // 等你确认或者正在执行时隔一会儿再读：你可能在 Slack 自己的私信里点了按钮（工单 #72），卡要跟着变。
  const state = value?.state ?? null;
  useEffect(() => {
    if (!ready || (state !== 'pending' && state !== 'running')) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => { void load(controller.signal); }, state === 'pending' ? PENDING_POLL_MS : RUNNING_POLL_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [load, ready, state, value]);

  if (gone) return <Text testID={`surface-rule-change-${id}-gone`} size="secondary" tone="secondary">{m.gone}</Text>;
  if (!value) {
    return error ? <Text size="secondary" tone="danger-dark">{error}</Text> : <Text size="secondary" tone="secondary">{m.loading}</Text>;
  }
  return <RuleChangeConfirmView confirmation={value} onChange={setValue} reload={load} />;
}

function RuleChangeConfirmView({ confirmation, onChange, reload }: {
  confirmation: RuleChangeConfirmationDto;
  onChange: (next: RuleChangeConfirmationDto) => void;
  reload: () => Promise<void>;
}) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const locale = useLocale();
  const m = useMessages(genuiMessages).ruleChange;
  const [submitting, setSubmitting] = useState<RuleChangeDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = `surface-rule-change-${confirmation.id}`;
  const look = { ...STATE[confirmation.state], label: m.states[confirmation.state] };
  const pending = confirmation.state === 'pending';

  const decide = (decision: RuleChangeDecision) => {
    setSubmitting(decision);
    setError(null);
    runtime.resolveRuleChangeConfirmation(confirmation.id, decision)
      .then(onChange, (reason: unknown) => {
        setError(standingOrderErrorText(reason));
        // 已经处理过或者过期了（409）：重读一次，显示它现在的状态。
        void reload();
      })
      .finally(() => setSubmitting(null));
  };

  const facts = [
    ...(confirmation.name ? [{ label: m.target, value: confirmation.name }] : []),
    { label: m.reason, value: confirmation.reason },
    { label: m.blocked, value: confirmation.why },
  ];
  const settled = settledText(confirmation, leadName, m);
  return (
    <Column testID={id} gap="card-row">
      <Row items="center" gap="inline-item">
        <Row items="center" gap="icon-label" shrink={0}>
          <Dot color={look.dot} size={7} accessibilityLabel={look.label} />
          <Text testID={`${id}-state`} size="label" weight="semibold" tone={look.tone}>{look.label}</Text>
        </Row>
        <Text flex={1} minW={0} size="card-title" numberOfLines={1}>
          <Text size="card-title" weight="semibold">{leadName}</Text>
          {m.wants(confirmation.label)}
        </Text>
        {/* 时刻用等宽字，「等了多久」不用（P14.2）。 */}
        <Text size="meta" tone="secondary" mono={!pending} shrink={0}>
          {pending ? m.waited(waitedText(confirmation.createdAt, undefined, locale)) : shortTime(confirmation.resolvedAt ?? confirmation.expiresAt)}
        </Text>
      </Row>
      <Box testID={`${id}-params`} px="inset-x" py="inset-y" rounded="md" bg="surface-muted">
        <Column gap="text-stack">
          {/* 沙箱外跑的命令要整条看得见才能确认（run_on_host，2026-10-29）：不截成两行。命令最长 400 字，卡在出现时就是这个高度。 */}
          {confirmation.params.map((param) => (
            <Text key={param.name} size="code" mono numberOfLines={param.name === 'command' ? undefined : 2}>
              {`${param.name} = ${param.value}`}
            </Text>
          ))}
        </Column>
      </Box>
      <Column gap="text-stack">
        {facts.map((fact) => (
          <Row key={fact.label} items="baseline" gap="side-item">
            <Text w={LABEL_WIDTH} shrink={0} size="label" weight="semibold" tone="secondary">{fact.label}</Text>
            <Text flex={1} minW={0} size="body">{fact.value}</Text>
          </Row>
        ))}
      </Column>
      {/* 操作行和处理以后的结果行一样高：卡片原地换状态时不变高（P1.3）。minH 是 sm 按钮的高度（Button.shared.ts）。 */}
      <Row items="center" justify={pending ? 'flex-end' : 'flex-start'} gap="actions" minH={BUTTON_ROW_HEIGHT}>
        {pending ? (
          <>
            <Button
              testID={`${id}-decline`} label={submitting === 'decline' ? m.submitting : m.decline} variant="ghost" tone="neutral" size="sm"
              disabled={submitting !== null} onPress={() => decide('decline')}
            />
            <Button
              testID={`${id}-confirm`} label={submitting === 'confirm' ? m.confirming : m.confirm} size="sm"
              disabled={submitting !== null} onPress={() => decide('confirm')}
            />
          </>
        ) : (
          <Text
            testID={`${id}-result`} flex={1} minW={0} size="secondary" numberOfLines={1}
            tone={confirmation.state === 'failed' ? 'danger-dark' : 'secondary'}
          >
            {settled ?? ''}
          </Text>
        )}
      </Row>
      {error ? <Text testID={`${id}-error`} size="note" tone="danger-dark">{error}</Text> : null}
    </Column>
  );
}
