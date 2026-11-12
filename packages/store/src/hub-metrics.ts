// 外部工人 hub 的指标（计划 Task 14）：S1 成没成功看这几个数。
//   - 来源链接覆盖率：工单有没有 ticket_sources（用户能不能从列表找回「这张单是从哪来的」）。
//   - 会话链接覆盖率：工单有没有会话链接（外部 Run 的 metadata.sessions 里有 url 或 sessionId）。
//   - 领取中位时长：工单建好到第一次被外部工人领走，分钟。
//   - 「找不到」次数：用户说过几次没找到东西（ticket_misses）。
//
// 口径（只数根工单，每张单看它自己）：
//   - 分母是窗口内（created_at >= since）建的 kind='task'、没有 parent_item_id 的工单。提醒不是工单；子单的来源是从根单继承的
//     （Task 7b），数子单会把同一个来源算多次，还把 Lead 自己拆出来的活算进「用户找不到」的分母。
//   - 来源：这张单自己有 ticket_sources 行。会话：这张单自己有 runtime=external 的 Run，其中有一条会话带 url 或 sessionId。
//   - 领取时长：这张单第一次外部 Run 的 started_at（Run 的创建时间）减去 items.created_at；没被领过的不进中位数；
//     时钟回拨造成的负数按 0 算。
//   - 没有工单时覆盖率是 0、中位数是 null，不是 1：调用方（plc hub metrics）按 tickets=0 写「没有数据」。
// 时间两种写法都认：SQLite 的 datetime('now')（YYYY-MM-DD HH:MM:SS，UTC）和 ISO。
import { EXTERNAL_RUNTIME_ID } from "@pi-lead-child/protocol";
import type { Db } from "./db.js";
import { timestampEpoch } from "./timing.js";
import { missesSince } from "./worker-hub.js";

export interface HubMetrics {
  tickets: number;
  withSource: number;
  withSession: number;
  sourceCoverage: number;
  sessionCoverage: number;
  medianClaimMinutes: number | null;
  misses: number;
}

interface RootRow { id: number; created_at: string; has_source: number }
interface ExternalRunRow { item_id: number; started_at: string; metadata: string }

function hasSessionLink(metadata: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return false;
  }
  const sessions = (parsed as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(sessions)) return false;
  return sessions.some((session) => {
    const entry = session as { url?: unknown; sessionId?: unknown } | null;
    return (typeof entry?.url === "string" && entry.url !== "") || (typeof entry?.sessionId === "string" && entry.sessionId !== "");
  });
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function hubMetrics(db: Db, since: Date): HubMetrics {
  const roots = db.prepare(
    `SELECT i.id AS id, i.created_at AS created_at,
            EXISTS (SELECT 1 FROM ticket_sources s WHERE s.item_id = i.id) AS has_source
       FROM items i
      WHERE i.kind = 'task' AND i.parent_item_id IS NULL AND datetime(i.created_at) >= datetime(?)`,
  ).all(since.toISOString()) as RootRow[];
  const runs = db.prepare(
    `SELECT r.item_id AS item_id, r.started_at AS started_at, r.metadata AS metadata
       FROM runs r JOIN items i ON i.id = r.item_id
      WHERE r.runtime = ? AND i.kind = 'task' AND i.parent_item_id IS NULL AND datetime(i.created_at) >= datetime(?)
      ORDER BY r.id`,
  ).all(EXTERNAL_RUNTIME_ID, since.toISOString()) as ExternalRunRow[];

  const firstClaim = new Map<number, string>();
  const withSessionIds = new Set<number>();
  for (const run of runs) {
    if (!firstClaim.has(run.item_id)) firstClaim.set(run.item_id, run.started_at);
    if (hasSessionLink(run.metadata)) withSessionIds.add(run.item_id);
  }

  const claimMinutes: number[] = [];
  for (const root of roots) {
    const claimedAt = firstClaim.get(root.id);
    if (claimedAt === undefined) continue;
    const from = timestampEpoch(root.created_at);
    const to = timestampEpoch(claimedAt);
    if (from === null || to === null) continue;
    claimMinutes.push(Math.max(0, to - from) / 60_000);
  }

  const tickets = roots.length;
  const withSource = roots.filter((root) => root.has_source === 1).length;
  const withSession = roots.filter((root) => withSessionIds.has(root.id)).length;
  return {
    tickets, withSource, withSession,
    sourceCoverage: tickets === 0 ? 0 : withSource / tickets,
    sessionCoverage: tickets === 0 ? 0 : withSession / tickets,
    medianClaimMinutes: median(claimMinutes),
    misses: missesSince(db, since),
  };
}
