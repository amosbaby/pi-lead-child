// Lead 正在跑一轮时，用户发来的消息放在哪里（工单 04 的插话和排队，lead-tools-and-routing spec D16）。
// 2026-10-27 21:05：Lead 在一个读了 Slack 的跟进轮次里，用户说「1 分钟后提醒我」。消息被插进那一轮，那一轮的外部标记
// 按 pi 的一次运行算，于是用户本人的话也被当成外部的一轮：设提醒被拒，Lead 只能请用户「随便再发一条」。
// 那时起：这一轮带着外部内容时，用户的消息不插进去，也不交给 pi 的 followUp（它和这一轮在同一次运行里），而是等这一轮
// 结束，由 daemon 开一轮只属于用户的（carryOverTurns）。那一轮的来历是干净的。
// 2026-11-03（用户采纳）：这条只管不是用户本人开的一轮（外部消息、系统事件、到点的跟进叫醒的），和插进了外部消息原文的一轮。
// 用户本人开的一轮只读了连接、对话的结果时，用户的话照常插进去或排队：那天用户在 Lead 读 GitHub 的一轮里发了两条纠正，
// 都等到这一轮做完才送到，Lead 已经照旧计划派了执行者。用户本人正在说话，改规则本来就不受这一轮读过的内容限制
// （authority.ts 的 isLiveUserTurn）；写进系统提示词的设置照样拒绝。
export type UserMessagePlacement = "start" | "steer" | "follow_up" | "own_turn_after";

export function userMessagePlacement(input: {
  busy: boolean;
  // 正在跑的这一轮是不是带着外部内容（turn-origin.ts 的 external）。
  external: boolean;
  // 正在跑的这一轮是不是用户本人的消息开的（不是外部消息、系统事件、到点的跟进叫醒的）。
  ownUserTurn: boolean;
  // 这一轮里有没有外部消息的原文（叫醒它的，或者插进来的外部事件）。只读了连接、对话的结果不算。
  externalMessage: boolean;
  // 用户选了「排队」。
  followUp: boolean;
}): UserMessagePlacement {
  if (!input.busy) return "start";
  if (input.external && (!input.ownUserTurn || input.externalMessage)) return "own_turn_after";
  return input.followUp ? "follow_up" : "steer";
}
