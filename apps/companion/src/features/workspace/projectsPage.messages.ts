// 手机上的项目页（主题 11.20，画板 FProjects，2026-11-14 方案 F）。
import { defineMessages } from '@/i18n';

export const projectsPageMessages = defineMessages({
  en: {
    count: (count: number) => (count === 1 ? '1 project' : `${count} projects`),
    waiting: (count: number) => `${count} waiting for you`,
    running: (count: number) => `${count} running`,
    idle: 'No tickets running',
    empty: 'No projects yet.',
    composer: (leadName: string) => `Tell ${leadName} about a project…`,
  },
  zh: {
    count: (count) => `${count} 个`,
    waiting: (count) => `${count} 张等你`,
    running: (count) => `${count} 张在执行`,
    idle: '没有在执行的工单',
    empty: '还没有项目。',
    composer: (leadName) => `跟 ${leadName} 说一个项目的事…`,
  },
});
