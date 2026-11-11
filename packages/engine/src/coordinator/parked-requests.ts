// 停靠等待（用户 2026-11-11，「在依赖的信息未确认前，工单可能得先暂停在那里……直到 blocker 项解除又继续推进」）。
// child 提了阻塞的决定或审批以后，它的 Run 可以干净地结束：
//   - Run 结束时它自己提的阻塞请求还没有答复：算停靠，不算交接失败。工单转「受阻」，记一条 run_parked。
//   - 这些请求都有了结果（回答、忽略、批准、拒绝、过期）：工单转回执行中，排一个派发请求，续接那个 Run 的会话，
//     指令里是每个请求的结果和是谁定的。只做一次（幂等键按停靠的 Run）。
//   - 调用还挂着等答复的（pi 的 child）不停靠：工具调用自己会带着答复返回。
// 为什么要停靠：Claude Code 和 Codex 的工具调用最多等 30 秒（agent-tools/tool-timeouts.ts），负责人的答复可能要几个小时。
// 以前这种 Run 结束时算交接失败，升一个 blocker；答复也不会自己回到 child，要 Lead 把它抄进 continue_ticket_agent。
import {
  addActivity, addInbox, assertRunAllowed, getApproval, getDecisionRequest, getItem, transition, type Db,
} from "@pi-lead-child/store";
import type { Item, RunPurpose } from "@pi-lead-child/core";
import { createDispatcher } from "./dispatch.js";

/** 活动里的记号：这个 Run 停靠了（payload.runId、decisions、approvals）。 */
export const RUN_PARKED = "run_parked";
/** 活动里的记号：停靠的 Run 的答复到了，已经排了续接（payload.runId、dispatchRequestId）；或者续接不了（payload.refused）。 */
export const PARKED_RUN_RESUMED = "parked_run_resumed";
/** 续接的派发请求的 trigger。 */
export const PARKED_ANSWER_TRIGGER = "parked-answer";

export interface ChildRequests {
  decisions: number[];
  approvals: number[];
}

/** 这张工单上 child 提的、还没有结果的阻塞请求：阻塞的决定请求，和审批。 */
export function pendingChildRequests(db: Db, itemId: number): ChildRequests {
  const decisions = (db.prepare(
    "SELECT id FROM decision_requests WHERE item_id = ? AND state = 'pending' AND blocking = 1 AND origin = 'agent' ORDER BY id",
  ).all(itemId) as Array<{ id: number }>).map((row) => row.id);
  const approvals = (db.prepare(
    "SELECT id FROM approvals WHERE item_id = ? AND status = 'pending' AND requested_by = 'child' ORDER BY id",
  ).all(itemId) as Array<{ id: number }>).map((row) => row.id);
  return { decisions, approvals };
}

export function hasPendingChildRequests(db: Db, itemId: number): boolean {
  const pending = pendingChildRequests(db, itemId);
  return pending.decisions.length > 0 || pending.approvals.length > 0;
}

function describeRequests(requests: ChildRequests): string {
  return [
    ...requests.decisions.map((id) => `决定请求 #${id}`),
    ...requests.approvals.map((id) => `审批 #${id}`),
  ].join("、");
}

/**
 * 执行的 Run 正常结束、工单还在执行中时调用（pipeline 的 ingest.ts）。它自己提的阻塞请求还没有答复时停靠：
 * 工单转「受阻」，记下停靠的 Run 和在等的请求，返回 true。没有在等的请求时什么也不做，返回 false。
 */
export function parkRunOnPendingRequests(db: Db, args: { itemId: number; runId: number; now?: Date }): boolean {
  const pending = pendingChildRequests(db, args.itemId);
  if (!pending.decisions.length && !pending.approvals.length) return false;
  transition(db, {
    itemId: args.itemId, to: "blocked", actor: "system", runId: args.runId,
    reason: `Run #${args.runId} 结束了，在等${describeRequests(pending)}的答复`,
    ...(args.now ? { now: args.now } : {}),
  });
  addActivity(db, {
    itemId: args.itemId, runId: args.runId, actor: "system", kind: "decision",
    payload: { decision: RUN_PARKED, runId: args.runId, decisions: pending.decisions, approvals: pending.approvals },
  });
  return true;
}

interface ParkedMark {
  runId: number;
  decisions: number[];
  approvals: number[];
}

function latestPark(db: Db, itemId: number): ParkedMark | null {
  const row = db.prepare(
    `SELECT payload FROM activities
     WHERE item_id = ? AND kind = 'decision' AND json_valid(payload) AND json_extract(payload, '$.decision') = ?
     ORDER BY id DESC LIMIT 1`,
  ).get(itemId, RUN_PARKED) as { payload: string } | undefined;
  if (!row) return null;
  const payload = JSON.parse(row.payload) as { runId?: unknown; decisions?: unknown; approvals?: unknown };
  if (typeof payload.runId !== "number") return null;
  const ids = (value: unknown): number[] => (Array.isArray(value) ? value.filter((id): id is number => typeof id === "number") : []);
  return { runId: payload.runId, decisions: ids(payload.decisions), approvals: ids(payload.approvals) };
}

function alreadySettled(db: Db, itemId: number, runId: number): boolean {
  return db.prepare(
    `SELECT 1 FROM activities
     WHERE item_id = ? AND kind = 'decision' AND json_valid(payload) AND json_extract(payload, '$.decision') = ?
       AND json_extract(payload, '$.runId') = ? LIMIT 1`,
  ).get(itemId, PARKED_RUN_RESUMED, runId) !== undefined;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

function decisionLine(db: Db, id: number): string {
  const request = getDecisionRequest(db, id);
  if (!request) return `- 决定请求 #${id}：找不到了。`;
  const head = `- 决定请求 #${id}「${clip(request.prompt, 400)}」`;
  const by = request.resolvedBy ? `（${request.resolvedBy} 定的）` : "";
  if (request.state === "resolved" && request.resolutionKind === "option") {
    const option = request.options.find((entry) => entry.id === request.selectedOptionId);
    return `${head}：选了「${option?.label ?? request.selectedOptionId}」（${request.selectedOptionId}）${by}。`;
  }
  if (request.state === "resolved") return `${head}：答复是「${clip(request.resolutionText ?? "", 2_000)}」${by}。`;
  if (request.state === "dismissed") {
    return `${head}：被忽略了${request.dismissalReason ? `，原因：${clip(request.dismissalReason, 500)}` : ""}${by}。它没有答案：按工单已有的要求做。`;
  }
  if (request.state === "expired") return `${head}：过期了，没有人回答。按工单已有的要求做。`;
  return `${head}：还没有答复。`;
}

function approvalLine(db: Db, id: number): string {
  const approval = getApproval(db, id);
  if (!approval) return `- 审批 #${id}：找不到了。不要执行这个动作。`;
  const head = `- 审批 #${id}「${clip(approval.action, 400)}」`;
  const by = approval.resolved_by ? `（${approval.resolved_by} 定的）` : "";
  if (approval.status === "approved") return `${head}：批准了${by}。可以执行这个动作。`;
  if (approval.status === "rejected") return `${head}：被拒绝了${by}。不要执行这个动作。`;
  if (approval.status === "expired") return `${head}：过期了，没有人处理。不要执行这个动作；还需要时重新请求审批。`;
  return `${head}：还没有结果。不要执行这个动作。`;
}

function answerInstruction(db: Db, park: ParkedMark): string {
  return [
    "你上一轮停下来等的答复到了：",
    ...park.decisions.map((id) => decisionLine(db, id)),
    ...park.approvals.map((id) => approvalLine(db, id)),
    "接着做因此停下的工作。答复里没有说到的地方，再用 request_decision 问，不要猜。",
  ].join("\n");
}

function executionPurpose(item: Pick<Item, "purpose">): RunPurpose {
  return !item.purpose || item.purpose === "review" ? "execution" : item.purpose;
}

/**
 * 一个决定或审批有了结果以后调用（coordinator 的 interventions.ts）。这张工单有停靠的 Run、它在等的请求都有了结果时，
 * 工单转回执行中，排一个续接那个 Run 的会话的派发请求。返回派发请求的编号；不该续接、已经续接过时返回 null。
 *
 * 不续接的情况：工单已经不在「受阻」（用户或 Lead 让它走了别的路）；停靠以后工单又跑过别的执行 Run；还有请求没答复；
 * 有暂停着的 Run（由用户的恢复控制续接）；闸门不让开 Run（例如预算用完）。最后一种告诉 Lead，只说一次。
 */
export function resumeParkedRun(db: Db, itemId: number, at: Date = new Date()): number | null {
  return db.transaction((): number | null => {
    const item = getItem(db, itemId);
    if (!item || item.stage !== "blocked") return null;
    const park = latestPark(db, itemId);
    if (!park || alreadySettled(db, itemId, park.runId)) return null;
    const later = db.prepare(
      "SELECT 1 FROM runs WHERE item_id = ? AND id > ? AND role = 'executor' AND purpose <> 'conversation' LIMIT 1",
    ).get(itemId, park.runId);
    if (later) return null;
    if (hasPendingChildRequests(db, itemId)) return null;
    const paused = db.prepare(
      "SELECT 1 FROM runs WHERE item_id = ? AND state = 'paused' AND purpose <> 'conversation' LIMIT 1",
    ).get(itemId);
    if (paused) return null;

    const purpose = executionPurpose(item);
    const instruction = answerInstruction(db, park);
    try {
      assertRunAllowed(db, { itemId, role: "executor", purpose });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      addActivity(db, {
        itemId, runId: park.runId, actor: "system", kind: "decision",
        payload: { decision: PARKED_RUN_RESUMED, runId: park.runId, refused: why },
      });
      addInbox(db, {
        itemId, severity: "attention", source: "structural", lossless: true,
        summary: `工单 #${itemId} 在等的答复到了，但系统没能接着跑：${why}\n要交回给 agent 的话：\n${instruction}\n`
          + "处理掉拦住它的原因以后，用 continue_ticket_agent 把上面的话交给它。",
        payload: { kind: "parked_run_resume_refused", runId: park.runId, wakeLead: true, needsUser: false },
      });
      return null;
    }
    transition(db, {
      itemId, to: "active", actor: "system", runId: park.runId, now: at,
      reason: `Run #${park.runId} 在等的答复到了，续接它的会话`,
    });
    const requestId = createDispatcher(db).request({
      itemId, role: "executor", purpose,
      // runtime 和模型不点名：dispatcher 用工单上记着的 runtime，续接这个 Run 的会话（和自动返工一样）。
      resumeFromRunId: park.runId,
      instruction,
      trigger: PARKED_ANSWER_TRIGGER,
      idempotencyKey: `${PARKED_ANSWER_TRIGGER}:run:${park.runId}`,
    });
    addActivity(db, {
      itemId, runId: park.runId, actor: "system", kind: "decision",
      payload: { decision: PARKED_RUN_RESUMED, runId: park.runId, dispatchRequestId: requestId },
    });
    return requestId;
  })();
}
