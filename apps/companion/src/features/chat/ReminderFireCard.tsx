import { Badge, Box, Button, Card, Column, Icon, Row, SystemLine, Text } from '@pi-lead-child/components';
import type { ReminderCard } from '@pi-lead-child/protocol';
import { useState } from 'react';

import { intlLocale, useLocale, type Locale } from '@/i18n';

import { useCompanionRuntime, useControlPlaneStore } from '../../state/CompanionStateProvider';
import { useLeadName } from '../../state/hooks';
import { MarkdownMessage } from './MarkdownMessage';
import { ReminderCard as ReminderObjectCard, ReminderPreview } from './ReminderCard';
import { useOpenAgenda } from './useOpenAgenda';
import { reminderMessages } from './reminder.messages';

// 会话里的到点卡（工单 07，spec D10、D11）：一次到点一张，从到点到确认都在原地更新，位置是到点的时间。
//   · 到点了、还没确认：时间、事情、「重要」标记、推送的情况，「知道了」「10 分钟后再提醒」；
//   · 确认、改期、取消以后：收成一行「09:00 抢票 · 09:01 已确认」；
//   · Lead 为它单独回的那一轮（leadTurnId），和 Lead 写到卡上的话（record_disposition 的理由），挂在卡下面，不另起气泡。
// 数据是服务端按事件日志算好的提醒卡（「Lead 动态」的投影，按版本应用），这里不自己推断状态。

// 两种语言都是 24 小时制的「09:00」。h23 而不是 hour12: false：en-US 的 hour12: false 在零点会写成「24:05」。
function clock(value: string | null, locale: Locale): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(intlLocale(locale), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

/** 到点卡上推送的情况：「08:55 提前推过 · 已推送 2 次 · 没确认 09:04 再推」。不在到点状态时是 null。 */
export function reminderFireMeta(card: ReminderCard, locale: Locale): string | null {
  if (card.state !== 'fired') return null;
  const m = reminderMessages(locale);
  const parts: string[] = [];
  if (card.pushes.earlyAt) parts.push(m.pushedEarly(clock(card.pushes.earlyAt, locale)));
  if (card.pushes.count > 0) parts.push(m.pushedCount(card.pushes.count));
  if (card.pushes.exhausted) parts.push(m.exhausted);
  else if (card.pushes.nextAt) parts.push(m.nextPush(clock(card.pushes.nextAt, locale)));
  return parts.length ? parts.join(' · ') : null;
}

/** 结束以后的一行：「09:00 抢票 · 09:01 已确认」「09:00 抢票 · 改到 09:10」「09:00 抢票 · 已取消」。 */
export function reminderClosedLine(card: ReminderCard, locale: Locale): string {
  const m = reminderMessages(locale);
  const head = `${clock(card.remindAt, locale)} ${card.title}`;
  if (card.state === 'acked') return m.closedAcked(head, clock(card.closedAt, locale));
  if (card.state === 'snoozed') return card.nextAt ? m.closedMoved(head, clock(card.nextAt, locale)) : m.closedRescheduled(head);
  if (card.state === 'cancelled') return m.closedCancelled(head);
  return head;
}

function LeadWords({ text, leadName }: { text: string; leadName: string }) {
  return (
    <Column testID="reminder-fire-lead" w="100%" gap="text-stack" pl="inset-x" borderLeftWidth={2} borderLeftColor="border">
      <Text size="meta" weight="semibold" tone="secondary">{leadName}</Text>
      <MarkdownMessage markdown={text} />
    </Column>
  );
}

export function ReminderFireCardView({
  card,
  leadName,
  leadText = null,
  busy = false,
  error = null,
  onAck,
  onSnooze,
}: {
  card: ReminderCard;
  // Lead 的名字（useLeadName）：Lead 的话上面的发送者标签。
  leadName: string;
  // Lead 为这次到点单独回的那一轮说的话。
  leadText?: string | null;
  busy?: boolean;
  error?: string | null;
  onAck: () => void;
  onSnooze: () => void;
}) {
  // Lead 的话：它单独回的那一轮；插在别的回合里时，它写到卡上的那一句。
  const leadWords = leadText?.trim() || card.lead?.reason.trim() || null;
  const locale = useLocale();
  const m = reminderMessages(locale);
  const openAgenda = useOpenAgenda();
  if (card.state !== 'fired') {
    // 改了时间的提醒还在等：点开看改到的时刻。确认、取消了的看什么时候结束的。
    const stage = card.state === 'acked' ? 'acked' as const : card.state === 'cancelled' ? 'cancelled' as const : null;
    return (
      <Column testID={`reminder-fire-${card.reminderId}`} w="100%" gap="card-row">
        {/* 结束了的提醒是一行系统信息（主题 11.9）：和别的系统信息行同一个格子，图标列对齐。
            行尾的展开箭头（结束行 11.5、P9.4）：点开在原位置撑开，看那条提醒（2026-11-16 用户）。 */}
        <SystemLine
          testID="reminder-fire-line"
          icon={card.state === 'acked' ? 'check' : 'clock'}
          text={reminderClosedLine(card, locale)}
          detailsLabel={m.previewLabel}
          details={(close) => (
            <ReminderPreview
              reminderId={card.reminderId}
              title={card.title}
              remindAt={card.state === 'snoozed' ? card.nextAt ?? card.remindAt : card.remindAt}
              stage={stage}
              changedAt={card.closedAt}
              onOpenAgenda={() => { close(); openAgenda(); }}
            />
          )}
        />
        {leadWords ? <LeadWords text={leadWords} leadName={leadName} /> : null}
      </Column>
    );
  }
  const important = card.level === 'interrupt';
  const meta = reminderFireMeta(card, locale);
  return (
    <Card
      testID={`reminder-fire-${card.reminderId}`}
      w="100%"
      rounded="xl"
      borderLeftWidth={3}
      borderLeftColor={important ? 'warning' : 'accent'}
      px="card"
      py="card"
      gap="card-row"
    >
      <Row items="flex-start" gap="side-item">
        <Box w={30} h={30} rounded="full" bg={important ? 'warning-soft' : 'accent-soft'} items="center" justify="center" shrink={0}>
          <Icon name="clock" color={important ? 'warning' : 'accent'} size={14} />
        </Box>
        <Column flex={1} minW={0} gap="text-stack">
          <Row items="center" gap="inline-item">
            <Text size="meta" tone="secondary" numberOfLines={1}>{m.fireHead(clock(card.remindAt, locale))}</Text>
            {important ? <Badge testID="reminder-fire-important" label={m.important} tone="warning" size="sm" /> : null}
          </Row>
          <Text testID="reminder-fire-title" size="card-title" weight="bold" numberOfLines={2}>{card.title}</Text>
          {meta ? <Text testID="reminder-fire-meta" size="meta" tone="muted">{meta}</Text> : null}
        </Column>
      </Row>
      {/* spacing-exempt: 图标宽 30 加间距 12 */}
      <Row gap="actions" pl={42} flexWrap="wrap">
        <Button testID={`reminder-fire-${card.reminderId}-ack`} label={m.gotIt} size="xs" tone="accent" disabled={busy} onPress={onAck} />
        <Button
          testID={`reminder-fire-${card.reminderId}-snooze`}
          label={m.snooze10}
          size="xs"
          variant="outline"
          tone="neutral"
          disabled={busy}
          onPress={onSnooze}
        />
      </Row>
      {error ? <Text size="note" color="danger-dark">{error}</Text> : null}
      {leadWords ? <LeadWords text={leadWords} leadName={leadName} /> : null}
    </Card>
  );
}

/** 一轮 Lead 回合说的话（它的助手消息的文字）。没有时是 null。 */
function useTurnText(turnId: string | null): string | null {
  return useControlPlaneStore((state) => {
    if (!turnId) return null;
    const turn = state.turnsById[turnId];
    const part = turn ? state.messagePartsById[`${turn.assistantMessageId}:text`] : undefined;
    return part?.kind === 'text' && part.text.trim() ? part.text : null;
  });
}

// 「知道了」确认这条提醒（和工单动作一样走 POST /v1/tickets/:id/ack），「10 分钟后再提醒」改它的时间。
// 横幅、托盘、日程和这张卡都由服务端的推送和重取更新。
export function useReminderActions(reminderId: number) {
  const runtime = useCompanionRuntime();
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const run = (work: () => Promise<void>) => {
    setState({ busy: true, error: null });
    work().then(
      () => setState({ busy: false, error: null }),
      (error: unknown) => setState({ busy: false, error: error instanceof Error ? error.message : String(error) }),
    );
  };
  return {
    ...state,
    ack: () => run(() => runtime.performTicketAction(reminderId, 'ack')),
    snooze: () => run(() => runtime.rescheduleReminder(reminderId, { snoozeMinutes: 10 })),
  };
}

// 会话时间线里的一张到点卡：按 key 从 store 取，推送来了原地更新。
export function ReminderFireCard({ cardKey }: { cardKey: string }) {
  const card = useControlPlaneStore((state) => state.leadActivity.reminders?.[cardKey]);
  const leadText = useTurnText(card?.leadTurnId ?? null);
  const actions = useReminderActions(card?.reminderId ?? 0);
  const leadName = useLeadName();
  const locale = useLocale();
  const m = reminderMessages(locale);
  if (!card) return null;
  // 到点了还没确认：就是那条提醒本身（对象组件 Reminder 的到点态，2026-10-27 用户：到点卡还是改版以前的样子）。
  // 「知道了」在卡的右边，改时间在点开的浮层里；Lead 为这次到点说的话挂在下面。结束以后照旧收成一行。
  if (card.state === 'fired') {
    const leadWords = leadText?.trim() || card.lead?.reason.trim() || null;
    return (
      <Column testID={`reminder-fire-${card.reminderId}`} w="100%" gap="card-row">
        <ReminderObjectCard view={{
          reminderId: card.reminderId, title: card.title, remindAt: card.remindAt, stage: 'fired', event: null, fallback: null,
          level: card.level === 'interrupt' ? 'interrupt' : null, note: reminderFireMeta(card, locale),
        }} />
        {leadWords ? <LeadWords text={leadWords} leadName={leadName} /> : null}
      </Column>
    );
  }
  return (
    <ReminderFireCardView
      card={card}
      leadName={leadName}
      leadText={leadText}
      busy={actions.busy}
      error={actions.error ? m.failed(actions.error) : null}
      onAck={actions.ack}
      onSnooze={actions.snooze}
    />
  );
}
