// 工单列表页的「找不到」（计划 Task 14）：用户说没找到某张单，记一行（操作 ticket_miss.record，和 plc miss 同一个）。
import { defineMessages } from '@/i18n';

export const ticketMissMessages = defineMessages({
  en: {
    open: "Can't find a ticket?",
    placeholder: 'What could you not find?',
    label: 'What you could not find',
    send: 'Send',
    sending: 'Sending…',
    cancel: 'Cancel',
    saved: 'Noted.',
    failed: (reason: string) => `Could not save: ${reason}`,
  },
  zh: {
    open: '找不到工单？',
    placeholder: '你没找到什么？',
    label: '你没找到的东西',
    send: '发送',
    sending: '正在发送…',
    cancel: '取消',
    saved: '已记下。',
    failed: (reason: string) => `没有记下：${reason}`,
  },
});
