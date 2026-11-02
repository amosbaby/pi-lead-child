// Slack 通道的设置页提醒（slack-settings.ts）：连上了却一直收不到事件时该查哪里。按用户现在选的语言（daemon 用 getLocale 取）。
import { defineMessages } from "@pi-lead-child/protocol";

export const slackSettingsMessages = defineMessages({
  en: {
    noEvents: (events: readonly string[], scopes: readonly string[]) =>
      "Connected, but no Slack event has come in since you saved the tokens. The app probably does not subscribe to events. "
      + "Open the app on api.slack.com/apps: "
      + `1. Event Subscriptions → Subscribe to events on behalf of users: add ${events.join(", ")}. `
      + `2. OAuth & Permissions → User Token Scopes (not Bot Token Scopes): add ${scopes.join(", ")}. `
      + "3. Click Reinstall to Workspace, copy the new User OAuth Token and save it here again. "
      + "To check: send yourself a direct message in Slack. This warning goes away when the event comes in.",
  },
  zh: {
    noEvents: (events, scopes) =>
      "已经连上，但存了令牌以后一个 Slack 事件都没收到：应用多半没有订阅事件。在 api.slack.com/apps 打开这个应用："
      + `1. Event Subscriptions → Subscribe to events on behalf of users 里加上 ${events.join("、")}。`
      + `2. OAuth & Permissions → User Token Scopes（不是 Bot Token Scopes）里加上 ${scopes.join("、")}。`
      + "3. 点 Reinstall to Workspace，复制新的 User OAuth Token，在这里重新保存。"
      + "验证：在 Slack 里给自己发一条私信，收到以后这条提醒就消失。",
  },
});
