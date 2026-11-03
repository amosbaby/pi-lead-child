// 合一的工单卡（DispatchTicketCard.tsx）和它浮层里的关键更新（dispatchCards.ts）。
import { defineMessages } from '@/i18n';

export const dispatchMessages = defineMessages({
  en: {
    ticketDone: 'Ticket done',
    ticketCancelled: 'Ticket cancelled',
    ended: 'Ended',
    reviewPassed: 'Review passed',
    reviewFailed: 'Review failed',
    system: 'System',
    ticketNumber: (ticketId: number) => `Ticket #${ticketId}`,
    progressOf: (ticketId: number) => `Progress of #${ticketId}`,
    openDetails: (ticketId: number) => `Open the details of ticket #${ticketId}`,
    showProgress: (ticketId: number) => `Show the progress of #${ticketId}`,
    hideProgress: (ticketId: number) => `Hide the progress of #${ticketId}`,
    fresh: (count: number) => `${count} new`,
    count: (count: number) => (count === 1 ? '1 update' : `${count} updates`),
    noReport: 'The executor has not reported yet.',
    keyOnly: 'Only key updates show here. The ticket details have the full record.',
  },
  zh: {
    ticketDone: '工单已完成',
    ticketCancelled: '工单已取消',
    ended: '进入终态',
    reviewPassed: '核查通过',
    reviewFailed: '核查不通过',
    system: '系统',
    ticketNumber: (ticketId) => `工单 #${ticketId}`,
    progressOf: (ticketId) => `#${ticketId} 的进展`,
    openDetails: (ticketId) => `打开工单 #${ticketId} 详情`,
    showProgress: (ticketId) => `展开 #${ticketId} 的进展`,
    hideProgress: (ticketId) => `收起 #${ticketId} 的进展`,
    fresh: (count) => `${count} 条新`,
    count: (count) => `${count} 条`,
    noReport: '执行者还没有汇报。',
    keyOnly: '只显示关键更新。完整记录在工单详情里。',
  },
});
