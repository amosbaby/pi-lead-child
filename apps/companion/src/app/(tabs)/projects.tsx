import { SecondaryScreen } from '@/components/SecondaryScreen';
import { ProjectCards } from '@/features/workspace/ProjectCards';
import { projectsPageMessages } from '@/features/workspace/projectsPage.messages';
import { useMessages } from '@/i18n';
import { navigationMessages } from '@/navigation/navigation.messages';
import { useConnectionPhase, useLeadName, useProjectOverviews, useTickets } from '@/state/hooks';

// 项目页（主题 11.20，画板 FProjects，2026-11-14 方案 F）。
export default function ProjectsScreen() {
  const phase = useConnectionPhase();
  const overviews = useProjectOverviews();
  const tickets = useTickets();
  const leadName = useLeadName();
  const nav = useMessages(navigationMessages);
  const m = useMessages(projectsPageMessages);
  return (
    <SecondaryScreen testID="projects-page" title={nav.projects} composerPlaceholder={m.composer(leadName)}>
      <ProjectCards overviews={phase === 'ready' ? overviews ?? [] : []} tickets={tickets} />
    </SecondaryScreen>
  );
}
