// 外部工人领单（.scratch/external-worker-hub/spec.md P1-2、P1-4、P1-5）。
// 领取 = 建一个 runtime=external 的 Run（不起进程）：成果、用量、交付、TicketSummary 都按执行者的 Run 复用。
// ready/blocked → active 由 system 在建 Run 时推（stages.ts 的 system 边），不新增 actor。
// Run 的 metadata 记工人的 binding id（不是名字）、领取方式（manual；auto 是以后的 claim_next）、会话链接。
// 一张单同时只能有一个活着的外部 Run：再领时拒绝，原因写着领走它的工人。
// 这里也放领着的单的读法（openWorkerClaim）和只有领走它的工人才能做的两件事：挂会话、写进展笔记。
import type { Item, Run } from "@pi-lead-child/core";
import {
  EXTERNAL_RUNTIME_ID, WORKER_SESSION_URL_SCHEMES,
  type WorkerClaimMode, type WorkerSession, type WorkerUsage,
} from "@pi-lead-child/protocol";
import {
  addActivity, createRun, createRunUsageLedger, getBinding, getItem, getRun, markRunStopped, transition, updateRun, type Db,
} from "@pi-lead-child/store";
import { ExecutionDeferredError, getExecutionMode } from "../execution-mode.js";
import { parseMetadata } from "../pipeline/run-registration.js";
import { TicketActionError } from "../ticket-actions/types.js";

const LIVE_RUN_STATES: readonly Run["state"][] = ["starting", "running"];
// 能领的 stage：待开始、受阻，和没有活着的 Run 的执行中（例如暂停的 Run 留下的、外部模式下排着返工的）。
const CLAIMABLE_STAGES: readonly Item["stage"][] = ["ready", "blocked", "active"];
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export interface WorkerClaim {
  runId: number;
  itemId: number;
  bindingId: number;
  // 工人配对时的名字（bindings.display_name）。凭证删掉了时是「工人 #<binding id>」。
  workerName: string;
  claimMode: WorkerClaimMode;
  sessions: WorkerSession[];
  // 外部 Run 还活着（还领着）。
  open: boolean;
  claimedAt: string;
}

function workerNameOf(db: Db, bindingId: number): string {
  return getBinding(db, bindingId)?.display_name ?? `工人 #${bindingId}`;
}

function sessionsOf(metadata: Record<string, unknown>): WorkerSession[] {
  return Array.isArray(metadata.sessions) ? metadata.sessions as WorkerSession[] : [];
}

function claimOfRun(db: Db, run: Run): WorkerClaim | null {
  const metadata = parseMetadata(run.metadata);
  if (typeof metadata.bindingId !== "number") return null;
  return {
    runId: run.id,
    itemId: run.item_id,
    bindingId: metadata.bindingId,
    workerName: workerNameOf(db, metadata.bindingId),
    claimMode: metadata.claimMode === "auto" ? "auto" : "manual",
    sessions: sessionsOf(metadata),
    open: LIVE_RUN_STATES.includes(run.state),
    claimedAt: run.started_at,
  };
}

/** 这张单现在被哪个工人领着（活着的外部 Run）。没有时 null。 */
export function openWorkerClaim(db: Db, itemId: number): WorkerClaim | null {
  const run = db.prepare(
    "SELECT * FROM runs WHERE item_id=? AND runtime=? AND state IN ('starting','running') ORDER BY id DESC LIMIT 1",
  ).get(itemId, EXTERNAL_RUNTIME_ID) as Run | undefined;
  return run ? claimOfRun(db, run) : null;
}

/** 这张单最近一次被领（不管外部 Run 结束没有）。没有时 null。 */
export function latestWorkerClaim(db: Db, itemId: number): WorkerClaim | null {
  const run = db.prepare(
    "SELECT * FROM runs WHERE item_id=? AND runtime=? ORDER BY id DESC LIMIT 1",
  ).get(itemId, EXTERNAL_RUNTIME_ID) as Run | undefined;
  return run ? claimOfRun(db, run) : null;
}

/**
 * 这张单现在为什么不能领。能领时为 null。领取前（工单操作的 available）和领取时（事务里）用同一个判断。
 * liveItemIds：还被一个进程占着的工单（daemon 的 live 表）：库里的 Run 已经结束、进程还在退出时也不能领。
 */
export function claimBlocker(db: Db, item: Item, options: { liveItemIds?: readonly number[] } = {}): string | null {
  if (getExecutionMode(db) === "paused") return "执行模式是「暂停」：现在不派发，也不让外部工人领单。";
  if (item.kind !== "task") return "提醒不能领。";
  const claim = openWorkerClaim(db, item.id);
  if (claim) return `工单 #${item.id} 已被 ${claim.workerName} 领走。`;
  if (!CLAIMABLE_STAGES.includes(item.stage)) return `工单 #${item.id} 现在是 ${item.stage}，只有 ready、blocked 和没有在跑的 active 的单能领。`;
  const live = db.prepare(
    "SELECT id FROM runs WHERE item_id=? AND state IN ('starting','running') ORDER BY id DESC LIMIT 1",
  ).get(item.id) as { id: number } | undefined;
  if (live) return `工单 #${item.id} 正在由 Run #${live.id} 执行，不能领。`;
  if (options.liveItemIds?.includes(item.id)) return `工单 #${item.id} 的上一个 Run 还在收尾，稍后再领。`;
  return null;
}

export interface ClaimTicketInput {
  itemId: number;
  bindingId: number;
  workerName: string;
  liveItemIds?: readonly number[];
}

export interface ClaimTicketResult {
  ticketId: number;
  runId: number;
  stage: "active";
  // 领取时关掉的暂停的 Run。
  closedRunIds: number[];
  // 领取时结掉的、这张单还排着的派发请求。
  settledDispatchRequestIds: number[];
}

/**
 * 领一张单。一笔事务：关掉它暂停的 Run，结掉它还排着的派发请求（否则切回 self 时派发器会再跑一遍工人领走的单），
 * 建外部 Run（running，没有进程），工单进 active（system 的边，带着这个 Run）。
 */
export function claimTicket(db: Db, input: ClaimTicketInput): ClaimTicketResult {
  return db.transaction((): ClaimTicketResult => {
    const item = getItem(db, input.itemId);
    if (!item) throw new TicketActionError("not_found", `工单 #${input.itemId} 不存在`);
    const blocker = claimBlocker(db, item, input.liveItemIds ? { liveItemIds: input.liveItemIds } : {});
    if (blocker) throw new TicketActionError("unavailable", blocker);
    const paused = db.prepare("SELECT id FROM runs WHERE item_id=? AND state='paused' ORDER BY id").all(item.id) as Array<{ id: number }>;
    for (const run of paused) {
      markRunStopped(db, run.id);
      addActivity(db, {
        itemId: item.id, runId: run.id, actor: "system", kind: "decision",
        payload: { decision: "worker_claim_closed_run", from: "paused", workerName: input.workerName, bindingId: input.bindingId },
      });
    }
    const pending = (db.prepare("SELECT id FROM dispatch_requests WHERE item_id=? AND state='pending' ORDER BY id")
      .all(item.id) as Array<{ id: number }>).map((row) => row.id);
    if (pending.length) {
      const settle = db.prepare("UPDATE dispatch_requests SET state='cancelled', updated_at=datetime('now') WHERE id=? AND state='pending'");
      for (const id of pending) settle.run(id);
      addActivity(db, {
        itemId: item.id, actor: "system", kind: "decision",
        payload: { decision: "worker_claim_settled_dispatch", dispatchRequestIds: pending, workerName: input.workerName },
      });
    }
    let runId: number;
    try {
      runId = createRun(db, { itemId: item.id, runtime: EXTERNAL_RUNTIME_ID });
    } catch (error) {
      // Run 的闸门（store 的 run-gate.ts）拒绝了：例如关联的工单还没完成、重试额度用完了。原样告诉工人。
      throw new TicketActionError("unavailable", `工单 #${item.id} 现在不能领：${error instanceof Error ? error.message : String(error)}`);
    }
    const claimMode: WorkerClaimMode = "manual";
    updateRun(db, runId, { state: "running", metadata: { bindingId: input.bindingId, claimMode, sessions: [] } });
    if (item.stage === "ready" || item.stage === "blocked") {
      transition(db, {
        itemId: item.id, to: "active", actor: "system", runId,
        reason: `claimed by external worker ${input.workerName}`,
      });
    }
    addActivity(db, {
      itemId: item.id, runId, actor: "system", kind: "decision",
      payload: { decision: "worker_claimed", bindingId: input.bindingId, workerName: input.workerName, claimMode },
    });
    touchItem(db, item.id);
    return { ticketId: item.id, runId, stage: "active", closedRunIds: paused.map((run) => run.id), settledDispatchRequestIds: pending };
  }).immediate();
}

export function touchItem(db: Db, itemId: number): void {
  db.prepare("UPDATE items SET last_activity_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(itemId);
}

// 被外部工人领着的单上，用户（或 Lead 转交）的工单消息记成 comment，route 是它：不路由到任何进程，工人读工单时看得到
// （spec P1-2）。不管执行模式是什么（self 下也一样）。
export const WORKER_CLAIMED_ROUTE = "worker_claimed";

/**
 * 工单对话撞上了外部工人领着的单（lead 的 routeTicketMessageToAgentRun 抛它）。它是 ExecutionDeferredError 的子类：
 * daemon 按推迟的工单对话收口这一轮（消息已经存了，写明原因，不交给 Lead）。用户看到的话按 external 写
 * （「这张工单由外部工人处理」），所以 mode 记成 external，和现在的执行模式无关；给 Lead 的话（message）写明是谁领着。
 */
export class WorkerClaimedError extends ExecutionDeferredError {
  constructor(itemId: number, readonly workerName: string) {
    super(itemId, "external", "worker_claimed");
    this.name = "WorkerClaimedError";
    this.message = `工单 #${itemId} 被外部工人 ${workerName} 领着：没有启动 agent。消息记在工单上，工人下次读工单时看得到。`
      + "要收回这张单用 ticket_action 的 ticket.release。";
  }
}

/**
 * 工单对话的一条消息：这张单被外部工人领着时，把消息记进工单活动，返回要抛的 WorkerClaimedError；没被领着时什么也不写，
 * 返回 null（照常开对话 Run）。
 */
export function holdMessageForWorker(
  db: Db, input: { itemId: number; message: string; actor: "user" | "lead" },
): WorkerClaimedError | null {
  return db.transaction((): WorkerClaimedError | null => {
    const claim = openWorkerClaim(db, input.itemId);
    if (!claim) return null;
    addActivity(db, {
      itemId: input.itemId, actor: input.actor, kind: "comment",
      payload: { content: input.message, route: WORKER_CLAIMED_ROUTE, workerName: claim.workerName },
    });
    touchItem(db, input.itemId);
    return new WorkerClaimedError(input.itemId, claim.workerName);
  }).immediate();
}

/** 只有领走它的工人才能做的操作：这个工人现在为什么不能做。能做时为 null。 */
export function ownClaimBlocker(db: Db, itemId: number, bindingId: number): string | null {
  const claim = openWorkerClaim(db, itemId);
  if (!claim) return `工单 #${itemId} 现在没有被外部工人领着：先 worker.claim。`;
  if (claim.bindingId !== bindingId) return `工单 #${itemId} 不是你领的单（${claim.workerName} 领着它）。`;
  return null;
}

/** 领走这张单的是这个工人：返回它的领取。不是时抛 forbidden。 */
export function requireOwnClaim(db: Db, itemId: number, bindingId: number): WorkerClaim {
  const blocker = ownClaimBlocker(db, itemId, bindingId);
  if (blocker) throw new TicketActionError("forbidden", blocker);
  return openWorkerClaim(db, itemId)!;
}

export interface AttachSessionInput {
  itemId: number;
  bindingId: number;
  workerName: string;
  url?: string;
  sessionId?: string;
  now?: Date;
}

/** 会话链接能不能收：只收 https 和 claude（网页按白名单渲染）。能收时为 null。 */
export function sessionUrlBlocker(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `会话链接不是一个 URL：${url.slice(0, 200)}`;
  }
  return (WORKER_SESSION_URL_SCHEMES as readonly string[]).includes(parsed.protocol)
    ? null
    : `会话链接只收 ${WORKER_SESSION_URL_SCHEMES.join("、")}，不收 ${parsed.protocol}`;
}

/**
 * 给领着的单挂上这次干活的会话（链接或会话 id，至少一个）。记在外部 Run 的 metadata.sessions 里。
 * 不写 Run 的 external_session_id：那是 CLI 续接会话用的，外部 Run 不能被续接。同一个会话挂两次只记一次。
 */
export function attachSession(db: Db, input: AttachSessionInput): { ticketId: number; runId: number; sessions: WorkerSession[] } {
  if (input.url === undefined && input.sessionId === undefined) {
    throw new TicketActionError("invalid_input", "worker.attach_session：给会话链接（url）或者会话 id（sessionId），至少一个。");
  }
  const urlBlocker = input.url === undefined ? null : sessionUrlBlocker(input.url);
  if (urlBlocker) throw new TicketActionError("invalid_input", urlBlocker);
  if (input.sessionId !== undefined && !SESSION_ID.test(input.sessionId)) {
    throw new TicketActionError("invalid_input", "会话 id 只能有字母、数字和 . _ -，最多 200 个字符。");
  }
  return db.transaction(() => {
    const claim = requireOwnClaim(db, input.itemId, input.bindingId);
    const run = getRun(db, claim.runId)!;
    const metadata = parseMetadata(run.metadata);
    const sessions = sessionsOf(metadata);
    const url = input.url ?? null;
    const sessionId = input.sessionId ?? null;
    if (!sessions.some((session) => session.url === url && session.sessionId === sessionId)) {
      sessions.push({ url, sessionId, attachedAt: (input.now ?? new Date()).toISOString() });
      updateRun(db, run.id, { metadata: { ...metadata, sessions } });
      addActivity(db, {
        itemId: input.itemId, runId: run.id, actor: "child", kind: "decision",
        payload: { decision: "worker_session_attached", url, sessionId, workerName: input.workerName },
      });
      touchItem(db, input.itemId);
    }
    return { ticketId: input.itemId, runId: run.id, sessions };
  }).immediate();
}

export interface ReportInput {
  itemId: number;
  bindingId: number;
  workerName: string;
  text: string;
  usage?: WorkerUsage;
  now?: Date;
}

// 工人的进展笔记是工单活动里的一条 comment，route 是它（activities.kind 有 CHECK 约束，不能加新 kind）。
export const WORKER_REPORT_ROUTE = "worker_report";

/** 工人的进展笔记（工单活动 worker_report）。带用量时记到它的外部 Run 上，和执行者的用量同一本账。 */
export function reportOnTicket(db: Db, input: ReportInput): { ticketId: number; runId: number; activityId: number } {
  if (!input.text.trim()) throw new TicketActionError("invalid_input", "worker.report：text 不能是空的。");
  return db.transaction(() => {
    const claim = requireOwnClaim(db, input.itemId, input.bindingId);
    const activityId = addActivity(db, {
      itemId: input.itemId, runId: claim.runId, actor: "child", kind: "comment",
      payload: { content: input.text, route: WORKER_REPORT_ROUTE, workerName: input.workerName, bindingId: input.bindingId },
    });
    if (input.usage) recordWorkerUsage(db, input.itemId, claim.runId, input.usage, input.now ?? new Date());
    touchItem(db, input.itemId);
    return { ticketId: input.itemId, runId: claim.runId, activityId };
  }).immediate();
}

/**
 * 把工人报的用量记成外部 Run 的一条 usage.updated（delta），工单的累计用量加上同样的数（和 ingest 用同一本账的规则，
 * store 的 createRunUsageLedger）。token 的口径：输入（含缓存读写）加输出。
 */
function recordWorkerUsage(db: Db, itemId: number, runId: number, usage: WorkerUsage, now: Date): void {
  const seq = ((db.prepare("SELECT MAX(seq) AS seq FROM runtime_events WHERE run_id=?").get(runId) as { seq: number | null }).seq ?? 0) + 1;
  const occurredAt = now.toISOString();
  const event = {
    type: "usage.updated" as const,
    mode: "delta",
    totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
    runId, seq, occurredAt,
  };
  db.prepare("INSERT INTO runtime_events (run_id, seq, event_type, payload, occurred_at) VALUES (?, ?, 'usage.updated', ?, ?)")
    .run(runId, seq, JSON.stringify(event), occurredAt);
  const ledger = createRunUsageLedger();
  ledger.apply(event);
  const added = ledger.total();
  db.prepare(
    `UPDATE items SET total_tokens = total_tokens + ?, total_cost_usd = total_cost_usd + ?,
       uncached_input_tokens = uncached_input_tokens + ?, cache_write_tokens = cache_write_tokens + ?,
       cache_read_tokens = cache_read_tokens + ?, output_tokens = output_tokens + ?
     WHERE id = ?`,
  ).run(added.tokens, added.costUsd, added.uncachedInputTokens, added.cacheWriteTokens, added.cacheReadTokens, added.outputTokens, itemId);
  // 事件只在库里：审计文件按 event_log_dirty 在下次读时重建（store 的 runtime-events.ts）。
  updateRun(db, runId, { eventCursor: String(seq), eventLogDirty: true, ...(usage.costUsd !== undefined ? { costKnown: true } : {}) });
}
