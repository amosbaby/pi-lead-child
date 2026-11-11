import { Type, type Static } from "typebox";

export const KernelRuntimeIdSchema = Type.Union([
  Type.Literal("pi"), Type.Literal("codex"), Type.Literal("claude"),
]);
export type KernelRuntimeId = Static<typeof KernelRuntimeIdSchema>;

// 执行器：能选来跑工单的 runtime。设置页、选择列表和请求里的 runtime 都只认它们。
export const KERNEL_RUNTIME_IDS: readonly KernelRuntimeId[] = ["pi", "codex", "claude"];

// 外部工人领单时建的 Run 记成这个 runtime（执行模式 external，engine 的 execution-mode.ts）。daemon 不为它起进程。
// 它不是执行器：不进 KERNEL_RUNTIME_IDS，所以选 runtime 的请求、设置页和选择列表都不认它。
// 描述已有 Run 的字段（Run、检查点的作者、续接的会话、重检结果）用 RunRuntimeIdSchema，认得它。
export const EXTERNAL_RUNTIME_ID = "external" as const;
export const RunRuntimeIdSchema = Type.Union([KernelRuntimeIdSchema, Type.Literal(EXTERNAL_RUNTIME_ID)]);
export type RunRuntimeId = Static<typeof RunRuntimeIdSchema>;
