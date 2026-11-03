// 回复下面的「依据」标签（provenance.ts、ProvenanceChips.tsx）。
import { defineMessages } from '@/i18n';

export const provenanceMessages = defineMessages({
  en: {
    runEvents: (_runId: number | null) => 'Execution records',
    ticketLedger: (ticketId: number | null) => (ticketId === null ? 'Ticket ledger' : `Ledger of ticket #${ticketId}`),
    ticketList: 'Ticket list',
    needsUser: 'Tickets that need you',
    inbox: 'System notices',
    notifications: 'Notifications',
    runtimeHealth: 'Executor status',
    modelCatalog: 'Model catalog',
    basis: (label: string) => `Source: ${label}`,
    showSources: (label: string) => `Source: ${label}. Show the sources.`,
    noEntries: 'This read returned no specific entries.',
    truncated: 'The result is long. Only the first part shows here.',
    openTicket: (ticketId: number, title: string) => `Open ticket #${ticketId}${title ? ` ${title}` : ''}`,
    ticket: 'Ticket',
  },
  zh: {
    runEvents: () => '执行记录',
    ticketLedger: (ticketId) => (ticketId === null ? '工单账本' : `工单 #${ticketId} 的账本`),
    ticketList: '工单列表',
    needsUser: '等你处理的工单',
    inbox: '系统通知',
    notifications: '通知',
    runtimeHealth: '运行状态',
    modelCatalog: '模型目录',
    basis: (label) => `依据：${label}`,
    showSources: (label) => `依据：${label}，查看来源`,
    noEntries: '这次读取没有返回具体条目。',
    truncated: '结果较长，这里只列出前面的部分。',
    openTicket: (ticketId, title) => `打开工单 #${ticketId}${title ? ` ${title}` : ''}`,
    ticket: '工单',
  },
});
