// 用户自己私信里的确认消息（工单 #72）的文字：和 App 里的确认卡同样的标题、名字和状态（companion 的 genui.messages.ts），
// 按写的时候用户选的语言写（store 的 getLocale）。
import { defineMessages } from "@pi-lead-child/protocol";

export const ownerConfirmationMessages = defineMessages({
  en: {
    confirm: "Confirm this one time",
    decline: "Do not change",
    separator: ": ",
    ruleChange: {
      title: (leadName: string, label: string) => `${leadName} wants to: ${label}`,
      target: "Target",
      reason: "Reason",
      blocked: "Blocked",
      states: { pending: "Waiting for you", running: "Running", done: "Done", failed: "Failed", declined: "Not changed", expired: "Expired" },
      running: "You confirmed. It is running.",
      declined: 'You selected "Do not change". The rule stays the same.',
      expired: (leadName: string) => `No decision. The request expired and the rule stays the same. To change it, ask ${leadName} again.`,
    },
    connection: {
      title: (label: string) => `${label} · Write confirmation`,
      summary: "What",
      states: { pending: "Waiting for you", running: "Running", done: "Done", failed: "Failed", rejected: "Rejected", expired: "Expired" },
      running: "You confirmed. It is running.",
      rejected: 'You selected "Do not change". Nothing was written.',
      expired: "No decision. The request expired and nothing was written.",
    },
  },
  zh: {
    confirm: "确认这一次",
    decline: "不改",
    separator: "：",
    ruleChange: {
      title: (leadName, label) => `${leadName} 要${label}`,
      target: "对象",
      reason: "原因",
      blocked: "被拦",
      states: { pending: "等你确认", running: "正在执行", done: "已执行", failed: "执行失败", declined: "没有改", expired: "已过期" },
      running: "你确认了，正在执行。",
      declined: "你点了「不改」，规则照旧。",
      expired: (leadName) => `没有决定，过期作废了，规则照旧。要改的话请 ${leadName} 再提一次。`,
    },
    connection: {
      title: (label) => `${label} · 写入确认`,
      summary: "要做什么",
      states: { pending: "等你确认", running: "正在执行", done: "已执行", failed: "执行失败", rejected: "已作废", expired: "已过期" },
      running: "你确认了，正在执行。",
      rejected: "你点了「不改」，没有写入。",
      expired: "没有决定，过期作废了，没有写入。",
    },
  },
});
