// 会话里 daemon 自己写的通知的标签和 blocker 一行（system-turns.ts）。界面按用户的语言取；plc chat 和 daemon 暂时取 zh。
import { defineMessages } from "./i18n.ts";

export const systemTurnMessages = defineMessages({
  en: {
    blockerNotice: "System notice · blocker",
    fallbackNotice: "System notice",
    ownerAction: "System notice · owner action",
    securityAlert: "System notice · security",
    contextNotice: "System notice · context",
    blockerSomewhere: (reason: string) => `Something is blocked: ${reason}`,
    blockerOnTicket: (itemId: number, reason: string) => `Ticket #${itemId} is blocked: ${reason}`,
  },
  zh: {
    blockerNotice: "系统通知 · blocker",
    fallbackNotice: "系统通知",
    ownerAction: "系统通知 · 主人操作",
    securityAlert: "系统通知 · 安全",
    contextNotice: "系统通知 · 上下文",
    blockerSomewhere: (reason) => `有一处阻塞：${reason}`,
    blockerOnTicket: (itemId, reason) => `工单 #${itemId} 卡住了：${reason}`,
  },
});
