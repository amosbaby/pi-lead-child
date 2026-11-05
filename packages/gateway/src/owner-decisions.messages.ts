// 用户自己私信里的决定请求消息（工单 #81）的文字：和 App 里的决定卡同样的问题、选项和状态，
// 按写的时候用户选的语言写（store 的 getLocale）。
import { defineMessages } from "@pi-lead-child/protocol";

export const ownerDecisionMessages = defineMessages({
  en: {
    title: (ticket: number, ticketTitle: string) => `#${ticket} ${ticketTitle}: needs your decision`,
    separator: ": ",
    option: (label: string, consequence: string) => `• ${label}: ${consequence}`,
    recommended: (label: string, reason: string | null) => `Recommended: ${label}${reason ? `. ${reason}` : ""}`,
    recommendedTag: "Recommended",
    choose: "Choose",
    placeholder: "Choose one",
    writeInApp: "This one needs a written answer. Answer it in the App.",
    customInApp: "To write your own answer instead, use the App.",
    states: { pending: "Waiting for you", resolved: "Decided", dismissed: "Dismissed", expired: "Expired" },
    selected: (label: string) => `Chose "${label}"`,
    answered: (text: string) => `Answered: ${text}`,
    dismissed: (reason: string | null) => (reason ? `Dismissed: ${reason}` : "Dismissed."),
    expired: "No answer. The request expired.",
  },
  zh: {
    title: (ticket, ticketTitle) => `#${ticket} ${ticketTitle}：要你决定`,
    separator: "：",
    option: (label, consequence) => `• ${label}：${consequence}`,
    recommended: (label, reason) => `推荐：${label}${reason ? `。${reason}` : ""}`,
    recommendedTag: "推荐",
    choose: "选这个",
    placeholder: "选一个",
    writeInApp: "这条要你写回答，去 App 里回答。",
    customInApp: "想自己写回答的话，去 App 里写。",
    states: { pending: "等你决定", resolved: "已决定", dismissed: "不处理", expired: "已过期" },
    selected: (label) => `选了「${label}」`,
    answered: (text) => `回答：${text}`,
    dismissed: (reason) => (reason ? `不处理：${reason}` : "不处理。"),
    expired: "没有回答，过期了。",
  },
});
