// 手机上的工单页（主题 11.20，画板 FTickets，2026-11-14 方案 F）。
import { defineMessages } from '@/i18n';

export const ticketsPageMessages = defineMessages({
  en: {
    summary: (waiting: number, running: number) => `${waiting} waiting for you · ${running} running`,
    waiting: 'Waiting for you',
    running: 'Running',
    recent: 'Recently ended',
    empty: 'No tickets yet.',
    line: (id: string, project: string | null) => (project ? `Ticket #${id} · ${project}` : `Ticket #${id}`),
    composer: (leadName: string) => `Ask ${leadName} to open a ticket…`,
  },
  zh: {
    summary: (waiting, running) => `${waiting} 张等你 · ${running} 张在执行`,
    waiting: '等你',
    running: '在执行',
    recent: '最近结束',
    empty: '还没有工单。',
    line: (id, project) => (project ? `工单 #${id} · ${project}` : `工单 #${id}`),
    composer: (leadName) => `让 ${leadName} 开一张工单…`,
  },
});
