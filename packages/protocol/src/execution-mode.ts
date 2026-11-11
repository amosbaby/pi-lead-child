// 执行模式（.scratch/external-worker-hub/spec.md P1-1）的线上契约。
// - self（缺省，原来的样子）：daemon 自己起执行者跑工单。
// - external：daemon 不起执行者。会建 Run 的路径都改成不建：工单留在 ready，等外部工人（Claude Code，以后 Codex）领走。
// - paused：总闸。不派发，也不让外部工人领单。
// - 存在 plc.db 的 kv（execution.mode），一行 JSON：{ mode }。没有、或者坏了时按 self 算（engine 的 execution-mode.ts）。
// - 切换是操作层的 execution_mode.set（user_direct、改规则、记账本）：只有用户本人能在页面上切，Lead 调它总是被拒绝。
// - 正在跑的 Run 不受切换影响。
// 这个文件不 import index.ts（index.ts 从这里 re-export，反过来会循环）。
import { Type, type Static, type TProperties } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const EXECUTION_MODES = ["self", "external", "paused"] as const;
export const ExecutionModeSchema = Type.Union([Type.Literal("self"), Type.Literal("external"), Type.Literal("paused")]);
export type ExecutionMode = typeof EXECUTION_MODES[number];
export const DEFAULT_EXECUTION_MODE: ExecutionMode = "self";

export const ExecutionModeDtoSchema = StrictObject({ mode: ExecutionModeSchema });
export type ExecutionModeDto = Static<typeof ExecutionModeDtoSchema>;

export const ExecutionModeResponseSchema = StrictObject({ executionMode: ExecutionModeDtoSchema });
export type ExecutionModeResponse = Static<typeof ExecutionModeResponseSchema>;

// execution_mode.set 的输入（POST /v1/execution-mode 的请求体）。
export const SetExecutionModeRequestSchema = StrictObject({ mode: ExecutionModeSchema });
export type SetExecutionModeRequest = Static<typeof SetExecutionModeRequestSchema>;

// 建 Run 之前的闸门推迟了一次启动时，工单上记的那条活动（kind='decision'，payload.decision 是它）。
// activities.kind 有 CHECK 约束，新 kind 会让旧库写不进去，所以和别的系统决定一样记成 decision。
export const EXECUTION_DEFERRED_DECISION = "execution_deferred";
