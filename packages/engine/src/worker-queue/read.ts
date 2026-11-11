// 外部工人读工单（.scratch/external-worker-hub/spec.md P1-5 的 get_ticket、list_tickets）。只读。
//   - workerTicket：只给领走它的工人看（最近一次领取是它的）。来源、Lead 的判断和理由、全部进展笔记、领取以后用户在工单对话里
//     说的话（外部模式下用户的工单消息记成 comment，不路由到任何进程）。
//   - listTickets（ruling R15）：mine 我领着的；needs_me 要用户拿主意的（needs_user，没有活着的外部 Run）；claimable 现在能领的；
//     active 执行中的；recent 最近交付或完成的。needs_me 和 claimable 排序 priority → complexity → 建单时间。
//     每行有标题、来源、状态、处理方式、领取人和会话链接。
import type { Item } from "@pi-lead-child/core";
import {
  AGENT_TASK_DEFERRED, EXTERNAL_RUNTIME_ID, type GrantIntent, type RunGrant, type WorkerSession, type WorkerTicketFilter,
} from "@pi-lead-child/protocol";
import {
  getItem, ticketSources, type Db, type TicketComplexity, type TicketHandling, type TicketSource, type TicketSourceKind,
} from "@pi-lead-child/store";
import { TicketActionError } from "../ticket-actions/types.js";
import { latestWorkerClaim, openWorkerClaim, WORKER_REPORT_ROUTE, type WorkerClaim } from "./claim.js";

const LIST_LIMIT = 50;

interface Judgment {
  handling: TicketHandling | null;
  handlingReason: string | null;
  complexity: TicketComplexity | null;
}

function judgmentOf(db: Db, itemId: number): Judgment {
  const row = db.prepare("SELECT handling, handling_reason, complexity FROM items WHERE id=?").get(itemId) as {
    handling: TicketHandling | null; handling_reason: string | null; complexity: TicketComplexity | null;
  };
  return { handling: row.handling, handlingReason: row.handling_reason, complexity: row.complexity };
}

function contentOf(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as { content?: unknown };
    return typeof parsed.content === "string" ? parsed.content : "";
  } catch {
    return "";
  }
}

export interface WorkerNote {
  at: string;
  text: string;
}

// 派单时算好的权限清单（通道派的单，执行模式不是 self 时只建了工单、没有 Run，清单记在建单的活动里，protocol 的 AGENT_TASK_DEFERRED）。
// 工人照它的范围做：intent 是意图，grant 是清单本身，labels 是给人看的说法，dropped 是超出上限、没有给的部分。
export interface WorkerTicketGrant {
  intent: GrantIntent;
  grant: RunGrant;
  labels: string[];
  dropped: string[];
}

function deferredGrantOf(db: Db, itemId: number): WorkerTicketGrant | null {
  const row = db.prepare(
    `SELECT payload FROM activities WHERE item_id=? AND kind='decision' AND json_valid(payload)
       AND json_extract(payload, '$.decision')=? ORDER BY id DESC LIMIT 1`,
  ).get(itemId, AGENT_TASK_DEFERRED) as { payload: string } | undefined;
  if (!row) return null;
  const payload = JSON.parse(row.payload) as Partial<WorkerTicketGrant>;
  if (!payload.grant || typeof payload.intent !== "string") return null;
  return {
    intent: payload.intent, grant: payload.grant,
    labels: Array.isArray(payload.labels) ? payload.labels : [], dropped: Array.isArray(payload.dropped) ? payload.dropped : [],
  };
}

export interface WorkerTicketView extends Judgment {
  ticketId: number;
  title: string;
  brief: string;
  stage: Item["stage"];
  priority: Item["priority"];
  sources: TicketSource[];
  // 通道派的单的权限清单（见 WorkerTicketGrant）。别的单没有，为 null。
  grant: WorkerTicketGrant | null;
  claim: WorkerClaim;
  // 这张单上全部的进展笔记（worker_report），按时间。
  reports: Array<WorkerNote & { runId: number | null }>;
  // 这次领取以后用户在工单对话里说的话，按时间。
  userMessages: WorkerNote[];
}

/** 领走这张单的工人看它。不是它领的（或者没被领过）时抛 forbidden，工单不存在时抛 not_found。 */
export function workerTicket(db: Db, itemId: number, bindingId: number): WorkerTicketView {
  const item = getItem(db, itemId);
  if (!item) throw new TicketActionError("not_found", `工单 #${itemId} 不存在`);
  const claim = latestWorkerClaim(db, itemId);
  if (!claim || claim.bindingId !== bindingId) throw new TicketActionError("forbidden", `工单 #${itemId} 不是你领的单。`);
  const reports = (db.prepare(
    `SELECT run_id, payload, created_at FROM activities
     WHERE item_id=? AND kind='comment' AND json_valid(payload) AND json_extract(payload, '$.route')=? ORDER BY id`,
  ).all(itemId, WORKER_REPORT_ROUTE) as Array<{ run_id: number | null; payload: string; created_at: string }>)
    .map((row) => ({ at: row.created_at, text: contentOf(row.payload), runId: row.run_id }));
  // 领取以后：这次领取建的外部 Run 的第一条活动之后。
  const userMessages = (db.prepare(
    `SELECT payload, created_at FROM activities
     WHERE item_id=? AND kind='comment' AND actor='user'
       AND id > (SELECT COALESCE(MIN(id), 0) FROM activities WHERE run_id=?)
     ORDER BY id`,
  ).all(itemId, claim.runId) as Array<{ payload: string; created_at: string }>)
    .map((row) => ({ at: row.created_at, text: contentOf(row.payload) }))
    .filter((note) => note.text !== "");
  return {
    ticketId: item.id, title: item.title, brief: item.brief, stage: item.stage, priority: item.priority,
    ...judgmentOf(db, itemId),
    sources: ticketSources(db, itemId),
    grant: deferredGrantOf(db, itemId),
    claim, reports, userMessages,
  };
}

export interface WorkerTicketRow {
  ticketId: number;
  title: string;
  stage: Item["stage"];
  priority: Item["priority"];
  handling: TicketHandling | null;
  complexity: TicketComplexity | null;
  // 来源的种类（slack、jira、notion、manual），去重，按记下的先后。
  sourceKinds: TicketSourceKind[];
  // 现在领着它的工人。没人领着时 null。
  claimedBy: string | null;
  // 现在领着它的那次领取挂的会话。
  sessions: WorkerSession[];
  updatedAt: string;
}

const PRIORITY_RANK = "CASE i.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";
const COMPLEXITY_RANK = "CASE i.complexity WHEN 'simple' THEN 0 WHEN 'medium' THEN 1 WHEN 'complex' THEN 2 ELSE 3 END";
const NO_LIVE_RUN = "NOT EXISTS (SELECT 1 FROM runs r WHERE r.item_id=i.id AND r.state IN ('starting','running'))";
// needs_me（ruling R15）：要用户拿主意的单。工人的 list_tickets 和网页的「要你拿主意」（ticketMeta 的 needsYou，ruling R18）用同一条。
// 一个 ? 参数：EXTERNAL_RUNTIME_ID。表的别名是 i。
const NEEDS_ME = `i.kind='task' AND i.handling='needs_user' AND i.stage NOT IN ('done','cancelled')
  AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.item_id=i.id AND r.runtime=? AND r.state IN ('starting','running'))`;

/** 这张单现在要不要用户拿主意（needs_me 的同一条规则）。不存在的单为 false。 */
export function ticketNeedsMe(db: Db, itemId: number): boolean {
  return db.prepare(`SELECT 1 FROM items i WHERE i.id=? AND ${NEEDS_ME}`).get(itemId, EXTERNAL_RUNTIME_ID) !== undefined;
}

function idsFor(db: Db, filter: WorkerTicketFilter, bindingId: number): number[] {
  const rows = (sql: string, ...params: unknown[]) => (db.prepare(sql).all(...params) as Array<{ id: number }>).map((row) => row.id);
  switch (filter) {
    case "mine":
      return rows(
        `SELECT i.id FROM items i JOIN runs r ON r.item_id=i.id
         WHERE r.runtime=? AND r.state IN ('starting','running') AND json_valid(r.metadata)
           AND json_extract(r.metadata, '$.bindingId')=?
         ORDER BY r.id DESC LIMIT ?`,
        EXTERNAL_RUNTIME_ID, bindingId, LIST_LIMIT,
      );
    case "needs_me":
      return rows(
        `SELECT i.id FROM items i
         WHERE ${NEEDS_ME}
         ORDER BY ${PRIORITY_RANK}, ${COMPLEXITY_RANK}, i.created_at, i.id LIMIT ?`,
        EXTERNAL_RUNTIME_ID, LIST_LIMIT,
      );
    case "claimable":
      // 和 claim.ts 的 claimBlocker 同一个集合（执行模式 paused 时领取照样被拒，这里不看模式）。
      return rows(
        `SELECT i.id FROM items i
         WHERE i.kind='task' AND i.stage IN ('ready','blocked','active') AND ${NO_LIVE_RUN}
         ORDER BY ${PRIORITY_RANK}, ${COMPLEXITY_RANK}, i.created_at, i.id LIMIT ?`,
        LIST_LIMIT,
      );
    case "active":
      return rows(
        "SELECT i.id FROM items i WHERE i.kind='task' AND i.stage='active' ORDER BY i.updated_at DESC, i.id DESC LIMIT ?",
        LIST_LIMIT,
      );
    case "recent":
      return rows(
        `SELECT i.id FROM items i WHERE i.kind='task' AND i.stage IN ('review','done')
         ORDER BY COALESCE(i.stage_changed_at, i.updated_at) DESC, i.id DESC LIMIT ?`,
        LIST_LIMIT,
      );
  }
}

/** 工人的工单列表。bindingId 是调用的工人（mine 用它）。 */
export function listTickets(db: Db, filter: WorkerTicketFilter, bindingId: number): WorkerTicketRow[] {
  return idsFor(db, filter, bindingId).flatMap((id) => {
    const item = getItem(db, id);
    if (!item) return [];
    const { handling, complexity } = judgmentOf(db, id);
    const claim = openWorkerClaim(db, id);
    return [{
      ticketId: item.id, title: item.title, stage: item.stage, priority: item.priority, handling, complexity,
      sourceKinds: [...new Set(ticketSources(db, id).map((source) => source.kind))],
      claimedBy: claim?.workerName ?? null,
      sessions: claim?.sessions ?? [],
      updatedAt: item.updated_at,
    }];
  });
}
