// 外部工人回写结果（.scratch/external-worker-hub/spec.md P1-5、P1-6）和放掉一张被领走的单（P1-4）。
//   - complete：工单 active → review（system 的边），外部 Run 结束（finished）。成果复用执行者的成果快照：完成的 checkpoint
//     加一份 agent_reported 的成果（摘要、交付物）。证据（evidence）不是一条验证记录（系统没有跑过它），记在 Run 的
//     metadata.completion 和 worker_completed 这条活动里。之后由用户验收；不新增 active → done。
//   - hand_back：工单记成 needs_user（原因是工人给的），active → blocked（system 的边），外部 Run 结束（stopped）。
//   - release（工单操作 ticket.release，用户或 Lead）：外部 Run 结束（stopped），工单 active → ready（user/lead 的边）。
import type { Item } from "@pi-lead-child/core";
import {
  addActivity, getItem, getRun, insertOutcomeSnapshot, markRunFinished, markRunStopped, normalizeOutcomePayload, setHandling,
  transition, updateRun, type Db, type TicketComplexity,
} from "@pi-lead-child/store";
import { createCheckpointDomainService } from "../coordinator/checkpoints.js";
import { parseMetadata } from "../pipeline/run-registration.js";
import { behalfCursor, behalfFields, transitionBy, type ActionAttribution } from "../ticket-actions/attribution.js";
import { TicketActionError } from "../ticket-actions/types.js";
import { openWorkerClaim, requireOwnClaim, touchItem } from "./claim.js";

/** 回写结果（complete、hand_back）要工单在执行中。能做时为 null。 */
export function writeBackBlocker(item: Item): string | null {
  return item.stage === "active" ? null : `工单 #${item.id} 现在是 ${item.stage}，只有执行中的单能交付或交回。`;
}

function requireActive(db: Db, itemId: number): Item {
  const item = getItem(db, itemId);
  if (!item) throw new TicketActionError("not_found", `工单 #${itemId} 不存在`);
  const blocker = writeBackBlocker(item);
  if (blocker) throw new TicketActionError("unavailable", blocker);
  return item;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const isWebUrl = (ref: string) => /^https?:\/\//i.test(ref);

export interface CompleteTicketInput {
  itemId: number;
  bindingId: number;
  workerName: string;
  summary: string;
  evidence: string;
  artifacts?: string[];
  now?: Date;
}

export interface CompleteTicketResult {
  ticketId: number;
  runId: number;
  stage: "review";
  outcomeSnapshotId: number;
}

/** 工人做完了：成果登记在外部 Run 上，外部 Run 结束，工单进 review。一笔事务。 */
export function completeTicket(db: Db, input: CompleteTicketInput): CompleteTicketResult {
  const now = input.now ?? new Date();
  const artifacts = input.artifacts ?? [];
  return db.transaction((): CompleteTicketResult => {
    const claim = requireOwnClaim(db, input.itemId, input.bindingId);
    requireActive(db, input.itemId);
    const { checkpoint } = createCheckpointDomainService({ db, now: () => now }).submitCheckpoint({
      itemId: input.itemId, runId: claim.runId, kind: "completed",
      title: clip(`${input.workerName} completed ticket #${input.itemId}`, 160),
      summary: input.summary,
      publishItemUpdated: false,
      idempotencyKey: `worker-complete:${claim.runId}`,
    });
    const outcome = normalizeOutcomePayload({
      summary: input.summary,
      deliverables: artifacts.map((ref) => ({ kind: isWebUrl(ref) ? "url" : "other", ref, label: clip(ref, 240) })),
    }, { allowPartial: true });
    const { snapshot } = insertOutcomeSnapshot(db, {
      itemId: input.itemId, executorRunId: claim.runId, completionCheckpointId: checkpoint.id, source: "agent_reported", outcome, now,
    });
    const run = getRun(db, claim.runId)!;
    updateRun(db, run.id, {
      metadata: { ...parseMetadata(run.metadata), completion: { summary: input.summary, evidence: input.evidence, artifacts } },
    });
    markRunFinished(db, run.id, { exitCode: 0 });
    transition(db, {
      itemId: input.itemId, to: "review", actor: "system", runId: run.id,
      reason: `completed by external worker ${input.workerName}`,
    });
    addActivity(db, {
      itemId: input.itemId, runId: run.id, actor: "child", kind: "decision",
      payload: {
        decision: "worker_completed", summary: input.summary, evidence: input.evidence, artifacts,
        outcomeSnapshotId: snapshot.id, workerName: input.workerName, bindingId: input.bindingId,
      },
    });
    touchItem(db, input.itemId);
    return { ticketId: input.itemId, runId: run.id, stage: "review", outcomeSnapshotId: snapshot.id };
  }).immediate();
}

export interface HandBackInput {
  itemId: number;
  bindingId: number;
  workerName: string;
  reason: string;
}

/** 工人交回给用户：needs_user，进 blocked，外部 Run 结束。复杂度的判断留着。一笔事务。 */
export function handBackTicket(db: Db, input: HandBackInput): { ticketId: number; runId: number; stage: "blocked" } {
  if (!input.reason.trim()) throw new TicketActionError("invalid_input", "worker.hand_back：reason 不能是空的。");
  return db.transaction(() => {
    const claim = requireOwnClaim(db, input.itemId, input.bindingId);
    requireActive(db, input.itemId);
    const { complexity } = db.prepare("SELECT complexity FROM items WHERE id=?").get(input.itemId) as { complexity: TicketComplexity | null };
    setHandling(db, input.itemId, { handling: "needs_user", reason: input.reason, ...(complexity ? { complexity } : {}) });
    markRunStopped(db, claim.runId);
    transition(db, {
      itemId: input.itemId, to: "blocked", actor: "system", runId: claim.runId,
      reason: `handed back by external worker ${input.workerName}: ${input.reason}`,
    });
    addActivity(db, {
      itemId: input.itemId, runId: claim.runId, actor: "child", kind: "decision",
      payload: { decision: "worker_handed_back", reason: input.reason, workerName: input.workerName, bindingId: input.bindingId },
    });
    touchItem(db, input.itemId);
    return { ticketId: input.itemId, runId: claim.runId, stage: "blocked" as const };
  }).immediate();
}

/** 放掉一张被领走的单为什么做不了。能做时为 null。 */
export function releaseBlocker(db: Db, item: Item): string | null {
  return openWorkerClaim(db, item.id) ? null : `工单 #${item.id} 没有被外部工人领着。`;
}

/**
 * 放掉外部工人领着的单（工单操作 ticket.release）：外部 Run 结束（stopped），执行中的工单回到待开始。
 * 用户和 Lead 做（user/lead 的 active → ready 边，和「停下」一样）。一笔事务。
 */
export function releaseTicket(
  db: Db, input: { itemId: number; by: ActionAttribution; reason: string },
): { ticketId: number; runId: number; stage: Item["stage"] } {
  return db.transaction(() => {
    const claim = openWorkerClaim(db, input.itemId);
    if (!claim) throw new TicketActionError("unavailable", `工单 #${input.itemId} 没有被外部工人领着。`);
    markRunStopped(db, claim.runId);
    addActivity(db, {
      itemId: input.itemId, runId: claim.runId, actor: input.by.actor, kind: "decision", ...behalfCursor(input.by),
      payload: {
        decision: "worker_claim_released", reason: input.reason, workerName: claim.workerName, bindingId: claim.bindingId,
        ...behalfFields(input.by),
      },
    });
    if (getItem(db, input.itemId)?.stage === "active") {
      transition(db, { itemId: input.itemId, to: "ready", ...transitionBy(input.by), reason: input.reason, runId: claim.runId });
    }
    touchItem(db, input.itemId);
    return { ticketId: input.itemId, runId: claim.runId, stage: getItem(db, input.itemId)!.stage };
  }).immediate();
}
