// 网页看台账（.scratch/external-worker-hub/spec.md P1-2、P1-7）：列表上每张单的处理方式、复杂度、领取人和来源标签（ticketMeta），
// 详情里的来源、会话和判断理由（ticketLinks）。只读，入口是网关的 ticket-links-routes.ts（tickets:view）。
//   - 来源：子工单自己没有来源时用根工单的（来源记在建单的那张根工单上）。
//   - idleHours：领着它的工人多少个整小时没动静。动静是领取、挂会话、进展笔记（worker_report）里最晚的一次。
//     手动领的单没有租约，网页按它写「N 小时无动静」，给释放按钮（ticket.release）。
//   - sessions：这张单所有外部 Run 挂过的会话，最近一次领取的在前，同一个链接或 id 只给一次。
import { EXTERNAL_RUNTIME_ID, ticketSourceLabel, type TicketLinks, type TicketMeta } from "@pi-lead-child/protocol";
import { getItem, ticketSources, type Db, type TicketComplexity, type TicketHandling, type TicketSource } from "@pi-lead-child/store";
import { TicketActionError } from "../ticket-actions/types.js";
import { openWorkerClaim, WORKER_REPORT_ROUTE } from "./claim.js";
import { parseMetadata } from "../pipeline/run-registration.js";

const HOUR_MS = 3_600_000;

// 库里的时间有两种写法：datetime('now') 的「2026-11-12 06:00:00」（UTC，没有时区）和 ISO。
function timeOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const at = Date.parse(normalized);
  return Number.isFinite(at) ? at : null;
}

/** 这张单的来源；自己没有时是根工单的。 */
export function effectiveTicketSources(db: Db, itemId: number): TicketSource[] {
  const own = ticketSources(db, itemId);
  if (own.length > 0) return own;
  const item = getItem(db, itemId);
  const rootId = item?.root_item_id ?? null;
  return rootId !== null && rootId !== itemId ? ticketSources(db, rootId) : [];
}

function idleHoursOf(db: Db, itemId: number, now: Date): Pick<TicketMeta, "claimedBy" | "claimMode" | "idleHours"> {
  const claim = openWorkerClaim(db, itemId);
  if (!claim) return { claimedBy: null, claimMode: null, idleHours: null };
  const lastActivity = db.prepare(
    `SELECT MAX(created_at) AS at FROM activities
     WHERE run_id=? AND kind='comment' AND json_valid(payload) AND json_extract(payload, '$.route')=?`,
  ).get(claim.runId, WORKER_REPORT_ROUTE) as { at: string | null };
  const times = [claim.claimedAt, lastActivity.at, ...claim.sessions.map((session) => session.attachedAt)]
    .map(timeOf)
    .filter((at): at is number => at !== null);
  const last = times.length > 0 ? Math.max(...times) : null;
  const idleHours = last === null ? null : Math.max(0, Math.floor((now.getTime() - last) / HOUR_MS));
  return { claimedBy: claim.workerName, claimMode: claim.claimMode, idleHours };
}

/** 列表上的事实。不存在的编号不出现在结果里；顺序按给的编号。 */
export function ticketMeta(db: Db, ids: readonly number[], now: Date = new Date()): TicketMeta[] {
  const judgment = db.prepare("SELECT handling, complexity FROM items WHERE id=?");
  return [...new Set(ids)].flatMap((id): TicketMeta[] => {
    const row = judgment.get(id) as { handling: TicketHandling | null; complexity: TicketComplexity | null } | undefined;
    if (!row) return [];
    const first = effectiveTicketSources(db, id)[0];
    return [{
      id,
      handling: row.handling,
      complexity: row.complexity,
      ...idleHoursOf(db, id, now),
      sourceLabel: first ? ticketSourceLabel(first) : null,
    }];
  });
}

/** 详情里的来源、会话和判断理由。工单不存在时抛 not_found。 */
export function ticketLinks(db: Db, itemId: number): TicketLinks {
  const row = db.prepare("SELECT handling_reason FROM items WHERE id=?").get(itemId) as { handling_reason: string | null } | undefined;
  if (!row) throw new TicketActionError("not_found", `工单 #${itemId} 不存在`);
  const runs = db.prepare("SELECT metadata FROM runs WHERE item_id=? AND runtime=? ORDER BY id DESC")
    .all(itemId, EXTERNAL_RUNTIME_ID) as Array<{ metadata: string | null }>;
  const seen = new Set<string>();
  const sessions: TicketLinks["sessions"] = [];
  for (const run of runs) {
    const metadata = parseMetadata(run.metadata ?? "{}");
    const attached = Array.isArray(metadata.sessions) ? metadata.sessions as Array<{ url?: unknown; sessionId?: unknown }> : [];
    for (const session of attached) {
      const url = typeof session.url === "string" ? session.url : null;
      const sessionId = typeof session.sessionId === "string" ? session.sessionId : null;
      if (url === null && sessionId === null) continue;
      const key = `${url ?? ""}\u0000${sessionId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sessions.push({ url, sessionId });
    }
  }
  return {
    sources: effectiveTicketSources(db, itemId),
    sessions,
    handlingReason: row.handling_reason,
  };
}
