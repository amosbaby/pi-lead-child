// Slack 通道设置页上的文字（slack-settings.ts）：令牌的说明、建应用的要点、连上了却一直收不到事件时该查哪里。
// 按用户现在选的语言（daemon 用 getLocale 取）。
import { defineMessages } from "@pi-lead-child/protocol";

export const slackSettingsMessages = defineMessages({
  en: {
    appTokenHint: "In the app, open Basic Information → App-Level Tokens, click Generate Token and Scopes, and add connections:write "
      + "and authorizations:read (when other people also install this app, it tells which messages you can see).",
    userTokenHint: "In the app, open OAuth & Permissions, click Install to Workspace, allow it, then copy the User OAuth Token "
      + "(not the Bot User OAuth Token).",
    // 手建应用时最容易漏的两处（2026-11-02）。
    setupNote: (events: readonly string[]) => "Add the scopes under User Token Scopes, not Bot Token Scopes. "
      + `Subscribe to events on behalf of users must list ${events.join(", ")}. `
      + "After you change scopes or events, click Reinstall to Workspace and paste the new User OAuth Token above.",
    noEvents: (events: readonly string[], scopes: readonly string[]) =>
      "Connected, but no Slack event has come in since you saved the tokens. The app probably does not subscribe to events. "
      + "Open the app on api.slack.com/apps: "
      + `1. Event Subscriptions → Subscribe to events on behalf of users: add ${events.join(", ")}. `
      + `2. OAuth & Permissions → User Token Scopes (not Bot Token Scopes): add ${scopes.join(", ")}. `
      + "3. Click Reinstall to Workspace, copy the new User OAuth Token and save it here again. "
      + "To check: send yourself a direct message in Slack. This warning goes away after any one event comes in, "
      + "so it does not show that all the events above are subscribed.",
  },
  zh: {
    appTokenHint: "在应用的 Basic Information → App-Level Tokens 点 Generate Token and Scopes，加 connections:write 和 authorizations:read"
      + "（别人也装了这个应用时，用它认出哪些消息是你能看到的）。",
    userTokenHint: "在应用的 OAuth & Permissions 点 Install to Workspace，授权以后复制 User OAuth Token（不是 Bot User OAuth Token）。",
    setupNote: (events) => "权限加在 User Token Scopes 里（不是 Bot Token Scopes）。"
      + `Subscribe to events on behalf of users 里要有 ${events.join("、")}。`
      + "改了权限或事件以后，点 Reinstall to Workspace，把新的 User OAuth Token 填在上面。",
    noEvents: (events, scopes) =>
      "已经连上，但存了令牌以后一个 Slack 事件都没收到：应用多半没有订阅事件。在 api.slack.com/apps 打开这个应用："
      + `1. Event Subscriptions → Subscribe to events on behalf of users 里加上 ${events.join("、")}。`
      + `2. OAuth & Permissions → User Token Scopes（不是 Bot Token Scopes）里加上 ${scopes.join("、")}。`
      + "3. 点 Reinstall to Workspace，复制新的 User OAuth Token，在这里重新保存。"
      + "验证：在 Slack 里给自己发一条私信。收到任何一个事件后这条提醒就会消失，所以它消失不代表上面的事件都订阅好了。",
  },
});
