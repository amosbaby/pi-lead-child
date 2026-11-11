// 在沙箱外跑过的命令（docs/ticket-246-user-turn-bypass.md 5.5，实施单 C）。每一条都写两条事件：spawn 之前写
// host_command.started，进程结束以后写 host_command.finished。分开写：daemon 中途崩溃时至少留着「开始跑了」。
// 三条路都写：免沙箱开关开着时 Lead 的 bash（via bash）、免沙箱时 run_on_host 直接跑（via run_on_host）、用户在确认卡上
// 点了「确认这一次」以后跑的 run_on_host（turnOrigin confirmed_card，带 confirmationId）。这样「所有在沙箱外跑过的命令」
// 一条查询就能列出来；rule_change.executed 照旧写。
// 这个文件不 import index.ts（index.ts 从这里 re-export，反过来会循环）。
import { Type, type Static, type TSchema } from "typebox";
import { registerEventKind, type EventKindDefinition } from "./events.ts";

const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const HOST_COMMAND_STARTED_KIND = "host_command.started";
export const HOST_COMMAND_FINISHED_KIND = "host_command.finished";

/** 事件的对象键：host_command:<编号>。 */
export function hostCommandEntityKey(id: string): string {
  return `host_command:${id}`;
}

// 这条命令凭哪一种一轮在沙箱外跑：用户本人在 Companion、plc、Slack 里给自己发的私信（凭证 origin channel_owner）开的一轮，
// 用户在确认卡上点了「确认这一次」，或者不是用户本人正在发话的一轮（lead_turn：系统事件、跟进到点、外部消息叫醒的一轮。
// 用户 2026-11-11：开关开着时命令在哪一轮都在沙箱外跑，「如果 bypass 都还要我审批，那 bypass 有啥意义呢」）。
export const HOST_COMMAND_TURN_ORIGINS = [
  "live_user_companion", "live_user_plc", "live_user_slack_self_dm", "confirmed_card", "lead_turn",
] as const;
export type HostCommandTurnOrigin = typeof HOST_COMMAND_TURN_ORIGINS[number];
export const HostCommandTurnOriginSchema = Type.Union([
  Type.Literal("live_user_companion"), Type.Literal("live_user_plc"), Type.Literal("live_user_slack_self_dm"), Type.Literal("confirmed_card"),
  Type.Literal("lead_turn"),
]);

// 这一轮带着外部内容时，命令在沙箱外跑之前由决策模型判断一次（lead 的 host-command-judge.ts）。记下判断的结果：
// 命令是不是在办用户交代的事（servesUser）、错了以后难不难撤回（hardToUndo），两个都是 0 到 1 的概率，以及回答的后端。
export const HostCommandJudgementSchema = Type.Object({
  servesUser: Type.Number(),
  hardToUndo: Type.Number(),
  backend: Type.String(),
});
export type HostCommandJudgement = Static<typeof HostCommandJudgementSchema>;

// watch：后台检查的命令到点时在沙箱外跑（lead 的 watch-commands.ts）。
export const HostCommandViaSchema = Type.Union([Type.Literal("bash"), Type.Literal("run_on_host"), Type.Literal("watch")]);
export type HostCommandVia = Static<typeof HostCommandViaSchema>;

// 筛查器的结果（engine 的 host-commands/screen.ts）。在沙箱外跑的命令都是 allow；rule 是只记日志的规则（例如
// command-substitution、delete-outside-roots），没有时为 null。
// 确认卡上的命令不过筛查器（用户看过命令本身），为 null。
export const HostCommandScreenSchema = Type.Object({
  verdict: Type.String({ minLength: 1 }),
  rule: Nullable(Type.String()),
});

export const HostCommandStartedPayloadSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  // 凭哪一轮跑的（channel turn 的编号）。确认卡上跑的、不是用户本人发话的一轮里跑的为 null。
  turnId: Nullable(Type.String()),
  turnOrigin: HostCommandTurnOriginSchema,
  // 这一轮带着的外部内容（外部消息的来源、读到外部内容的工具）。没有时不写。
  externalContent: Type.Optional(Type.Array(Type.String())),
  // 带着外部内容的一轮里，决策模型对这条命令的判断。没有判断时不写。
  judgement: Type.Optional(HostCommandJudgementSchema),
  via: HostCommandViaSchema,
  confirmationId: Nullable(Type.String()),
  // 脱敏后的命令，最多 400 字。
  command: Type.String({ maxLength: 400 }),
  cwd: Type.String(),
  timeoutSeconds: Nullable(Type.Number()),
  screen: Nullable(HostCommandScreenSchema),
  spendsMoney: Type.Boolean(),
});
export type HostCommandStartedPayload = Static<typeof HostCommandStartedPayloadSchema>;

export const HostCommandFinishedPayloadSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  exitCode: Nullable(Type.Integer()),
  timedOut: Type.Boolean(),
  durationMs: Type.Integer({ minimum: 0 }),
  outputPath: Type.String(),
  outputBytes: Type.Integer({ minimum: 0 }),
  truncated: Type.Boolean(),
});
export type HostCommandFinishedPayload = Static<typeof HostCommandFinishedPayloadSchema>;

export const HOST_COMMAND_EVENT_KINDS: readonly EventKindDefinition[] = [
  {
    kind: HOST_COMMAND_STARTED_KIND,
    sources: ["system"],
    payload: HostCommandStartedPayloadSchema,
    description: "一条命令开始在沙箱外跑（免沙箱开关开着，或者用户在确认卡上确认的 run_on_host）。",
  },
  {
    kind: HOST_COMMAND_FINISHED_KIND,
    sources: ["system"],
    payload: HostCommandFinishedPayloadSchema,
    description: "一条在沙箱外跑的命令结束了：退出码、有没有超时、用了多久、输出存在哪里。",
  },
];

for (const definition of HOST_COMMAND_EVENT_KINDS) registerEventKind(definition);
