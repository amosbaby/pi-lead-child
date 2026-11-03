// 工单对话坞（TicketChatDock.tsx）和工单对话（TicketConversation.tsx）的文字。
import { defineMessages } from '@/i18n';

export const ticketChatMessages = defineMessages({
  en: {
    title: 'Ticket conversation',
    newReply: 'New reply',
    connectToSend: 'Connect to send to this ticket',
    empty: 'No conversation yet. Ask about the progress of this ticket below, or give its agent instructions.',
    you: 'You',
    sending: 'Sending',
    answering: 'Answering',
    answeringNow: 'Answering…',
    queued: 'Queued',
    noAnswerResend: 'This message got no answer. The ticket did not change. Expand to send it again.',
    noText: '(No text reply)',
    stalled: 'It did not start after 1 minute. It usually starts in 10 seconds. It can be stuck.',
    collapse: 'Collapse',
    showAll: (size: string) => `Show full text · about ${size} characters`,
    sender: { system: 'System', child: 'Executor' },
  },
  zh: {
    title: '工单对话',
    newReply: '新回复',
    connectToSend: '连接后可以发给这张工单',
    empty: '还没有对话。在下面问这张工单的进展，或者交代它的 agent。',
    you: '你',
    sending: '发送中',
    answering: '正在回答',
    answeringNow: '正在回答…',
    queued: '已排队',
    noAnswerResend: '没能回答这条消息，工单本身没有变化。展开后可以重发。',
    noText: '（没有文字回复）',
    stalled: '超过 1 分钟还没开始。通常 10 秒内开始，可能卡住了。',
    collapse: '收起',
    showAll: (size) => `展开全文 · 约 ${size} 字`,
    sender: { system: '系统', child: '执行者' },
  },
});
