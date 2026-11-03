// 会话里的进展通知（CheckpointCard.tsx），和合一的工单卡里的关键更新（dispatchCards.ts、DispatchTicketCard.tsx）。
import { defineMessages } from '@/i18n';

export const checkpointMessages = defineMessages({
  en: {
    kind: {
      progress: 'Progress',
      milestone: 'Stage complete',
      decision: 'Direction change',
      delegation: 'Delegated',
      blocked: 'Needs your action',
      completed: 'Sent for review',
    },
    openTicket: (ticketId: number) => `Open ticket #${ticketId}`,
    childTicket: (ticketId: number) => `Child ticket #${ticketId}`,
    now: (status: string) => `Now: ${status}`,
    systemUpdate: (time: string) => `System update${time ? ` · ${time}` : ''}`,
    messageFrom: (identity: string, time: string) => `Message from ${identity}${time ? ` · ${time}` : ''}`,
    authorizationRecordedTitle: 'Authorization recorded. Waiting for the run state.',
    authorizationStillBlocked: (leadName: string) =>
      `The authorization is recorded, but the ticket is still blocked. Waiting for the executor or ${leadName} to report the result again.`,
    authorizationContinues: 'The authorization is recorded. The executor continues the work.',
  },
  zh: {
    kind: {
      progress: '进展',
      milestone: '阶段完成',
      decision: '方向调整',
      delegation: '已委派',
      blocked: '需要介入',
      completed: '已提交复核',
    },
    openTicket: (ticketId) => `打开工单 #${ticketId}`,
    childTicket: (ticketId) => `子工单 #${ticketId}`,
    now: (status) => `现在：${status}`,
    systemUpdate: (time) => `系统更新${time ? ` · ${time}` : ''}`,
    messageFrom: (identity, time) => `来自 ${identity} 的消息${time ? ` · ${time}` : ''}`,
    authorizationRecordedTitle: '授权已记录，等待执行状态确认',
    authorizationStillBlocked: (leadName) => `授权已经记录，但工单仍处于阻塞；等待执行者或 ${leadName} 重新上报执行结果。`,
    authorizationContinues: '授权已经记录，执行者正在继续执行。',
  },
});
