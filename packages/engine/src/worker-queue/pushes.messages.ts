// 「待你处理」推送（pushes.ts）的文字：推到用户自己私信的那条消息和桌面通知，按写的时候用户选的语言写（store 的 getLocale，
// 和私信里的决定请求一样）。工单标题、理由、工人名字由 pushes.ts 先处理成纯文字再放进来。
import { defineMessages } from "@pi-lead-child/protocol";

export const ticketPushMessages = defineMessages({
  en: {
    headline: {
      needs_user: (ticket: string) => `Needs you: ${ticket}`,
      handed_back: (ticket: string, worker: string | null) => `${worker ?? "The worker"} handed it back to you: ${ticket}`,
      claimed: (ticket: string, worker: string | null) => `${worker ?? "A worker"} took it: ${ticket}`,
      in_review: (ticket: string) => `Waiting for your review: ${ticket}`,
      done: (ticket: string) => `Done: ${ticket}`,
      cancelled: (ticket: string) => `Cancelled: ${ticket}`,
      cleared: (ticket: string) => `No longer needs you: ${ticket}`,
    },
    reason: (reason: string) => `Why: ${reason}`,
    source: "Source",
    ticket: "Open the ticket",
    session: "Open in Claude Code",
  },
  zh: {
    headline: {
      needs_user: (ticket) => `待你处理：${ticket}`,
      handed_back: (ticket, worker) => `${worker ?? "工人"}交回给你了：${ticket}`,
      claimed: (ticket, worker) => `${worker ?? "工人"}领走了：${ticket}`,
      in_review: (ticket) => `等你验收：${ticket}`,
      done: (ticket) => `已完成：${ticket}`,
      cancelled: (ticket) => `已取消：${ticket}`,
      cleared: (ticket) => `不用你处理了：${ticket}`,
    },
    reason: (reason) => `原因：${reason}`,
    source: "来源",
    ticket: "打开工单",
    session: "在 Claude Code 打开",
  },
});
