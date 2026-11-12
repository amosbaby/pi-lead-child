// 外部工人 hub 的指标（计划 Task 14）：S1 成没成功看这几个数。
//   - 来源链接覆盖率：工单有没有带链接的来源（用户能不能从列表找回「这张单是从哪来的」）。
//   - 会话链接覆盖率：工单有没有会话链接（外部 Run 的 metadata.sessions 里有 url 或 sessionId）。
//   - 领取中位时长：工单建好到第一次被外部工人领走，分钟。
//   - 「找不到」次数：用户说过几次没找到东西（ticket_misses）。
//
// 口径（ruling R27、R32）：分母只数该有来源的根工单，会话和领取看整棵树：
//   - 分母是窗口内（created_at >= since）建的 kind='task'、没有 parent_item_id 的工单。提醒不是工单；子单的来源是从根单继承的
//     （Task 7b），数子单会把同一个来源算多次，还把 Lead 自己拆出来的活算进「用户找不到」的分母。
//   - 分母里再去掉（R32）：轻工单（light_task 标记，后台检查开的也带 watch_check）；规则（trigger，活动里的 from_trigger）和
//     续作（continuations.context.createdTickets）建的单；用户自己在页面（App、plc，经 POST /v1/tickets，created_by='user'）
//     建的单。这些单天生没有外部来源。工人从自己会话 track 的单也是 created_by='user'，但它是 hub 的活，留在分母里
//     （worker_tracked 标记）。会话覆盖率和领取时长用同一个分母。
//   - 来源：这张根单自己有带 url 或 external_key 的 ticket_sources 行（子单继承它的，不看子单）。没有链接的来源（v68 回填的
//     Slack 来源、私信里的来源）找不回去，不算。
//   - 会话：这张根单或它的任何后代有 runtime=external 的 Run，其中有一条会话带 url 或 sessionId。工人可以领 Lead 拆出的子单
//     （claim 和队列不过滤 parent），只看根单自己会让这样的根永远是「没会话」「没被领」。
//   - 领取时长：整棵树里最早的外部 Run 的 started_at（Run 的创建时间）减去根单的 created_at；整棵树都没被领过的不进中位数；
//     时钟回拨造成的负数按 0 算。
//   - 「找不到」：misses 只数用户自己说的（by='user'），Lead 调操作记的单独成 leadMisses，不进 misses。
//   - 没有工单时覆盖率是 0、中位数是 null，不是 1：调用方（plc hub metrics）按 tickets=0 写「没有数据」。
// 时间两种写法都认：SQLite 的 datetime('now')（YYYY-MM-DD HH:MM:SS，UTC）和 ISO。
import { EXTERNAL_RUNTIME_ID } from "@pi-lead-child/protocol";
import type { Db } from "./db.js";
import { LIGHT_TASK_DECISION } from "./light-tasks.js";
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
  leadMisses: number;
}

interface RootRow { id: number; created_at: string; has_source: number }
interface ExternalRunRow { root_id: number; started_at: string; metadata: string }

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

// 进分母的根工单（表的别名是 i；一个 ? 参数：since）。口径见文件头（R27、R32）。
const COUNTED_ROOT = `i.kind = 'task' AND i.parent_item_id IS NULL AND datetime(i.created_at) >= datetime(?)
  AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.item_id = i.id AND a.kind = 'decision' AND json_valid(a.payload)
                    AND json_extract(a.payload, '$.decision') IN ('${LIGHT_TASK_DECISION}', 'watch_check'))
  AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.item_id = i.id AND json_valid(a.payload)
                    AND json_extract(a.payload, '$.from_trigger') IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM continuations c, json_each(c.context, '$.createdTickets') t
                   WHERE json_valid(c.context) AND t.value = i.id)
  AND NOT (i.created_by = 'user' AND NOT EXISTS (
    SELECT 1 FROM activities a WHERE a.item_id = i.id AND a.kind = 'decision' AND json_valid(a.payload)
      AND json_extract(a.payload, '$.decision') = 'worker_tracked'))`;

export function hubMetrics(db: Db, since: Date): HubMetrics {
  const roots = db.prepare(
    `SELECT i.id AS id, i.created_at AS created_at,
            EXISTS (SELECT 1 FROM ticket_sources s WHERE s.item_id = i.id
                      AND ((s.url IS NOT NULL AND s.url <> '') OR (s.external_key IS NOT NULL AND s.external_key <> ''))) AS has_source
       FROM items i
      WHERE ${COUNTED_ROOT}`,
  ).all(since.toISOString()) as RootRow[];
  // 每张进分母的根单，连同它的所有后代；这棵树上的外部 Run。
  const runs = db.prepare(
    `WITH RECURSIVE tree(root_id, item_id) AS (
       SELECT i.id, i.id FROM items i WHERE ${COUNTED_ROOT}
       UNION ALL
       SELECT tree.root_id, i.id FROM items i JOIN tree ON i.parent_item_id = tree.item_id
     )
     SELECT tree.root_id AS root_id, r.started_at AS started_at, r.metadata AS metadata
       FROM tree JOIN runs r ON r.item_id = tree.item_id
      WHERE r.runtime = ?
      ORDER BY r.id`,
  ).all(since.toISOString(), EXTERNAL_RUNTIME_ID) as ExternalRunRow[];

  const firstClaim = new Map<number, number>();
  const withSessionIds = new Set<number>();
  for (const run of runs) {
    const startedAt = timestampEpoch(run.started_at);
    if (startedAt !== null) {
      const earliest = firstClaim.get(run.root_id);
      if (earliest === undefined || startedAt < earliest) firstClaim.set(run.root_id, startedAt);
    }
    if (hasSessionLink(run.metadata)) withSessionIds.add(run.root_id);
  }

  const claimMinutes: number[] = [];
  for (const root of roots) {
    const to = firstClaim.get(root.id);
    const from = timestampEpoch(root.created_at);
    if (to === undefined || from === null) continue;
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
    misses: missesSince(db, since, "user"),
    leadMisses: missesSince(db, since, "lead"),
  };
}
