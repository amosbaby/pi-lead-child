import { Box, Button, Card, Column, MediaRow, Row, Text, Tile, type DataTone } from '@pi-lead-child/components';
import type { ReminderLevel, TicketStatus } from '@pi-lead-child/protocol';
import { useEffect, useState } from 'react';

import { intlLocale, useLocale, type Locale } from '@/i18n';

import { useConversationItemDetail, useTicketSummary } from '../../state/hooks';
import {
  ActionButton, ActionGroup, DisclosureView, FieldView, remainingWords, shortTimeWords, usePendingValue, type ActionProps,
} from '../genui/SurfaceControls';
import { ticketDisplayTitle, ticketSummaryToTicket } from '../workspace/model';
import { EndRow } from './EndRow';
import { reminderMessages } from './reminder.messages';
import { useOpenAgenda } from './useOpenAgenda';

const pad = (value: number) => String(value).padStart(2, '0');

// 星期的简写：中文「周一」，英文「Mon」。
function weekdayWord(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { weekday: 'short' }).format(date);
}

// 日历页上的月份：中文「10月」，英文「Oct」。
function monthWord(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { month: 'short' }).format(date);
}

// 提醒的时刻，用本地时间说：「周一 10-19 09:00」，英文「Mon 10-19 09:00」。
export function reminderTimeWords(at: string, locale: Locale): string | null {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return `${weekdayWord(date, locale)} ${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export type ReminderCardView = {
  reminderId: number;
  // 提醒的标题。还没取到时为 null，卡片说操作本身（fallback）。
  title: string | null;
  remindAt: string | null;
  // 提醒现在的状态（items.stage，从 TicketSummary 来）。
  stage: TicketStatus | null;
  // 这张卡对应的操作是什么事件（改期、取消、确认）。只描述那次操作，不代表现在的状态：写在展开的浮层里。
  event: string | null;
  // 取不到提醒时，操作自己说了什么（「提醒 #83 已创建」）。
  fallback: string | null;
  // 提醒的级别（TicketDetail.reminder，工单 07）：interrupt 是「重要」。取不到时是 null。
  level?: ReminderLevel | null;
  // 到点以后推送的情况（到点卡给）：「08:55 提前推过 · 已推送 1 次 · 没确认 09:02 再推」。
  note?: string | null;
};

// 会话里的一条提醒：对象组件 Reminder（三层的最上层，.scratch/genui-catalog-v3/three-layers.md）。
// 2026-10-27 按画布「提醒卡 · 方案一」重画，用的是 genui 的同一套组件（Tile、MediaRow、DisclosureView、FieldView、ActionGroup）：
//   1 等待中：一张票根，日历页（月份、日期）贴着卡片左边，打孔线两头两个半圆缺口；标题；「周四 14:00 · 还有 3 天 1 小时」。没有按钮，整张卡可以点。
//   2 点开：卡片原位置撑开成浮层，日历页加宽放大（星期、日期、时刻）；改时间的选项；右下角「取消提醒」「改到…」。
//     选了一个时间：日历页先换成新的一天，标题下面写「~~周四 14:00~~ → 周五 14:00」，按钮写「改到周五 14:00」。
//   3 点「取消提醒」：右下角那一行换成确认。
//   4 重要：色带浅琥珀，「重要，到点会打断你」。
//   5 已确认：浅绿色带上一个勾，「14:03 已确认」，不再撑开。
//   6 已取消：日历页变灰，日期上一道斜线，标题划掉，「你在 10-27 09:12 取消」，不再撑开。
// 改时间和取消走操作层（提醒的 reschedule、工单的 cancel），和 Lead 的 perform_action、ticket_action 是同一个函数。
// 到点以后会话里另有一张到点卡（ReminderFireCard），画布里没有它，这次没改。
export function ReminderCard({ view }: { view: ReminderCardView }) {
  const locale = useLocale();
  const m = reminderMessages(locale);
  const listed = useTicketSummary(view.reminderId);
  const openAgenda = useOpenAgenda();
  const { detail } = useConversationItemDetail(view.reminderId, true);
  const summary = listed ?? detail?.ticket ?? null;
  const stage = summary?.stage ?? view.stage;
  const title = summary ? ticketDisplayTitle(ticketSummaryToTicket(summary)) : view.title ?? view.fallback ?? m.reminderNumber(view.reminderId);
  const remindAt = detail?.remindAt ?? view.remindAt;
  const at = remindAt ? new Date(remindAt) : null;
  const level = detail?.reminder?.level ?? view.level ?? null;
  const ended = stage === 'acked' || stage === 'cancelled' || stage === 'done';
  const changedAt = summary?.stageChangedAt ? new Date(summary.stageChangedAt) : null;
  const tone: DataTone = stage === 'acked' ? 'success' : stage === 'cancelled' ? 'neutral' : level === 'interrupt' || stage === 'fired' ? 'warning' : 'info';
  const id = view.reminderId;
  const actions: ActionProps[] = [
    {
      id: `reminder-${id}-cancel`, target: { type: 'ticket', id }, action: 'cancel', role: 'default', label: m.cancelReminder,
      confirmText: at ? m.cancelConfirmAt(shortTimeWords(at, Date.now(), locale)) : m.cancelConfirm,
    },
    {
      id: `reminder-${id}-save`, target: { type: 'reminder' as const, id: String(id) }, action: 'reschedule', role: 'primary',
      label: m.moveTo, labelWithValue: m.moveToValue,
    },
  ];
  // 到点了还没确认（覆盖表「到点」：对象 Reminder 的到点态）：模式「事项」右边一个按钮「知道了」；
  // 「10 分钟后」是点开以后改时间的第一个选项。视觉稿没有单画这一态，色带和等待中的「重要」一样是琥珀。
  const fired = stage === 'fired';
  // 结束了的提醒（已确认、已取消）收成一行结束行（patterns P4.4）：和会话里别的一行对齐，不再占一张卡（2026-11-15 用户截图）。
  if (ended) {
    const clock = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const day = (date: Date) => `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const meta = changedAt
      ? (stage === 'cancelled' ? m.endedCancelled(day(changedAt)) : m.endedAcked(clock(changedAt)))
      : (stage === 'cancelled' ? m.cancelled : m.acked);
    return (
      <EndRow
        testID={`reminder-card-${id}`}
        label={m.cardLabel(title)}
        icon={stage === 'cancelled' ? 'close' : 'check'}
        iconColor={stage === 'cancelled' ? 'text-muted' : 'success'}
        title={title}
        struck={stage === 'cancelled'}
        meta={meta}
        onPress={openAgenda}
      />
    );
  }
  const summaryRow = (
    <MediaRow attach bleed testID={`reminder-card-${id}-stub`} lead={<ReminderPage at={at} tone={tone} stage={stage} />}>
      <Row items="center" gap="side-item">
        <Box flex={1} minW={0}>
          <ReminderLines reminderId={id} title={title} at={at} stage={stage} level={level} changedAt={changedAt} note={view.note ?? null} />
        </Box>
        {fired ? (
          // 「知道了」是操作层里提醒的 ack（和 Lead 的 perform_action 同一个函数），不在工单操作的清单里。
          <ActionButton id={`reminder-${id}-ack`} target={{ type: 'reminder' as const, id: String(id) }} action="ack" role="primary" label={m.gotIt} />
        ) : null}
      </Row>
    </MediaRow>
  );
  return (
    <Card testID={`reminder-card-${id}`} w="100%" variant="float" overflow="visible">
      <DisclosureView
        id={`reminder-${id}`}
        label={m.cardLabel(title)}
        partial={false}
        ended={ended}
        targets={{ [actions[0]!.id]: id, [actions[1]!.id]: id }}
        summary={summaryRow}
        panel={(
          <MediaRow attach bleed notches={false} testID={`reminder-card-${id}-open`} lead={<ReminderPage at={at} tone={tone} stage={stage} reminderId={id} expanded />}>
            <Column gap="card-section">
              <ReminderLines reminderId={id} title={title} at={at} stage={stage} level={level} changedAt={changedAt} />
              {view.event ? <Text size="secondary" tone="muted" numberOfLines={1}>{view.event}</Text> : null}
              <FieldView
                id={`reminder-${id}-pick`}
                for={actions[1]!.id}
                param="remindAt"
                kind="datetime"
                label={m.moveToLabel}
                presets={reminderPresets(at, locale, fired)}
                freeInput
                previewedByCard
              />
              <ActionGroup actions={actions} />
            </Column>
          </MediaRow>
        )}
      />
    </Card>
  );
}

// 结束了的到点卡点开以后看的提醒（2026-11-16 用户：「确认后就不见了，也没法点击预览了」）。
// 和到点时点开的那一块一样：日历页、标题、下面一行状态（什么时候确认、取消，或者改到的时刻）；没有改时间和取消，
// 结束了的事不再改（ReminderCard 的 5、6）。最下面「在日程里看」，和结束行 EndRow 点了去的地方一样。
export function ReminderPreview({ reminderId, title, remindAt, stage, changedAt, onOpenAgenda }: {
  reminderId: number;
  title: string;
  remindAt: string | null;
  // acked、cancelled；改了时间时是 null（还在等），remindAt 给改到的时刻。
  stage: TicketStatus | null;
  changedAt: string | null;
  onOpenAgenda: () => void;
}) {
  const m = reminderMessages(useLocale());
  const at = remindAt ? new Date(remindAt) : null;
  const changed = changedAt ? new Date(changedAt) : null;
  const tone: DataTone = stage === 'acked' ? 'success' : stage === 'cancelled' ? 'neutral' : 'info';
  return (
    <MediaRow attach bleed notches={false} testID={`reminder-preview-${reminderId}`} lead={<ReminderPage at={at} tone={tone} stage={stage} expanded />}>
      <Column gap="card-section" items="flex-start">
        <ReminderLines reminderId={reminderId} title={title} at={at} stage={stage} level={null} changedAt={changed} />
        <Button testID={`reminder-preview-${reminderId}-agenda`} label={m.openInAgenda} variant="link" size="sm" onPress={onOpenAgenda} />
      </Column>
    </MediaRow>
  );
}

// 改时间的常用选项：一小时后、明天 09:00、原来那一天的后一天同一时刻、下周一 09:00。按下时才换算（resolveDatetimePreset）。
function reminderPresets(at: Date | null, locale: Locale, fired = false): Array<{ label: string; value: string }> {
  const m = reminderMessages(locale);
  // 到点了：最常用的是再等一会儿。
  const presets = [...(fired ? [{ label: m.in10Minutes, value: '+10m' }] : []), { label: m.in1Hour, value: '+1h' }, { label: m.tomorrow9, value: '+1d 09:00' }];
  if (at) {
    const next = new Date(at);
    next.setDate(next.getDate() + 1);
    if (next.getTime() > Date.now()) presets.push({ label: shortTimeWords(next, Date.now(), locale), value: next.toISOString() });
  }
  presets.push({ label: m.nextMonday9, value: 'mon 09:00' });
  return presets;
}

// 日历页：月份的色带、日期；展开时加宽，多写星期和时刻。选了新时间时先换成新的一天，最下面划掉原来那天。
function ReminderPage({ at, tone, stage, expanded = false, reminderId }: {
  at: Date | null; tone: DataTone; stage: TicketStatus | null; expanded?: boolean; reminderId?: number;
}) {
  const pendingIso = usePendingValue(reminderId ?? 0, 'remindAt');
  const pending = expanded && pendingIso ? new Date(pendingIso) : null;
  const shown = pending ?? at;
  const locale = useLocale();
  const m = reminderMessages(locale);
  const weekday = (date: Date) => weekdayWord(date, locale);
  return (
    <Tile
      testID={`reminder-page${expanded ? '-open' : ''}`}
      attached
      size={expanded ? 'md' : 'sm'}
      tone={tone}
      eyebrow={shown ? monthWord(shown, locale) : m.reminder}
      value={shown ? shown.getDate() : '—'}
      done={stage === 'acked'}
      crossed={stage === 'cancelled'}
      highlight={pending !== null}
      {...(expanded && shown ? { above: weekday(shown), caption: `${pad(shown.getHours())}:${pad(shown.getMinutes())}` } : {})}
      {...(pending && at ? { was: m.was(weekday(at), at.getDate()) } : {})}
    />
  );
}

// 标题和下面一行。下面一行按状态写：等待中写时刻和剩余时间，重要写会打断你，已确认、已取消写什么时候。
function ReminderLines({ reminderId, title, at, stage, level, changedAt, note = null }: {
  reminderId: number; title: string; at: Date | null; stage: TicketStatus | null; level: ReminderLevel | null; changedAt: Date | null;
  note?: string | null;
}) {
  const pendingIso = usePendingValue(reminderId, 'remindAt');
  const pending = pendingIso ? new Date(pendingIso) : null;
  const locale = useLocale();
  const m = reminderMessages(locale);
  const when = at ? shortTimeWords(at, Date.now(), locale) : null;
  const clock = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const day = (date: Date) => `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock(date)}`;
  let line;
  if (pending && when) {
    line = (
      <Row items="center" gap="icon-label" flexWrap="wrap">
        <Text size="note" tone="muted" textDecorationLine="line-through">{when}</Text>
        <Text size="note" tone="secondary">→</Text>
        <Text size="note" weight="semibold" tone="accent">{shortTimeWords(pending, Date.now(), locale)}</Text>
      </Row>
    );
  } else if (stage === 'acked') {
    line = <Text size="note" tone="success-dark">{changedAt ? m.ackedAt(clock(changedAt)) : m.acked}</Text>;
  } else if (stage === 'cancelled') {
    line = <Text size="note" tone="secondary">{changedAt ? m.cancelledAt(day(changedAt)) : m.cancelled}</Text>;
  } else {
    // 到点了先说到点了：重要的提醒到点以后不再说「到点会打断你」。
    const tail = stage === 'fired'
      ? <Text testID="reminder-card-fired" size="note" tone="warning-dark">{level === 'interrupt' ? m.importantDue : m.due}</Text>
      : level === 'interrupt'
        ? <Text size="note" tone="warning-dark">{m.importantInterrupts}</Text>
        : at ? <LiveRemaining at={at} /> : null;
    line = (
      <Row items="center" gap="icon-label" flexWrap="wrap">
        {when ? <Text size="note" tone="secondary">{when}</Text> : null}
        {when && tail ? <Text size="note" tone="faint">·</Text> : null}
        {tail}
      </Row>
    );
  }
  return (
    <Column gap="text-stack" minW={0}>
      <Text
        size="card-title"
        weight="bold"
        tone={stage === 'cancelled' ? 'muted' : 'default'}
        {...(stage === 'cancelled' ? { textDecorationLine: 'line-through' as const } : {})}
        // 收着时两行（主题 11.1）：标题一行，下面一行状态。
        numberOfLines={1}
      >
        {title}
      </Text>
      {line}
      {note ? <Text testID="reminder-card-note" size="note" tone="secondary" numberOfLines={1}>{note}</Text> : null}
    </Column>
  );
}

// 剩余时间每 30 秒更新一次。
function LiveRemaining({ at }: { at: Date }) {
  const now = useMinuteClock();
  const locale = useLocale();
  return <Text size="note" tone="accent">{remainingWords(at, now, locale)}</Text>;
}

function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
