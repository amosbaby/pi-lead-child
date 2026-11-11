// 外部工人领单和回写（.scratch/external-worker-hub/spec.md P1-2、P1-4、P1-5）。工人是带 worker 权限的配对凭证，
// 经工单操作层（runTicketAction，caller 是 worker）调用 worker.claim / attach_session / report / complete / hand_back。
// 领取 = 建一个 runtime=external 的 Run（不起进程），工单 ready/blocked → active 由 system 推。
// 核对：
//   - 领取建外部 Run、工单进 active；同一张单不能被领两次（拒绝里写着领走它的工人）；paused 时不让领；
//   - 领取时把这张单还排着的派发请求结掉（否则切回 self 会再跑一遍工人领走的单）；
//   - 暂停的 Run 留在 active 的单也能领（领取时把那个 Run 关掉）；
//   - 只有领走它的工人能回写；完成进 review、交回进 blocked + needs_user，都关掉外部 Run；
//   - 会话链接只收 https 和 claude；
//   - 没有 worker 权限的凭证不能领；工人只能做工人的操作，页面和 Lead 也不能替工人领单；
//   - ticket.release（用户、Lead）放掉被领走的单；
//   - 读：workerTicket 只给领走它的工人看，listTickets 按 mine / needs_me / active / recent 筛；
//   - daemon 重启时外部 Run 不走接管和孤儿回收（它没有进程）。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { EXTERNAL_RUNTIME_ID, type Scope, type WorkerTicketFilter } from "@pi-lead-child/protocol";
import {
  addActivity, addTicketSource, createItem, createLoopbackBinding, createRun, getItem, getLatestOutcomeSnapshot, listActivities,
  listRuns, openDb, revokeBinding, runUsageBreakdown, setHandling, transition, updateRun, type Db,
} from "@pi-lead-child/store";
import {
  createDispatcher, listTickets, planRestartRecovery, runTicketAction, setExecutionMode, TicketActionError, workerTicket,
  type TicketActionCaller,
} from "../src/index.js";

let db: Db;
let dir: string;

beforeEach(() => {
  dir = tempDir("plc-worker-queue-");
  db = openDb(join(dir, "plc.db"));
});

afterEach(() => {
  db.close();
});

type Worker = Extract<TicketActionCaller, { kind: "worker" }>;

function worker(name: string, scopes: Scope[] = ["worker"]): Worker {
  const { binding } = createLoopbackBinding(db, { name, scopes });
  return { kind: "worker", bindingId: binding.id, workerName: name };
}

function ticket(title = "fix the retry policy"): number {
  return createItem(db, { title, brief: "the retry policy drops the last attempt", createdBy: "user" });
}

const act = (caller: TicketActionCaller, itemId: number, action: string, input: unknown = {}, reason?: string) =>
  runTicketAction(db, { itemId, action, input, caller, ...(reason ? { reason } : {}) });

const refusal = (promise: Promise<unknown>) => promise.then(
  () => { throw new Error("expected a refusal"); },
  (error: unknown) => {
    if (!(error instanceof TicketActionError)) throw error;
    return { code: error.code, message: error.message };
  },
);

const metadata = (runId: number) => JSON.parse(listRuns(db, getRunItem(runId)).find((run) => run.id === runId)!.metadata);
const getRunItem = (runId: number) => (db.prepare("SELECT item_id FROM runs WHERE id=?").get(runId) as { item_id: number }).item_id;
const decisions = (itemId: number) => listActivities(db, itemId, 1000)
  .map((activity) => ({ actor: activity.actor, kind: activity.kind, runId: activity.run_id, payload: JSON.parse(activity.payload) }));

async function claimed(by: Worker, itemId = ticket()): Promise<{ itemId: number; runId: number }> {
  const outcome = await act(by, itemId, "worker.claim");
  return { itemId, runId: (outcome.result as { runId: number }).runId };
}

describe("worker.claim", () => {
  it("claim creates an external Run and moves the ticket to active", async () => {
    const ethan = worker("Ethan's Claude Code");
    const itemId = ticket();
    const outcome = await act(ethan, itemId, "worker.claim");
    const runs = listRuns(db, itemId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runtime: EXTERNAL_RUNTIME_ID, role: "executor", state: "running", pid: null });
    expect(JSON.parse(runs[0]!.metadata)).toEqual({ bindingId: ethan.bindingId, claimMode: "manual", sessions: [] });
    expect(outcome.result).toMatchObject({ ticketId: itemId, runId: runs[0]!.id, stage: "active" });
    expect(getItem(db, itemId)!.stage).toBe("active");
    // ready → active 是 system 在建 Run 时推的，带着这个 Run。
    expect(decisions(itemId)).toContainEqual(expect.objectContaining({
      actor: "system", kind: "transition", runId: runs[0]!.id, payload: expect.objectContaining({ from: "ready", to: "active" }),
    }));
  });

  it("claim twice is refused", async () => {
    const ethan = worker("Ethan's Claude Code");
    const nina = worker("Nina's Codex");
    const { itemId } = await claimed(ethan);
    for (const who of [nina, ethan]) {
      const refused = await refusal(act(who, itemId, "worker.claim"));
      expect(refused.code).toBe("unavailable");
      expect(refused.message).toContain("已被 Ethan's Claude Code 领走");
    }
    expect(listRuns(db, itemId)).toHaveLength(1);
  });

  it("claims a blocked ticket back into active", async () => {
    const itemId = ticket();
    transition(db, { itemId, to: "active", actor: "system", reason: "started" });
    transition(db, { itemId, to: "blocked", actor: "system", reason: "run reclaimed" });
    await claimed(worker("Ethan's Claude Code"), itemId);
    expect(getItem(db, itemId)!.stage).toBe("active");
  });

  it("paused mode refuses claim", async () => {
    setExecutionMode(db, "paused");
    const itemId = ticket();
    const refused = await refusal(act(worker("Ethan's Claude Code"), itemId, "worker.claim"));
    expect(refused.code).toBe("unavailable");
    expect(listRuns(db, itemId)).toEqual([]);
    expect(getItem(db, itemId)!.stage).toBe("ready");
  });

  // CARRY (a)：external 下排着的派发请求一直留在队列里。工人领走以后不结掉，切回 self 时派发器会再跑一遍这张单。
  it("settles the ticket's pending dispatch requests, so switching back to self does not run it again", async () => {
    setExecutionMode(db, "external");
    const itemId = ticket();
    const requestId = createDispatcher(db).request({
      itemId, role: "executor", purpose: "execution", runtime: "codex", trigger: "user-rework", idempotencyKey: "carry-a",
    });
    expect(createDispatcher(db).claimNext()).toBeNull();
    await claimed(worker("Ethan's Claude Code"), itemId);
    expect(db.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(requestId)).toEqual({ state: "cancelled" });
    expect(decisions(itemId)).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({ decision: "worker_claim_settled_dispatch", dispatchRequestIds: [requestId] }),
    }));
    setExecutionMode(db, "self");
    expect(createDispatcher(db).claimNext()).toBeNull();
    expect(listRuns(db, itemId).map((run) => run.runtime)).toEqual([EXTERNAL_RUNTIME_ID]);
  });

  // CARRY (b)：external 下恢复一个暂停的 Run 被推迟，工单留在 active，Run 留在 paused。工人要能领它。
  it("claims a ticket left active with a paused Run, closing that Run", async () => {
    const itemId = ticket();
    const paused = createRun(db, { itemId, runtime: "codex" });
    transition(db, { itemId, to: "active", actor: "system", reason: "started", runId: paused });
    updateRun(db, paused, { state: "running" });
    db.prepare("UPDATE runs SET state='paused' WHERE id=?").run(paused);
    setExecutionMode(db, "external");
    const { runId } = await claimed(worker("Ethan's Claude Code"), itemId);
    expect(listRuns(db, itemId).map((run) => [run.id, run.state])).toEqual([[paused, "stopped"], [runId, "running"]]);
    expect(getItem(db, itemId)!.stage).toBe("active");
  });

  it("refuses a ticket another Run is working on", async () => {
    const itemId = ticket();
    const running = createRun(db, { itemId, runtime: "codex" });
    transition(db, { itemId, to: "active", actor: "system", reason: "started", runId: running });
    updateRun(db, running, { state: "running" });
    const refused = await refusal(act(worker("Ethan's Claude Code"), itemId, "worker.claim"));
    expect(refused.code).toBe("unavailable");
    expect(listRuns(db, itemId)).toHaveLength(1);
  });

  it("refuses a ticket waiting for the user's acceptance", async () => {
    const ethan = worker("Ethan's Claude Code");
    const { itemId } = await claimed(ethan);
    await act(ethan, itemId, "worker.complete", { summary: "done", evidence: "tests pass" });
    expect((await refusal(act(worker("Nina's Codex"), itemId, "worker.claim"))).code).toBe("unavailable");
  });
});

describe("who may call the worker actions", () => {
  it("refuses a credential without the worker scope, and a revoked worker", async () => {
    const itemId = ticket();
    const page = worker("Mac web", ["chat", "tickets:view", "tickets:create"]);
    expect((await refusal(act(page, itemId, "worker.claim"))).code).toBe("forbidden");
    const ethan = worker("Ethan's Claude Code");
    revokeBinding(db, ethan.bindingId);
    expect((await refusal(act(ethan, itemId, "worker.claim"))).code).toBe("forbidden");
    expect(listRuns(db, itemId)).toEqual([]);
  });

  it("lets a worker do only the worker actions, and nobody else do them", async () => {
    const ethan = worker("Ethan's Claude Code");
    const itemId = ticket();
    expect((await refusal(act(ethan, itemId, "cancel"))).code).toBe("forbidden");
    expect((await refusal(act(ethan, itemId, "ticket.release"))).code).toBe("forbidden");
    expect((await refusal(act({ kind: "user" }, itemId, "worker.claim"))).code).toBe("forbidden");
    expect((await refusal(act({ kind: "lead", turnId: null }, itemId, "worker.claim", {}, "the user asked"))).code).toBe("forbidden");
    expect(getItem(db, itemId)!.stage).toBe("ready");
    expect(listRuns(db, itemId)).toEqual([]);
  });

  it("checks the input of a worker action", async () => {
    const ethan = worker("Ethan's Claude Code");
    const { itemId } = await claimed(ethan);
    expect((await refusal(act(ethan, itemId, "worker.report", { text: "" }))).code).toBe("invalid_input");
    expect((await refusal(act(ethan, itemId, "worker.complete", { summary: "done" }))).code).toBe("invalid_input");
  });
});

describe("writing back", () => {
  it("another worker cannot complete my ticket", async () => {
    const ethan = worker("Ethan's Claude Code");
    const nina = worker("Nina's Codex");
    const { itemId, runId } = await claimed(ethan);
    for (const [action, input] of [
      ["worker.complete", { summary: "done", evidence: "tests pass" }],
      ["worker.hand_back", { reason: "not mine" }],
      ["worker.report", { text: "progress" }],
      ["worker.attach_session", { sessionId: "abc" }],
    ] as const) {
      expect((await refusal(act(nina, itemId, action, input))).code).toBe("forbidden");
    }
    expect(getItem(db, itemId)!.stage).toBe("active");
    expect(listRuns(db, itemId).find((run) => run.id === runId)!.state).toBe("running");
  });

  it("complete moves to review and closes the external Run", async () => {
    const ethan = worker("Ethan's Claude Code");
    const { itemId, runId } = await claimed(ethan);
    const outcome = await act(ethan, itemId, "worker.complete", {
      summary: "Fixed the retry policy.", evidence: "npm test: 42 passed", artifacts: ["https://github.com/acme/x/pull/7"],
    });
    expect(outcome.result).toMatchObject({ ticketId: itemId, runId, stage: "review" });
    expect(getItem(db, itemId)!.stage).toBe("review");
    expect(listRuns(db, itemId)).toMatchObject([{ id: runId, state: "finished", exit_code: 0 }]);
    expect(listRuns(db, itemId)[0]!.ended_at).not.toBeNull();
    // 成果复用执行者的成果快照：摘要和交付物在快照里，证据记在活动和 Run 上。
    expect(getLatestOutcomeSnapshot(db, itemId)).toMatchObject({
      executorRunId: runId, source: "agent_reported", summary: "Fixed the retry policy.",
      deliverables: [{ kind: "url", ref: "https://github.com/acme/x/pull/7" }],
    });
    expect(metadata(runId).completion).toEqual({
      summary: "Fixed the retry policy.", evidence: "npm test: 42 passed", artifacts: ["https://github.com/acme/x/pull/7"],
    });
    expect(decisions(itemId)).toContainEqual(expect.objectContaining({
      actor: "system", kind: "transition", runId, payload: expect.objectContaining({ from: "active", to: "review" }),
    }));
    // Run 结束以后不能再回写。
    expect((await refusal(act(ethan, itemId, "worker.report", { text: "one more thing" }))).code).toBe("forbidden");
  });

  it("hand_back sets needs_user and blocks", async () => {
    const ethan = worker("Ethan's Claude Code");
    const itemId = ticket();
    setHandling(db, itemId, { handling: "auto", reason: "looks routine", complexity: "medium" });
    const { runId } = await claimed(ethan, itemId);
    await act(ethan, itemId, "worker.hand_back", { reason: "needs a product decision on the retry limit" });
    const row = db.prepare("SELECT stage, handling, handling_reason, complexity FROM items WHERE id=?").get(itemId);
    expect(row).toEqual({
      stage: "blocked", handling: "needs_user", handling_reason: "needs a product decision on the retry limit", complexity: "medium",
    });
    expect(listRuns(db, itemId)).toMatchObject([{ id: runId, state: "stopped" }]);
    // 交回的单可以再领。
    await claimed(worker("Nina's Codex"), itemId);
    expect(getItem(db, itemId)!.stage).toBe("active");
  });

  it("attach_session rejects javascript: and file: urls", async () => {
    const ethan = worker("Ethan's Claude Code");
    const { itemId, runId } = await claimed(ethan);
    for (const url of ["javascript:alert(1)", "file:///Users/alice/.ssh/config", "http://example.com/s", "not a url"]) {
      expect((await refusal(act(ethan, itemId, "worker.attach_session", { url })))).toMatchObject({ code: "invalid_input" });
    }
    expect((await refusal(act(ethan, itemId, "worker.attach_session", {})))).toMatchObject({ code: "invalid_input" });
    await act(ethan, itemId, "worker.attach_session", { url: "https://claude.example.com/code/session_1" });
    await act(ethan, itemId, "worker.attach_session", { url: "claude://resume?session=abc", sessionId: "abc-123" });
    expect(metadata(runId).sessions).toEqual([
      { url: "https://claude.example.com/code/session_1", sessionId: null, attachedAt: expect.any(String) },
      { url: "claude://resume?session=abc", sessionId: "abc-123", attachedAt: expect.any(String) },
    ]);
    // 会话 id 只记在 metadata 里：Run 的 external_session_id 是 CLI 续接用的，外部 Run 不能被续接。
    expect(listRuns(db, itemId)[0]!.external_session_id).toBeNull();
  });

  it("report writes a worker_report and records usage on the external Run", async () => {
    const ethan = worker("Ethan's Claude Code");
    const { itemId, runId } = await claimed(ethan);
    await act(ethan, itemId, "worker.report", { text: "found the bug in backoff()" });
    await act(ethan, itemId, "worker.report", {
      text: "fixed, running tests", usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 600, costUsd: 0.05 },
    });
    const reports = decisions(itemId).filter((activity) => activity.payload.route === "worker_report");
    expect(reports).toMatchObject([
      { actor: "child", kind: "comment", runId, payload: { content: "found the bug in backoff()", workerName: "Ethan's Claude Code" } },
      { actor: "child", kind: "comment", runId, payload: { content: "fixed, running tests" } },
    ]);
    expect(runUsageBreakdown(db, runId)).toMatchObject({ tokens: 1200, costUsd: 0.05, cacheReadTokens: 600, outputTokens: 200 });
    expect(getItem(db, itemId)).toMatchObject({ total_tokens: 1200, total_cost_usd: 0.05 });
  });
});

describe("ticket.release", () => {
  it("closes the external Run and puts the ticket back to ready, from the page and from Lead", async () => {
    for (const caller of [{ kind: "user" } as const, { kind: "lead", turnId: null } as const]) {
      const { itemId, runId } = await claimed(worker(`worker for ${caller.kind}`));
      await act(caller, itemId, "ticket.release", {}, "no progress for a day");
      expect(getItem(db, itemId)!.stage).toBe("ready");
      expect(listRuns(db, itemId)).toMatchObject([{ id: runId, state: "stopped" }]);
      expect(decisions(itemId)).toContainEqual(expect.objectContaining({
        actor: caller.kind, kind: "transition", payload: expect.objectContaining({ from: "active", to: "ready" }),
      }));
    }
  });

  it("is unavailable when no worker holds the ticket", async () => {
    expect((await refusal(act({ kind: "user" }, ticket(), "ticket.release"))).code).toBe("unavailable");
  });
});

describe("reading", () => {
  it("workerTicket shows the sources, the judgment, the reports and the user's messages since the claim", async () => {
    const ethan = worker("Ethan's Claude Code");
    const itemId = ticket();
    addTicketSource(db, { itemId, kind: "slack", url: "https://acme.example.com/archives/C1/p1", conversation: "C1", messageTs: "1.2" });
    setHandling(db, itemId, { handling: "auto", reason: "a routine fix", complexity: "simple" });
    addActivity(db, { itemId, actor: "user", kind: "comment", payload: { content: "before the claim" } });
    const { runId } = await claimed(ethan, itemId);
    await act(ethan, itemId, "worker.attach_session", { sessionId: "abc-123" });
    await act(ethan, itemId, "worker.report", { text: "on it" });
    addActivity(db, { itemId, actor: "user", kind: "comment", payload: { content: "also update the docs", route: "execution_deferred" } });
    const view = workerTicket(db, itemId, ethan.bindingId);
    expect(view).toMatchObject({
      ticketId: itemId, title: "fix the retry policy", brief: "the retry policy drops the last attempt", stage: "active",
      handling: "auto", handlingReason: "a routine fix", complexity: "simple",
      sources: [{ kind: "slack", url: "https://acme.example.com/archives/C1/p1" }],
      claim: { runId, bindingId: ethan.bindingId, workerName: "Ethan's Claude Code", claimMode: "manual", open: true,
        sessions: [{ url: null, sessionId: "abc-123" }] },
      reports: [{ text: "on it" }],
      userMessages: [{ text: "also update the docs" }],
    });
    expect(() => workerTicket(db, itemId, worker("Nina's Codex").bindingId)).toThrow(TicketActionError);
    expect(() => workerTicket(db, ticket("not claimed"), ethan.bindingId)).toThrow(TicketActionError);
  });

  // 筛选（ruling R15）：needs_me 是要用户拿主意的单（handling=needs_user，包括工人交回的），claimable 是现在能领的单。
  it("listTickets filters mine, needs_me, claimable, active and recent", async () => {
    const ethan = worker("Ethan's Claude Code");
    const nina = worker("Nina's Codex");
    const waiting = ticket("waiting");
    const mine = (await claimed(ethan, ticket("mine"))).itemId;
    const theirs = (await claimed(nina, ticket("theirs"))).itemId;
    const finished = (await claimed(ethan, ticket("finished"))).itemId;
    await act(ethan, finished, "worker.complete", { summary: "done", evidence: "checked" });
    const handedBack = (await claimed(nina, ticket("handed back"))).itemId;
    await act(nina, handedBack, "worker.hand_back", { reason: "needs a product decision" });
    // Lead 判断要用户拿主意、还没人领的单也在 needs_me；被领着的不在。
    const judged = ticket("judged needs_user");
    setHandling(db, judged, { handling: "needs_user", reason: "touches billing" });
    setHandling(db, mine, { handling: "needs_user", reason: "touches billing" });
    const ids = (filter: WorkerTicketFilter) => listTickets(db, filter, ethan.bindingId).map((row) => row.ticketId);
    expect(ids("mine")).toEqual([mine]);
    expect(ids("needs_me").sort()).toEqual([handedBack, judged].sort());
    expect(ids("claimable").sort()).toEqual([waiting, handedBack, judged].sort());
    expect(ids("needs_me")).not.toContain(waiting);
    expect(ids("active").sort()).toEqual([mine, theirs].sort());
    expect(ids("recent")).toEqual([finished]);
    expect(listTickets(db, "active", ethan.bindingId).find((row) => row.ticketId === theirs)).toMatchObject({
      title: "theirs", stage: "active", claimedBy: "Nina's Codex", sessions: [],
    });
    expect(listTickets(db, "needs_me", ethan.bindingId).find((row) => row.ticketId === handedBack)).toMatchObject({
      stage: "blocked", handling: "needs_user", claimedBy: null,
    });
  });
});

describe("a daemon restart", () => {
  // CARRY (c)：外部 Run 没有进程。重启时既不接管它，也不当孤儿回收（否则工人领着的单会被记成崩溃、打成 blocked）。
  it("leaves external Runs out of adoption and orphan reclaim", async () => {
    const { runId } = await claimed(worker("Ethan's Claude Code"));
    const candidates = await planRestartRecovery(db, { launchRoot: join(dir, "launches") });
    expect(candidates.map((candidate) => candidate.run.id)).not.toContain(runId);
  });
});
