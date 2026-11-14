import {
  Box, Card, Column, Drawer, FloatingButton, Icon, LeadAvatar, Pressable, Row, ScrollArea, Text, type IconName,
} from '@pi-lead-child/components';
import { DEFAULT_VIEW, defaultViewLabel, ticketTurn, widgetViews, type TicketSummary } from '@pi-lead-child/protocol';
import { useRouter, type Href } from 'expo-router';
import { Fragment } from 'react';

import { useLeadPresence } from '@/components/LeadIdentity';
import { leadFairy } from '@/components/leadPresence';
import { useLeadAvatarSource } from '@/components/useLeadAvatarSource';
import { clockTimeLabel } from '@/features/tickets/timeLabels';
import { projectDisplayName, ticketDisplayTitle } from '@/features/workspace/model';
import { dayWord } from '@/features/workspace/timelineModel';
import { waitedText } from '@/features/workspace/waitedText';
import { useLocale, useMessages } from '@/i18n';
import { useLeadBusy, useLeadName, useProjectOverviews, useTickets, useTimeline, useWidgets } from '@/state/hooks';

import { homeMessages } from './home.messages';

// 「还有 X、Y」最多写几件。
const ALSO_WAITING = 2;
// 小组件的高度（组件规格，画板 FDrawer3）。
const WIDGET_HEIGHT = 112;

// 手机首页的抽屉（主题 H-5，2026-11-14 用户采纳的 FDrawer3）。抽屉只能从对话页打开，所以没有「对话」这一项。
// 从上到下：Lead 的形象和名字、设置圆钮；等你的事；四块小组件（工单、日程、项目、自定义视图）；Lead 在做的事。
// 点任何一处先关抽屉，再进对应的页面。没有数据的说明行不写，不编（例如自定义视图没有缺省视图时只写数量）。
export function HomeDrawer({ open, onClose, waiting, onOpenWaiting }: {
  open: boolean;
  onClose: () => void;
  waiting: readonly TicketSummary[];
  onOpenWaiting: () => void;
}) {
  const m = useMessages(homeMessages);
  // 里面的数据（日程、项目、视图）只在抽屉打开时订阅：Drawer 关着时不挂内容（2026-11-14，关着也订阅时首页变卡）。
  return (
    <Drawer testID="home-drawer" open={open} onClose={onClose} label={m.menu}>
      <HomeDrawerContent onClose={onClose} waiting={waiting} onOpenWaiting={onOpenWaiting} />
    </Drawer>
  );
}

function HomeDrawerContent({ onClose, waiting, onOpenWaiting }: {
  onClose: () => void;
  waiting: readonly TicketSummary[];
  onOpenWaiting: () => void;
}) {
  const router = useRouter();
  const locale = useLocale();
  const m = useMessages(homeMessages);
  const name = useLeadName();
  const presence = useLeadPresence();
  const fairy = leadFairy(presence, useLeadBusy());
  const source = useLeadAvatarSource(fairy);
  const tickets = useTickets();
  const timeline = useTimeline();
  const projects = useProjectOverviews();
  const { widgets } = useWidgets();
  const go = (href: Href) => {
    onClose();
    router.push(href);
  };

  // 等你的事：等得最久的一件在前。
  const oldestFirst = [...waiting].sort((left, right) => (left.stageChangedAt ?? '').localeCompare(right.stageChangedAt ?? ''));
  const first = oldestFirst[0];
  const others = oldestFirst.slice(1, 1 + ALSO_WAITING).map((ticket) => ticketDisplayTitle(ticket));

  const running = tickets
    .filter((ticket) => ticketTurn(ticket) === 'running')
    .sort((left, right) => (right.stageChangedAt ?? '').localeCompare(left.stageChangedAt ?? ''));
  const latestTicket = running[0] ?? [...tickets].sort((left, right) => (right.stageChangedAt ?? '').localeCompare(left.stageChangedAt ?? ''))[0];

  const nowIso = new Date().toISOString();
  const nextEntry = (timeline?.entries ?? [])
    .filter((entry) => entry.status === 'upcoming' && entry.at >= nowIso)
    .sort((left, right) => left.at.localeCompare(right.at))[0];

  const activeProjects = (projects ?? []).filter((project) => project.status === 'active');
  const latestProject = [...activeProjects].sort((left, right) => (right.lastActivityAt ?? '').localeCompare(left.lastActivityAt ?? ''))[0];

  const views = widgets ? widgetViews(widgets) : [];
  const defaultView = views.includes(DEFAULT_VIEW) ? defaultViewLabel(locale) : null;

  return (
      <ScrollArea>
        <Column px="page-x" py="page-y" gap="card-section">
          <Row items="center" gap="side-item">
            <LeadAvatar size={44} name={name} state={fairy.state} tone={fairy.tone} source={source} />
            <Text flex={1} minW={0} size="drawer-title" weight="bold" numberOfLines={1}>{name}</Text>
            <FloatingButton testID="home-drawer-settings" label={m.settings} onPress={() => go('/settings')}>
              <Icon name="settings" size={20} color="text" />
            </FloatingButton>
          </Row>

          {first ? (
            <Pressable testID="home-drawer-waiting" aria-label={m.waitingCount(oldestFirst.length)} onPress={() => { onClose(); onOpenWaiting(); }} feedback="none">
              <Card variant="float" p="card">
                <Row items="center" gap="inline-item">
                  <Column flex={1} minW={0} gap="text-stack">
                    <Row items="center" gap="icon-label">
                      <Box w={7} h={7} rounded="full" bg="warning" />
                      <Text size="label" weight="semibold" tone="warning-dark">{m.waitingCount(oldestFirst.length)}</Text>
                    </Row>
                    <Text size="nav-label" weight="semibold" numberOfLines={1}>{ticketDisplayTitle(first)}</Text>
                    {others.length ? <Text size="label" tone="secondary" numberOfLines={1}>{m.alsoWaiting(others.join('、'))}</Text> : null}
                  </Column>
                  <Icon name="chevron-right" size={16} color="text-secondary" />
                </Row>
              </Card>
            </Pressable>
          ) : null}

          <Column gap="inline-item">
            <Row gap="inline-item">
              <Widget testID="home-widget-tickets" icon="tickets" name={m.ticketsWidget} value={m.ticketsRunning(running.length)}
                caption={latestTicket ? m.recent(ticketDisplayTitle(latestTicket)) : null} onPress={() => go('/tickets')} />
              <Widget testID="home-widget-agenda" icon="calendar" name={m.agendaWidget}
                value={nextEntry ? nextAgendaWhen(nextEntry.at, locale) : m.noAgenda} mono={Boolean(nextEntry)}
                caption={nextEntry?.title ?? null} onPress={() => go('/agenda')} />
            </Row>
            <Row gap="inline-item">
              <Widget testID="home-widget-projects" icon="folder" name={m.projectsWidget} value={m.countOf(activeProjects.length)}
                caption={latestProject ? m.recent(projectDisplayName(latestProject.name, locale)) : null} onPress={() => go('/projects')} />
              <Widget testID="home-widget-views" icon="views" name={m.views} value={m.countOf(views.length)}
                caption={defaultView} onPress={() => go('/views')} />
            </Row>
          </Column>

          {running.length ? (
            <Column testID="home-drawer-doing" gap="group-label">
              <Text size="label" weight="semibold" tone="strong" px="section-label-x">{m.leadDoing(name)}</Text>
              <Card variant="float" overflow="hidden">
                {running.map((ticket, index) => (
                  <Fragment key={ticket.id}>
                    {index > 0 ? <Box h={1} mx="row-x" bg="border-soft" /> : null}
                    <Pressable testID={`home-drawer-doing-${ticket.id}`} onPress={() => go(`/ticket/${ticket.id}` as Href)} feedback="highlight" px="row-x" py="row-y">
                      <Row items="center" gap="inline-item">
                        <Text flex={1} minW={0} size="card-title" weight="regular" numberOfLines={1}>{ticketDisplayTitle(ticket)}</Text>
                        {ticket.stageChangedAt ? <Text size="meta" mono tone="muted">{waitedText(ticket.stageChangedAt, undefined, locale)}</Text> : null}
                      </Row>
                    </Pressable>
                  </Fragment>
                ))}
              </Card>
            </Column>
          ) : null}
        </Column>
      </ScrollArea>
  );
}

// 一块小组件（画板 FDrawer3）：上面是图标和名称，下面贴底两行：主值和一行说明。没有说明时只写主值。
function Widget({ icon, name, value, caption, mono = false, onPress, testID }: {
  icon: IconName; name: string; value: string; caption: string | null; mono?: boolean; onPress: () => void; testID: string;
}) {
  return (
    <Pressable testID={testID} aria-label={[name, value, caption].filter(Boolean).join(', ')} onPress={onPress} feedback="none" flex={1} minW={0}>
      <Card variant="float" p="card" h={WIDGET_HEIGHT}>
        <Row items="center" gap="icon-label">
          <Icon name={icon} size={16} color="text-strong" />
          <Text size="label" weight="semibold" tone="strong" numberOfLines={1}>{name}</Text>
        </Row>
        <Box flex={1} />
        <Text size="drawer-title" weight="bold" mono={mono} numberOfLines={1}>{value}</Text>
        {caption ? <Text size="label" tone="secondary" numberOfLines={1}>{caption}</Text> : null}
      </Card>
    </Pressable>
  );
}

// 下一个日程的时间：今天的只写钟点；不是今天的，前面加上哪一天（「明天 10:30」「周一 10:30」），不让人以为是今天。
function nextAgendaWhen(at: string, locale: Parameters<typeof dayWord>[2]): string {
  const now = new Date();
  const time = clockTimeLabel(at);
  return new Date(at).toDateString() === now.toDateString() ? time : `${dayWord(at, now, locale)} ${time}`;
}
