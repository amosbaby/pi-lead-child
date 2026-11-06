// 会话卡片上做成了的按钮（工单 #263，protocol 的 surface-actions.ts，表在 schema.ts 的 SURFACE_ACTIONS_SCHEMA）。
import type { SurfaceActionDone, SurfaceActionOrigin } from "@pi-lead-child/protocol";
import type { Db } from "./db.js";

interface SurfaceActionRow {
  call_id: string;
  node_id: string;
  target_type: string;
  target_id: string;
  action: string;
  done_at: string;
}

/** 卡片上的一个按钮做成了：记下来。同一个按钮再做成一次时更新目标、操作和时刻。 */
export function recordSurfaceAction(
  db: Db,
  args: { origin: SurfaceActionOrigin; target: { type: string; id: string | number }; action: string; bindingId?: number | null; now?: Date },
): SurfaceActionDone {
  const at = (args.now ?? new Date()).toISOString();
  db.prepare(
    `INSERT INTO surface_actions (call_id, node_id, target_type, target_id, action, binding_id, done_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (call_id, node_id) DO UPDATE SET
       target_type = excluded.target_type, target_id = excluded.target_id, action = excluded.action,
       binding_id = excluded.binding_id, done_at = excluded.done_at`,
  ).run(args.origin.callId, args.origin.node, args.target.type, String(args.target.id), args.action, args.bindingId ?? null, at);
  return { callId: args.origin.callId, node: args.origin.node, target: { type: args.target.type, id: String(args.target.id) }, action: args.action, at };
}

/** 这些卡片上做成了的按钮，按卡片和节点排。 */
export function listSurfaceActions(db: Db, callIds: readonly string[]): SurfaceActionDone[] {
  const ids = [...new Set(callIds)];
  if (!ids.length) return [];
  const rows = db.prepare(
    `SELECT call_id, node_id, target_type, target_id, action, done_at FROM surface_actions
     WHERE call_id IN (${ids.map(() => "?").join(",")}) ORDER BY call_id, node_id`,
  ).all(...ids) as SurfaceActionRow[];
  return rows.map((row) => ({
    callId: row.call_id, node: row.node_id, target: { type: row.target_type, id: row.target_id }, action: row.action, at: row.done_at,
  }));
}
