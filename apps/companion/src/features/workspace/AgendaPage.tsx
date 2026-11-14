import { Box, Button, Column, FloatingSheet, ListGroup, Pressable, Row, Text, openURL } from '@pi-lead-child/components';
import type { TimelineEntry, TimelineResponse } from '@pi-lead-child/protocol';
import { useState } from 'react';

import { clockTimeLabel } from '@/features/tickets/timeLabels';
import { useLocale, useMessages } from '@/i18n';
import { useLeadName } from '@/state/hooks';

import { agendaPageMessages } from './agendaPage.messages';
import { localDateKey } from './model';
import { waitedText } from './waitedText';

type EntryState = 'past' | 'next' | 'waiting' | 'plain';

// 日程页（画板 FAgenda，2026-11-14 方案 F）：今天的日期和星期；一周的日期条（有日程的那天带一个点，今天是深色）；
// 选中那天和第二天两组，一行一件：时间、标题和来源。过去的划掉，下一件加粗，等你的带琥珀点。
// 点一行升起日程详情（FEvent），用手机上统一的悬浮面板（P13.2）。
export function AgendaPage({ timeline, onOpenTicket, onToggleReminder }: {
  timeline: TimelineResponse | null;
  onOpenTicket: (ticketId: number) => void;
  onToggleReminder?: (entryId: number, muted: boolean) => Promise<void>;
}) {
  const m = useMessages(agendaPageMessages);
  const now = new Date();
  const todayKey = localDateKey(now);
  const [selected, setSelected] = useState(todayKey);
  const [open, setOpen] = useState<TimelineEntry | null>(null);
  const entries = [...(timeline?.entries ?? [])].sort((left, right) => left.at.localeCompare(right.at));
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = localDateKey(new Date(entry.at));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const nextId = entries.find((entry) => entry.status === 'upcoming' && new Date(entry.at) >= now)?.id ?? null;
  const week = weekOf(now);
  const selectedDate = new Date(`${selected}T00:00:00`);
  const following = addDays(selectedDate, 1);
  const dayLabel = (date: Date) => {
    const key = localDateKey(date);
    if (key === todayKey) return m.today;
    if (key === localDateKey(addDays(now, 1))) return m.tomorrow;
    return m.dateLine(date.getMonth() + 1, date.getDate(), m.weekday((date.getDay() + 6) % 7));
  };
  const on = (date: Date) => entries.filter((entry) => localDateKey(new Date(entry.at)) === localDateKey(date));

  return (
    <Column testID="agenda-page" gap="page-section">
      <Column gap="card-row">
        <Text size="label" tone="secondary" px="section-label-x">{m.dateLine(now.getMonth() + 1, now.getDate(), m.weekday((now.getDay() + 6) % 7))}</Text>
        <Row testID="agenda-week" gap="icon-label">
          {week.map((date) => {
            const key = localDateKey(date);
            const isToday = key === todayKey;
            const isSelected = key === selected;
            const count = counts.get(key) ?? 0;
            return (
              <Pressable key={key} testID={`agenda-day-${key}`} aria-label={m.selectDay(dayLabel(date), count)} aria-pressed={isSelected}
                onPress={() => setSelected(key)} feedback="none" flex={1} minW={0} items="center" gap="text-stack">
                <Text size="meta" tone="secondary">{m.weekday((date.getDay() + 6) % 7)}</Text>
                <Column w={40} h={48} rounded="5xl" items="center" justify="center" gap="text-stack" // 组件规格：日期胶囊 40×48
                  bg={isToday ? 'text' : isSelected ? 'surface' : 'transparent'} borderWidth={isSelected && !isToday ? 1 : 0} borderColor="border-strong">
                  <Text size="card-title" mono tone={isToday ? 'inverse' : 'default'}>{String(date.getDate())}</Text>
                  <Box w={4} h={4} rounded="full" bg={count ? (isToday ? 'surface' : 'accent') : 'transparent'} />
                </Column>
              </Pressable>
            );
          })}
        </Row>
      </Column>
      {[selectedDate, following].map((date) => {
        const rows = on(date);
        return (
          <ListGroup key={localDateKey(date)} testID={`agenda-group-${localDateKey(date)}`} title={dayLabel(date)} count={rows.length || undefined}>
            {rows.length
              ? rows.map((entry) => (
                <EntryRow key={entry.id} entry={entry} state={entryState(entry, now, nextId)} onPress={() => setOpen(entry)} />
              ))
              : [<Text key="none" size="body" tone="secondary" px="row-x" py="row-y">{m.nothing}</Text>]}
          </ListGroup>
        );
      })}
      <EventSheet entry={open} onClose={() => setOpen(null)} onOpenTicket={onOpenTicket} onToggleReminder={onToggleReminder} />
    </Column>
  );
}

function EntryRow({ entry, state, onPress }: { entry: TimelineEntry; state: EntryState; onPress: () => void }) {
  const m = useMessages(agendaPageMessages);
  const source = useSourceLine(entry);
  return (
    <Pressable testID={`agenda-entry-${entry.id}`} onPress={onPress} feedback="highlight" px="row-x" py="row-y">
      <Row items="flex-start" gap="side-item">
        <Text w={40} size="secondary" mono tone={state === 'past' ? 'muted' : 'secondary'}>{entry.allDay ? m.allDay : clockTimeLabel(entry.at)}</Text>
        <Column flex={1} minW={0} gap="text-stack">
          <Text size="card-title" weight={state === 'next' || state === 'waiting' ? 'semibold' : 'regular'} tone={state === 'past' ? 'muted' : 'default'}
            textDecorationLine={state === 'past' ? 'line-through' : 'none'} numberOfLines={1}>{entry.title}</Text>
          <Row items="center" gap="icon-label">
            {state === 'waiting' ? <Box w={7} h={7} rounded="full" bg="warning" /> : null}
            <Text size="label" tone={state === 'waiting' ? 'warning-dark' : state === 'past' ? 'muted' : 'secondary'} numberOfLines={1}>{source}</Text>
          </Row>
        </Column>
      </Row>
    </Pressable>
  );
}

// 日程详情（画板 FEvent）：来源和日期、标题、时间行、地点和说明；操作条按这件事能做什么给：
// 外部日历有会议链接时「加入会议」，有预建提醒时「提醒我 / 不用提醒我」，关联工单时「打开工单 #N」。
// 画板里的「参加的人」和「和这场会有关的工单」现在没有数据，不画（2026-11-14，已告诉设计会话）。
function EventSheet({ entry, onClose, onOpenTicket, onToggleReminder }: {
  entry: TimelineEntry | null;
  onClose: () => void;
  onOpenTicket: (ticketId: number) => void;
  onToggleReminder?: (entryId: number, muted: boolean) => Promise<void>;
}) {
  const m = useMessages(agendaPageMessages);
  const locale = useLocale();
  const source = useSourceLine(entry);
  const [shown, setShown] = useState<TimelineEntry | null>(entry);
  if (entry && entry !== shown) setShown(entry);
  const current = entry ?? shown;
  const external = current?.external ?? null;
  const start = current ? new Date(current.at) : null;
  const end = external?.endsAt ? new Date(external.endsAt) : null;
  const length = start && end ? Math.round((end.getTime() - start.getTime()) / 60000) : null;
  const until = start && start > new Date() ? waitedText(new Date(2 * Date.now() - start.getTime()).toISOString(), undefined, locale) : null;
  const timeLine = current
    ? [current.allDay ? m.allDay : `${clockTimeLabel(current.at)}${end ? ` – ${clockTimeLabel(external!.endsAt!)}` : ''}`,
      length ? m.minutes(length) : null, until ? m.startsIn(until) : null].filter(Boolean).join(' · ')
    : '';
  const primary = external?.url
    ? <Button testID="agenda-event-join" label={m.join} shape="pill" size="lg" onPress={() => openURL(external.url!)} />
    : current?.ticketId
      ? <Button testID="agenda-event-ticket" label={m.openTicket(current.ticketId)} shape="pill" size="lg" onPress={() => { onClose(); onOpenTicket(current.ticketId!); }} />
      : null;
  const reminder = external?.reminder && onToggleReminder
    ? <Button testID="agenda-event-remind" label={external.muted ? m.unmuteReminder : m.muteReminder} variant="soft" tone="neutral" shape="pill" size="lg"
        onPress={() => void onToggleReminder(external.entryId, !external.muted)} />
    : null;
  return (
    <FloatingSheet testID="agenda-event" open={entry !== null} onClose={onClose} label={current?.title ?? ''}
      footer={primary || reminder ? <>{primary}{reminder}</> : undefined}>
      {current ? (
        <Column gap="card-section">
          <Column gap="text-stack">
            <Text size="label" tone="secondary">{source}</Text>
            <Text size="drawer-title" weight="bold">{current.title}</Text>
            <Text size="secondary" mono tone="strong">{timeLine}</Text>
          </Column>
          {external?.location || current.detail ? (
            <Column gap="card-row">
              {external?.location ? <InfoRow label={m.location} value={external.location} /> : null}
              {current.detail ? <InfoRow label={m.note} value={current.detail} /> : null}
            </Column>
          ) : null}
        </Column>
      ) : null}
    </FloatingSheet>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <Row items="flex-start" gap="side-item">
      <Text w={44} size="label" tone="secondary">{label}</Text>
      <Text flex={1} minW={0} size="body">{value}</Text>
    </Row>
  );
}

// 来源这一行：日历加时长、提醒是谁定的、Lead 的跟进、工单的节点。
function useSourceLine(entry: TimelineEntry | null): string {
  const m = useMessages(agendaPageMessages);
  const leadName = useLeadName();
  if (!entry) return '';
  if (entry.external) {
    const end = entry.external.endsAt ? new Date(entry.external.endsAt).getTime() : null;
    const length = end ? Math.round((end - new Date(entry.at).getTime()) / 60000) : null;
    return m.calendar(entry.external.feedLabel, length ? m.minutes(length) : null);
  }
  if (entry.kind === 'reminder') return entry.provenance?.actor === 'user' ? m.reminderMine : m.reminderBy(leadName);
  if (entry.kind === 'deferred_start') return m.followUp(leadName);
  if (entry.kind === 'routine' || entry.kind === 'routine_fired') return entry.detail ?? m.routine;
  if (entry.ticketId && entry.milestone) return m.milestone(entry.ticketId, entry.milestone.label);
  return entry.project ?? '';
}

function entryState(entry: TimelineEntry, now: Date, nextId: string | null): EntryState {
  if (entry.risk?.reason === 'ticket_needs_user' || entry.status === 'unacked' || entry.status === 'overdue') return 'waiting';
  if (entry.status === 'done' || (entry.status !== 'upcoming' && new Date(entry.at) < now) || (entry.status === 'upcoming' && new Date(entry.at) < now && !entry.allDay)) return 'past';
  if (entry.id === nextId) return 'next';
  return 'plain';
}

// 这一周（周一到周日）。
function weekOf(now: Date): Date[] {
  const monday = addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate()), -((now.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}
