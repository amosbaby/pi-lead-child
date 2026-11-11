// 停靠等待（用户 2026-11-11）：child 提了阻塞的决定或审批以后，它的 Run 可以干净地结束。工单停在「受阻」，不算交接失败。
// 答复到了，系统续接它的会话，把答复交回去。Claude Code 和 Codex 的工具调用最多等 30 秒，不能靠挂着的调用等答复
// （agent-tools/tool-timeouts.ts）；pi 的调用可以一直挂着，看门狗这时不把它报成卡死。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  createItem, createRun, getItem, getRun, listActivities, listInbox, openDb, transition, updateRun, type Db,
} from "@pi-lead-child/store";
import { createDispatcher } from "../src/coordinator/dispatch.js";
import { createAgentToolHandlers } from "../src/agent-tools/definitions.js";
import { liveChildren } from "../src/children/manager.js";
import { createCoordinator } from "../src/coordinator/service.js";
import { createIngestor } from "../src/pipeline/ingest.js";
import { createWatchdog } from "../src/pipeline/watchdog.js";

let db: Db;
let itemId: number;
let runId: number;

beforeEach(() => {
  db = openDb(join(tempDir("plc-parked-"), "plc.db"));
  itemId = createItem(db, { title: "build the export page", brief: "b", createdBy: "system" });
  transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
  runId = createRun(db, { itemId, role: "executor", runtime: "claude" });
  updateRun(db, runId, { state: "running", externalSessionId: "session-1" });
});
afterEach(() => { liveChildren().clear(); });

const coordinator = () => createCoordinator({ db });

function askDecision(options: { blocking?: boolean; prompt?: string; open?: boolean } = {}): number {
  return coordinator().requestDecision({
    itemId, runId, kind: "blocker", audience: "lead_or_user", blocking: options.blocking ?? true,
    prompt: options.prompt ?? "Replace the missing component or build it?",
    // open：没有选项，回答是一段文字。
    options: options.open ? [] : [{ id: "replace", label: "Replace it" }, { id: "build", label: "Build it" }],
    checkpoint: { title: "Component missing", summary: "DateRangePicker is not in the library.", nextStep: "Wait for the choice." },
  }).requestId;
}

function askApproval(): number {
  const result = coordinator().requestApproval({
    itemId, runId, requestedBy: "child", tool: "bash", action: "git push origin feature/export",
    checkpoint: { title: "Push the branch", summary: "3 commits", nextStep: "Push after approval." },
  });
  if (result.status !== "pending") throw new Error("expected a pending approval");
  return result.approvalId!;
}

// 这一轮结束：run.completed。返回 ingest 的结论。
function finishRun() {
  const ingestor = createIngestor(db, { itemId, runId });
  ingestor.onEvent({ type: "agent_start" });
  return ingestor.onEvent({ type: "agent_end", messages: [] });
}

const dispatches = () => db.prepare(
  "SELECT trigger, role, purpose, resume_from_run_id AS resumeFromRunId, instruction, state FROM dispatch_requests WHERE item_id = ? ORDER BY id",
).all(itemId) as Array<{ trigger: string; role: string; purpose: string; resumeFromRunId: number | null; instruction: string | null; state: string }>;

const parkedMarks = () => listActivities(db, itemId)
  .map((activity) => JSON.parse(activity.payload) as Record<string, unknown>)
  .filter((payload) => payload.decision === "run_parked");

describe("a run that ends while its own request waits for an answer", () => {
  it("is parked: no terminal hand-off failure, the ticket is blocked, the park is recorded", () => {
    const decisionId = askDecision();
    expect(finishRun()).toBeUndefined();
    expect(getItem(db, itemId)!.stage).toBe("blocked");
    expect(parkedMarks()).toEqual([expect.objectContaining({ runId, decisions: [decisionId], approvals: [] })]);
    // 不是故障：没有另外的 blocker 行，只有这个决定自己的那一行。
    expect(listInbox(db, {}).filter((row) => row.severity === "blocker")).toHaveLength(1);
  });

  it("is parked for a pending approval too", () => {
    const approvalId = askApproval();
    expect(finishRun()).toBeUndefined();
    expect(getItem(db, itemId)!.stage).toBe("blocked");
    expect(parkedMarks()).toEqual([expect.objectContaining({ runId, decisions: [], approvals: [approvalId] })]);
  });

  it("still needs a terminal hand-off when the pending question does not block", () => {
    askDecision({ blocking: false });
    expect(finishRun()).toEqual({ type: "terminal_handoff_required", criticalToolFailure: null });
    expect(getItem(db, itemId)!.stage).toBe("active");
  });

  it("still needs a terminal hand-off when the request was answered before the run ended", () => {
    const decisionId = askDecision();
    coordinator().resolveDecision({ requestId: decisionId, decision: "select", optionId: "build", actor: { kind: "lead", resolvedBy: "lead" } });
    expect(finishRun()).toEqual({ type: "terminal_handoff_required", criticalToolFailure: null });
  });
});

describe("the answer to a parked run", () => {
  it("resumes the executor's session with the answer, once", () => {
    const decisionId = askDecision();
    finishRun();
    coordinator().resolveDecision({
      requestId: decisionId, decision: "select", optionId: "build", actor: { kind: "lead", resolvedBy: "lead" },
      reason: "The design owner said to build it\nlead_evidence: read docs/design/export.md",
    });

    expect(getItem(db, itemId)!.stage).toBe("active");
    const [dispatch, ...rest] = dispatches();
    expect(rest).toEqual([]);
    expect(dispatch).toMatchObject({ trigger: "parked-answer", role: "executor", purpose: "execution", resumeFromRunId: runId, state: "pending" });
    expect(dispatch!.instruction).toContain(`#${decisionId}`);
    expect(dispatch!.instruction).toContain("Replace the missing component or build it?");
    expect(dispatch!.instruction).toContain("Build it");
    expect(dispatch!.instruction).toContain("lead");
    // 出处（用户 2026-11-11）：是谁定的、凭什么，一起交回去。
    expect(dispatch!.instruction).toContain("依据：The design owner said to build it；lead_evidence: read docs/design/export.md");
  });

  // 贯穿持久化的流程：停靠 → 回答 → 派发队列认领出一个续接会话的新 Run → 新 Run 再问、再停靠、再续接。
  it("is claimed by the dispatcher as a new run that resumes the parked session, and can park again", () => {
    const decisionId = askDecision();
    finishRun();
    coordinator().resolveDecision({ requestId: decisionId, decision: "select", optionId: "build", actor: { kind: "lead", resolvedBy: "lead" } });

    const dispatcher = createDispatcher(db);
    const claim = dispatcher.claimNext();
    expect(claim).toMatchObject({ itemId, role: "executor", purpose: "execution", trigger: "parked-answer", resumeFromRunId: runId });
    expect(claim!.instruction).toContain("Build it");
    expect(claim!.runId).not.toBe(runId);
    expect(getRun(db, claim!.runId)).toMatchObject({ item_id: itemId, role: "executor" });
    expect(dispatcher.claimNext()).toBeNull();

    // 续接的 Run 又提了一个问题，又结束了：再停靠一次，答复到了再续接一次。
    const firstRun = runId;
    runId = claim!.runId;
    updateRun(db, runId, { state: "running", externalSessionId: "session-1" });
    const secondDecision = askDecision({ prompt: "Which export file name?", open: true });
    expect(finishRun()).toBeUndefined();
    expect(getItem(db, itemId)!.stage).toBe("blocked");
    coordinator().resolveDecision({ requestId: secondDecision, decision: "respond", resolution: "export-2026.csv", actor: { kind: "lead", resolvedBy: "lead" } });
    const all = dispatches();
    expect(all.map((row) => row.resumeFromRunId)).toEqual([firstRun, runId]);
    expect(all[1]!.instruction).toContain("export-2026.csv");
  });

  it("carries a free-text answer and a dismissal as they are", () => {
    const first = askDecision({ prompt: "Which date format?", open: true });
    const second = askDecision({ prompt: "Keep the legacy column?" });
    finishRun();
    coordinator().resolveDecision({ requestId: first, decision: "respond", resolution: "ISO 8601, in UTC", actor: { kind: "lead", resolvedBy: "lead" } });
    // 还有一个没答复：先不续接。
    expect(dispatches()).toEqual([]);
    expect(getItem(db, itemId)!.stage).toBe("blocked");

    coordinator().resolveDecision({ requestId: second, decision: "dismiss", reason: "out of scope", actor: { kind: "lead", resolvedBy: "lead" } });
    const [dispatch] = dispatches();
    expect(dispatch!.instruction).toContain("ISO 8601, in UTC");
    expect(dispatch!.instruction).toContain("Keep the legacy column?");
    expect(dispatch!.instruction).toContain("out of scope");
  });

  it("tells the executor not to run the action when the approval was rejected", () => {
    const approvalId = askApproval();
    finishRun();
    coordinator().resolveApproval({ approvalId, decision: "reject", actor: { kind: "lead", resolvedBy: "lead" }, reason: "do not push to a shared branch" });
    const [dispatch] = dispatches();
    expect(dispatch).toMatchObject({ trigger: "parked-answer", resumeFromRunId: runId });
    expect(dispatch!.instruction).toContain("git push origin feature/export");
    expect(dispatch!.instruction).toContain("不要执行");
  });

  it("does nothing when the run was not parked: the tool call is still waiting", () => {
    const decisionId = askDecision();
    coordinator().resolveDecision({ requestId: decisionId, decision: "select", optionId: "build", actor: { kind: "lead", resolvedBy: "lead" } });
    expect(dispatches()).toEqual([]);
    expect(getItem(db, itemId)!.stage).toBe("active");
  });

  it("does nothing when the ticket moved on after the park", () => {
    const decisionId = askDecision();
    finishRun();
    transition(db, { itemId, to: "cancelled", actor: "user", reason: "not needed" });
    coordinator().resolveDecision({ requestId: decisionId, decision: "select", optionId: "build", actor: { kind: "lead", resolvedBy: "lead" } });
    expect(dispatches()).toEqual([]);
    expect(getItem(db, itemId)!.stage).toBe("cancelled");
  });
});

describe("a blocking request over a tool call that cannot wait long", () => {
  const question = {
    kind: "question", prompt: "Which date format?",
    checkpoint: { title: "Date format", summary: "The requirement does not say." },
  };

  it("returns as pending with what to do next, instead of waiting for ever", async () => {
    const handlers = createAgentToolHandlers({ db, itemId, runId, parkAfterMs: 30 });
    const result = await handlers.call("request_decision", question) as Record<string, unknown>;
    expect(result).toMatchObject({ status: "pending", parked: true, request_id: expect.any(Number) });
    expect(String(result.next_step)).toMatch(/end your turn/i);
  });

  it("returns the answer when it arrives in time", async () => {
    const handlers = createAgentToolHandlers({ db, itemId, runId, parkAfterMs: 5_000 });
    const pending = handlers.call("request_decision", question) as Promise<Record<string, unknown>>;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [request] = db.prepare("SELECT id FROM decision_requests WHERE item_id = ?").all(itemId) as Array<{ id: number }>;
    coordinator().resolveDecision({ requestId: request!.id, decision: "respond", resolution: "ISO 8601", actor: { kind: "lead", resolvedBy: "lead" } });
    expect(await pending).toMatchObject({ status: "resolved", resolution_text: "ISO 8601" });
  });

  it("does not create a second request when the child asks the same question again", async () => {
    const handlers = createAgentToolHandlers({ db, itemId, runId, parkAfterMs: 30 });
    const first = await handlers.call("request_decision", question) as { request_id: number };
    const again = await handlers.call("request_decision", question) as { request_id: number };
    expect(again.request_id).toBe(first.request_id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM decision_requests WHERE item_id = ?").get(itemId)).toEqual({ n: 1 });
  });

  it("parks an approval the same way", async () => {
    const handlers = createAgentToolHandlers({ db, itemId, runId, parkAfterMs: 30 });
    const result = await handlers.call("request_approval", {
      tool: "bash", action: "git push origin feature/export",
      checkpoint: { title: "Push the branch", summary: "3 commits", next_step: "Push after approval." },
    }) as Record<string, unknown>;
    expect(result).toMatchObject({ status: "pending", parked: true, approval_id: expect.any(Number) });
    expect(String(result.next_step)).toMatch(/do not run the action/i);
  });
});

describe("the watchdog and a run that waits for an answer", () => {
  beforeEach(() => {
    liveChildren().set(itemId, { rpc: {} as never, proc: {} as never, runId, streaming: true });
    db.prepare("UPDATE items SET last_activity_at = datetime('now', '-20 minutes') WHERE id = ?").run(itemId);
  });

  it("reports a silent run as stalled when nothing is pending (the query does match)", () => {
    createWatchdog(db, { stallMs: 15 * 60_000 }).check();
    expect(listInbox(db, {}).some((row) => row.summary.includes("疑似卡死"))).toBe(true);
  });

  it("does not report it while its own blocking request waits for an answer", () => {
    askDecision();
    db.prepare("UPDATE items SET last_activity_at = datetime('now', '-20 minutes') WHERE id = ?").run(itemId);
    const watchdog = createWatchdog(db, { stallMs: 15 * 60_000 });
    watchdog.check();
    watchdog.check();
    expect(listInbox(db, {}).some((row) => row.summary.includes("疑似卡死"))).toBe(false);
  });
});
