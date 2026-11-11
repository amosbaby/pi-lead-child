// 外部工人领单的整条路（.scratch/external-worker-hub/spec.md P1-2、P1-5、P1-6），落库的全流程：
//   Slack 消息 → 卡 → Lead 派活（external 模式下派单器只建工单、不建 Run）→ 工人 worker.claim → attach_session → report →
//   complete → 工单进 review。每一步 TicketSummary（列表和详情同一份）、内核的工单视图都按 protocol 的 schema 校验，
//   stage、hasRun、runtime 跟着变。工人的外部 Run 不起进程，daemon 重启的孤儿回收也不碰它。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { Value } from "typebox/value";
import { tempDir } from "@pi-lead-child/core/testing";
import { EXTERNAL_RUNTIME_ID, KernelTicketSchema, TicketSummarySchema } from "@pi-lead-child/protocol";
import {
  ChannelHub, ChannelRegistry, createCoordinator, createSlackChannelAdapter, executionModeMessages, runTicketAction, runWorkerTrack,
  setExecutionMode, workerTicket, type TicketActionCaller,
} from "@pi-lead-child/engine";
import { cardIdOf, FakeSlack, scriptedSmartModel } from "@pi-lead-child/engine/testing";
import { createControlPlaneService } from "@pi-lead-child/gateway";
import {
  createLoopbackBinding, createPairing, getChannelCard, getItem, getLatestOutcomeSnapshot, listActivities, listEvents, listInbox, listRuns,
  openDb, redeemPairing, ticketSources, type Db,
} from "@pi-lead-child/store";
import { RuntimeRegistry } from "@pi-lead-child/runtime";
import { MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";
import { createAgentTaskDispatcher } from "../src/agent-tasks.js";
import { recoverOrphans, startDaemon } from "../src/server.js";

let dir: string;
let db: Db;
let slack: FakeSlack;
const clock = new Date("2026-11-12T09:00:00.000Z");
const hubs: ChannelHub[] = [];

beforeEach(() => {
  dir = tempDir("plc-worker-flow-");
  db = openDb(join(dir, "plc.db"));
  slack = new FakeSlack({ now: () => clock, users: { U0NINA: { name: "Nina" } } });
});

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.idle();
  db.close();
});

function agentTasks() {
  return createAgentTaskDispatcher({
    db, dbPath: join(dir, "plc.db"), dataDir: dir, resolveLocalRepo: () => null, ownerName: () => "Ethan",
    connections: { runReads: () => ({ records: () => [] }), releaseRun: () => {} } as never,
    sessionFactory: async () => { throw new Error("no model in this test"); },
  });
}

function hub(dispatcher: ReturnType<typeof agentTasks>): ChannelHub {
  const model = scriptedSmartModel({ answers: { ask_kind: "other", handling_verb: "looking", needs_user_now: 0.05 } });
  const instance = new ChannelHub({
    db,
    registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api, now: () => clock })]),
    credentials: { credential: async () => slack.credential },
    now: () => clock, push: () => {}, classifyTimeoutMs: 60_000, outboundRetryBaseMs: 1_000,
    smartModel: () => model,
    lead: { dispatcher, available: () => true },
    audit: { rate: 0 },
  });
  hubs.push(instance);
  return instance;
}

const runtime = () => ({ model: "stub/model", sessionId: "stub-session", busy: false, runningItemIds: [], aish: null });

// 列表和详情给的是同一份 TicketSummary，都符合线上的 schema；内核的工单视图也符合。
function summaryOf(itemId: number) {
  const controlPlane = createControlPlaneService(db, { runtime, now: () => clock });
  const detail = controlPlane.getItem(itemId)!.ticket;
  expect(Value.Check(TicketSummarySchema, detail)).toBe(true);
  expect(controlPlane.listItems({ view: "all" }).find((ticket) => ticket.id === itemId)).toEqual(detail);
  expect(Value.Check(KernelTicketSchema, controlPlane.getKernelTicket(itemId))).toBe(true);
  return detail;
}

describe("a Slack request handled by an external worker", () => {
  it("goes from the message to a card, a ticket, a claim, a session, a delivery and review", async () => {
    setExecutionMode(db, "external");
    const dispatcher = agentTasks();
    const channels = hub(dispatcher);

    // Slack 消息 → 卡 → Lead 派活：external 下派单器建了工单，没有 Run。
    const received = (await channels.receive("slack", slack.dm("U0NINA", "where is the retry policy documented?"))).items[0]!;
    await channels.idle();
    const cardId = cardIdOf(db, received)!;
    const event = listEvents(db, { kind: MESSAGE_EVENT_KIND }).filter((entry) => entry.payload.cardId === cardId).at(-1)!.seq;
    const dispatched = await channels.leadDispatch(event, { summary: "find where the retry policy is documented", intent: "knowledge" });
    await dispatcher.close();
    expect(dispatched).toMatchObject({ runId: null, deferred: true });
    const itemId = dispatched.itemId;
    expect(listRuns(db, itemId)).toEqual([]);
    expect(summaryOf(itemId)).toMatchObject({ stage: "ready", status: "ready", hasRun: false, runtime: { state: "idle", activeAttemptId: null } });
    // 来源：卡所在的对话、卡的锚点（线程的根或者开卡的那条消息）和在 Slack 里打开这条消息的链接（来源插件的 link()，和消息事件的
    // link 是同一个）；Nina 的消息，所以工单来自外部来源。
    const card = getChannelCard(db, cardId)!;
    const link = listEvents(db, { kind: MESSAGE_EVENT_KIND }).filter((entry) => entry.payload.cardId === cardId).at(-1)!.payload.link;
    expect(link).toMatch(/^https:\/\//);
    expect(ticketSources(db, itemId)).toEqual([expect.objectContaining({
      kind: "slack", conversation: card.objectKey, messageTs: card.replyTarget.thread_ts, url: link, externalKey: null,
    })]);
    expect(card.replyTarget.thread_ts).toEqual(expect.any(String));
    expect(db.prepare("SELECT external_origin FROM items WHERE id=?").get(itemId)).toEqual({ external_origin: 1 });

    // 工人领单：外部 Run，工单进 active。
    const { binding } = createLoopbackBinding(db, { name: "Ethan's Claude Code", scopes: ["worker"] });
    const ethan: TicketActionCaller = { kind: "worker", bindingId: binding.id, workerName: binding.display_name };
    const claim = await runTicketAction(db, { itemId, action: "worker.claim", caller: ethan });
    const runId = (claim.result as { runId: number }).runId;
    expect(listRuns(db, itemId)).toMatchObject([{ id: runId, runtime: EXTERNAL_RUNTIME_ID, state: "running" }]);
    expect(summaryOf(itemId)).toMatchObject({ stage: "active", status: "active", hasRun: true, runtime: { activeAttemptId: runId } });
    // 派单时算好的权限清单（没有 Run 挂不上 run_grants）：工人读工单时看得到，照它的范围做。
    expect(workerTicket(db, itemId, binding.id)).toMatchObject({
      grant: { intent: "knowledge", grant: { intent: "knowledge" }, labels: expect.any(Array), dropped: [] },
      sources: [{ kind: "slack", conversation: card.objectKey }],
    });

    // 挂会话、写进展：工单不动。
    await runTicketAction(db, { itemId, action: "worker.attach_session", input: { url: "claude://resume?session=abc", sessionId: "abc" }, caller: ethan });
    await runTicketAction(db, { itemId, action: "worker.report", input: { text: "found it in docs/retry.md" }, caller: ethan });
    expect(workerTicket(db, itemId, binding.id)).toMatchObject({
      stage: "active", claim: { runId, open: true, sessions: [{ url: "claude://resume?session=abc", sessionId: "abc" }] },
      reports: [{ text: "found it in docs/retry.md" }],
    });

    // daemon 重启：外部 Run 没有进程，不当孤儿回收。
    expect(recoverOrphans(db)).toBe(0);
    expect(listRuns(db, itemId)).toMatchObject([{ id: runId, state: "running" }]);
    expect(getItem(db, itemId)!.stage).toBe("active");

    // 交付：工单进 review，外部 Run 结束，成果在快照里。
    await runTicketAction(db, {
      itemId, action: "worker.complete", caller: ethan,
      input: { summary: "The retry policy is in docs/retry.md.", evidence: "read docs/retry.md", artifacts: ["https://github.com/acme/x/blob/main/docs/retry.md"] },
    });
    expect(listRuns(db, itemId)).toMatchObject([{ id: runId, state: "finished" }]);
    expect(getLatestOutcomeSnapshot(db, itemId)).toMatchObject({ executorRunId: runId, summary: "The retry policy is in docs/retry.md." });
    expect(summaryOf(itemId)).toMatchObject({ stage: "review", status: "review", hasRun: true, runtime: { activeAttemptId: null } });
    // 账本里 stage 的每一步都是 system 推的，带着工人的外部 Run。
    const transitions = listActivities(db, itemId, 1000).filter((activity) => activity.kind === "transition")
      .map((activity) => ({ actor: activity.actor, runId: activity.run_id, ...JSON.parse(activity.payload) }));
    expect(transitions).toMatchObject([
      { actor: "system", runId, from: "ready", to: "active" },
      { actor: "system", runId, from: "active", to: "review" },
    ]);
  });
});

// 派单器建的单一律是外部来源（失败时宁可多算外部）：通道 hub 记来源这一步没做成（这里直接调派单器，hub 那一步根本没跑），
// 两个分支（external 下只建单、self 下建单开跑）的工单都留着 external_origin = 1。
describe("the dispatcher on its own", () => {
  const request = {
    intent: "knowledge" as const, request: { source: "slack", requester: "Nina", summary: "find the retry policy" },
    untrusted: { message: "where is the retry policy?" }, scope: {}, callback: { kind: "channel", ref: "card:1:1" },
  };
  it("creates every ticket as external, deferred or started", async () => {
    setExecutionMode(db, "external");
    const dispatcher = agentTasks();
    const deferred = await dispatcher.dispatch(request);
    setExecutionMode(db, "self");
    const started = await dispatcher.dispatch(request);
    await dispatcher.close();
    expect(deferred).toMatchObject({ deferred: true, runId: null });
    expect(started.runId).toEqual(expect.any(Number));
    for (const itemId of [deferred.itemId, started.itemId]) {
      expect(db.prepare("SELECT external_origin FROM items WHERE id=?").get(itemId)).toEqual({ external_origin: 1 });
      expect(ticketSources(db, itemId)).toEqual([]);
    }
  });
});

// 工人从自己的会话建单（worker.track）：建单、来源、领取、挂会话一次做完，之后和领来的单一样交付。TicketSummary 跟着变。
describe("a worker tracking its own session", () => {
  it("creates, sources, claims and attaches in one call, then delivers to review", async () => {
    const { binding } = createLoopbackBinding(db, { name: "Ethan's Claude Code", scopes: ["worker"] });
    const ethan: TicketActionCaller = { kind: "worker", bindingId: binding.id, workerName: binding.display_name };
    const tracked = await runWorkerTrack(db, {
      caller: ethan, host: { liveItemIds: () => [] },
      input: { title: "PROJ-123 retry policy", sourceUrl: "https://acme.atlassian.net/browse/PROJ-123", sessionId: "s1" },
    });
    const { ticketId: itemId, runId } = tracked.result as { ticketId: number; runId: number };
    expect(ticketSources(db, itemId)).toMatchObject([{ kind: "jira", externalKey: "PROJ-123" }]);
    expect(db.prepare("SELECT external_origin FROM items WHERE id=?").get(itemId)).toEqual({ external_origin: 0 });
    expect(listRuns(db, itemId)).toMatchObject([{ id: runId, runtime: EXTERNAL_RUNTIME_ID, state: "running" }]);
    expect(summaryOf(itemId)).toMatchObject({ stage: "active", status: "active", hasRun: true, runtime: { activeAttemptId: runId } });
    expect(workerTicket(db, itemId, binding.id)).toMatchObject({ grant: null, claim: { sessions: [{ sessionId: "s1" }] } });

    await runTicketAction(db, {
      itemId, action: "worker.complete", caller: ethan, input: { summary: "documented the policy", evidence: "docs/retry.md updated" },
    });
    expect(summaryOf(itemId)).toMatchObject({ stage: "review", status: "review", hasRun: true, runtime: { activeAttemptId: null } });
    const transitions = listActivities(db, itemId, 1000).filter((activity) => activity.kind === "transition")
      .map((activity) => ({ actor: activity.actor, runId: activity.run_id, ...JSON.parse(activity.payload) }));
    expect(transitions).toMatchObject([
      { actor: "system", runId, from: "ready", to: "active" },
      { actor: "system", runId, from: "active", to: "review" },
    ]);
  });
});

// daemon 收到一条工单消息（chat.send），工单被外部工人领着：self 模式下也不开对话 Run、不交给 Lead；这一轮写明原因收口，
// 消息记在工单上，工人读工单时看得到。
describe("a ticket message on a claimed ticket in the daemon", () => {
  it("is saved for the worker, starts nothing and is not handed to Lead (self mode)", async () => {
    const dataDir = tempDir("plc-worker-chat-");
    const dbPath = join(dataDir, "plc.db");
    const store = openDb(dbPath);
    const itemId = createCoordinator({ db: store }).createRootItem({ title: "fix the retry", brief: "b", createdBy: "lead", project: "x" });
    const { binding } = createLoopbackBinding(store, { name: "Ethan's Claude Code", scopes: ["worker"] });
    const claim = await runTicketAction(store, {
      itemId, action: "worker.claim", caller: { kind: "worker", bindingId: binding.id, workerName: binding.display_name },
    });
    const runId = (claim.result as { runId: number }).runId;
    const daemon = await startDaemon({
      dataDir, dbPath, runtimeRegistry: new RuntimeRegistry([]),
      sessionFactory: (async () => ({
        modelName: "stub/lead",
        session: { sessionId: "lead", subscribe: () => () => {}, prompt: async () => {}, steer: async () => {}, followUp: async () => {}, dispose: () => {} },
      })) as never,
      gatewayPort: 0, log: () => {},
    });
    const issued = redeemPairing(store, createPairing(store, { name: "web", kind: "companion", scopes: ["chat", "tickets:view"] }).code);
    const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2`);
    const messages: any[] = [];
    socket.on("message", (raw) => messages.push(JSON.parse(String(raw))));
    try {
      await vi.waitFor(() => expect(messages.some((message) => message.type === "hello.v2")).toBe(true));
      socket.send(JSON.stringify({ type: "chat.send", id: "ask", protocolVersion: 2, message: "also update the docs", context: { ticketId: itemId } }));
      await vi.waitFor(() => expect(messages.find((message) => message.type === "command.result" && message.id === "ask"))
        .toMatchObject({ success: true }));
      await vi.waitFor(() => expect(store.prepare(
        "SELECT state, user_text, error FROM channel_turns WHERE item_id=? AND origin_kind LIKE '%:ticket-agent'",
      ).all(itemId)).toEqual([
        { state: "failed", user_text: "also update the docs", error: executionModeMessages("en").chatDeferred("external") },
      ]));
      expect(listRuns(store, itemId).map((run) => run.id)).toEqual([runId]);
      expect(listInbox(store, {}).filter((row) => JSON.parse(row.payload).kind === "ticket_message_undelivered")).toEqual([]);
      expect(workerTicket(store, itemId, binding.id).userMessages.map((note) => note.text)).toEqual(["also update the docs"]);
    } finally {
      socket.close();
      await daemon.close();
      store.close();
    }
  }, 30_000);
});
