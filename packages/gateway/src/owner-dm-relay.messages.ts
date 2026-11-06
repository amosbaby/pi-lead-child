// 同步到用户 Slack 私信的话（工单 #88）里系统加的那一句：卡片在 Slack 里显示不了，附在卡的 fallback_text 后面。
// 按写的时候用户选的语言写（store 的 getLocale）。
import { defineMessages } from "@pi-lead-child/protocol";

export const ownerDmRelayMessages = defineMessages({
  en: {
    detailsInApp: "Details are in the App.",
  },
  zh: {
    detailsInApp: "详情在 App 里看。",
  },
});
