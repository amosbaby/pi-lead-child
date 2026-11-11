// 执行模式和建 Run 之前的闸门（.scratch/external-worker-hub/spec.md P1-1，protocol 的 execution-mode.ts）。
// - 模式存在 kv 的 execution.mode，一行 JSON：{ mode }。没有、或者坏了（手改、截断）时按 self 算，不抛错。
// - 切换是操作层的 execution_mode.set（ui-actions/execution-mode.ts）：user_direct、改规则、记账本。
// - 闸门 deferIfExternal：每个会建 Run 的入口在建 Run 之前调用一次（入口的清单见 Task 5 的报告和
//   apps/daemon/test/external-mode-dispatch.integration.test.ts）。模式不是 self 时它返回 true：入口不建 Run、不起进程，
//   工单的 stage 不动（从 ready 来的留在 ready，等外部工人领走），工单上记一条 execution_deferred。
//   闸门不改 stage：系统没有把执行中、阻塞的工单送回 ready 的边（protocol 的 stages.ts），外部工人领单也认 blocked 的单。
// - 正在跑的 Run 不受切换影响：闸门只管新的启动，不碰已经在跑的 Run。
import {
  DEFAULT_EXECUTION_MODE, EXECUTION_DEFERRED_DECISION, EXECUTION_MODES, type ExecutionMode,
} from "@pi-lead-child/protocol";
import { addActivity, type Db } from "@pi-lead-child/store";

export { EXECUTION_DEFERRED_DECISION };

export const EXECUTION_MODE_KEY = "execution.mode";

// 用户去哪里切。Lead 调 execution_mode.set 被拒时，拒绝里写它。设置页还没有这一项，所以写网关的路由。
export const EXECUTION_MODE_WHERE = "执行模式（网关的 POST /v1/execution-mode，只有用户本人能切）";

const isExecutionMode = (value: unknown): value is ExecutionMode =>
  typeof value === "string" && (EXECUTION_MODES as readonly string[]).includes(value);

/** 现在的执行模式。没有存过、或者存的值坏了时是 self。 */
export function getExecutionMode(db: Db): ExecutionMode {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(EXECUTION_MODE_KEY) as { value: string } | undefined;
  if (!row) return DEFAULT_EXECUTION_MODE;
  try {
    const parsed = JSON.parse(row.value) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const mode = (parsed as { mode?: unknown }).mode;
      if (isExecutionMode(mode)) return mode;
    }
  } catch {
    // 坏了的值按 self 算。
  }
  return DEFAULT_EXECUTION_MODE;
}

export interface ExecutionModeChange {
  mode: ExecutionMode;
  // 这次有没有改：和原来一样时不写。
  changed: boolean;
}

/** 写执行模式。授权由操作层（execution_mode.set）做过；测试直接调它。和原来一样时什么也不写。 */
export function setExecutionMode(db: Db, mode: ExecutionMode): ExecutionModeChange {
  if (!isExecutionMode(mode)) throw new Error(`unknown execution mode '${String(mode)}'`);
  if (getExecutionMode(db) === mode) return { mode, changed: false };
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(EXECUTION_MODE_KEY, JSON.stringify({ mode }));
  return { mode, changed: true };
}

// 推迟了一次启动时给 Lead 和日志的一句话。界面上给用户看的话在 execution-mode.messages.ts。
export function executionDeferredNote(mode: ExecutionMode, itemId: number): string {
  return mode === "paused"
    ? `执行模式是 paused（总闸）：工单 #${itemId} 没有启动执行者，也不会被外部工人领走，等用户切回 self 或 external。`
    : `执行模式是 external：工单 #${itemId} 没有启动执行者，留在队列里等外部工人领走。`;
}

/** 闸门推迟了一次要建 Run 的启动。入口的返回值必须是一个 Run 时（恢复、工单对话）抛它。 */
export class ExecutionDeferredError extends Error {
  constructor(readonly itemId: number, readonly mode: ExecutionMode, readonly reason: string) {
    super(executionDeferredNote(mode, itemId));
    this.name = "ExecutionDeferredError";
  }
}

/**
 * 建 Run 之前的闸门。模式是 self 时返回 false，什么也不写。不是 self 时返回 true：调用方不建 Run、不起进程；
 * 这里在工单上记一条 execution_deferred（reason 写是哪个入口），不改工单的 stage。
 */
export function deferIfExternal(db: Db, itemId: number, reason: string): boolean {
  const mode = getExecutionMode(db);
  if (mode === "self") return false;
  addActivity(db, {
    itemId, actor: "system", kind: "decision",
    payload: { decision: EXECUTION_DEFERRED_DECISION, mode, reason },
  });
  return true;
}

/** 同 deferIfExternal，推迟时抛 ExecutionDeferredError。给返回值必须是一个 Run 的入口用。 */
export function assertNotDeferred(db: Db, itemId: number, reason: string): void {
  if (deferIfExternal(db, itemId, reason)) throw new ExecutionDeferredError(itemId, getExecutionMode(db), reason);
}
