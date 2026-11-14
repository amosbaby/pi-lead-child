import { Box, Card, Column, Row, Text } from '@pi-lead-child/components';
import type { ProjectOverview, TicketSummary } from '@pi-lead-child/protocol';

import { clockTimeLabel } from '@/features/tickets/timeLabels';
import { useLocale, useMessages } from '@/i18n';

import { projectDisplayName, ticketDisplayTitle } from './model';
import { projectsPageMessages } from './projectsPage.messages';

// 项目页（画板 FProjects）：每个项目一张白色悬浮卡。三行：项目名（显示名不同于原名时，后面用等宽字写原名）；
// 状态行（有等你的先写琥珀点和「N 张等你」，再写「N 张在执行」；都没有时写「没有在执行的工单」）；
// 最后一行是最近活动的时间和那张工单的标题（从工单列表里找这个项目最近变化的一张，找不到时只写时间）。
// 卡片现在不能点：手机上还没有项目详情页，箭头先不画（2026-11-14，已告诉设计会话）。
export function ProjectCards({ overviews, tickets }: { overviews: readonly ProjectOverview[]; tickets: readonly TicketSummary[] }) {
  const m = useMessages(projectsPageMessages);
  const active = overviews
    .filter((project) => project.status === 'active')
    .sort((left, right) => (right.lastActivityAt ?? '').localeCompare(left.lastActivityAt ?? ''));
  return (
    <Column testID="project-cards" gap="card-section">
      <Text size="label" tone="secondary" px="section-label-x">{m.count(active.length)}</Text>
      {active.map((project) => <ProjectCard key={project.id} project={project} tickets={tickets} />)}
      {!active.length ? <Text size="body" tone="secondary" px="section-label-x">{m.empty}</Text> : null}
    </Column>
  );
}

function ProjectCard({ project, tickets }: { project: ProjectOverview; tickets: readonly TicketSummary[] }) {
  const locale = useLocale();
  const m = useMessages(projectsPageMessages);
  const name = projectDisplayName(project.name, locale);
  const latest = tickets
    .filter((ticket) => ticket.project === project.name)
    .sort((left, right) => (right.stageChangedAt ?? '').localeCompare(left.stageChangedAt ?? ''))[0];
  const when = project.lastActivityAt ? shortWhen(project.lastActivityAt) : null;
  const activity = [when, latest ? ticketDisplayTitle(latest) : null].filter(Boolean).join(' · ');
  return (
    <Card testID={`project-card-${project.id}`} variant="float" p="card" gap="field">
      <Row items="baseline" gap="inline-item">
        <Text shrink={1} size="nav-label" weight="semibold" numberOfLines={1}>{name}</Text>
        {name !== project.name ? <Text shrink={1} size="meta" mono tone="secondary" numberOfLines={1}>{project.name}</Text> : null}
      </Row>
      <Row items="center" gap="icon-label">
        {project.counts.user > 0 ? (
          <>
            <Box w={7} h={7} rounded="full" bg="warning" />
            <Text size="label" weight="semibold" tone="warning-dark">{m.waiting(project.counts.user)}</Text>
            {project.counts.running > 0 ? <Text size="label" tone="secondary">{`· ${m.running(project.counts.running)}`}</Text> : null}
          </>
        ) : (
          <Text size="label" tone="secondary">{project.counts.running > 0 ? m.running(project.counts.running) : m.idle}</Text>
        )}
      </Row>
      {activity ? <Text size="label" tone="secondary" numberOfLines={1}>{activity}</Text> : null}
    </Card>
  );
}

function shortWhen(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toDateString() === new Date().toDateString() ? clockTimeLabel(value) : `${date.getMonth() + 1}/${date.getDate()}`;
}
