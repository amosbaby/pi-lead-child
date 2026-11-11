// 外部工人领单的整条路（.scratch/external-worker-hub/spec.md P1-2、P1-5、P1-6），落库的全流程：
//   Slack 消息 → 卡 → Lead 派活（external 模式下派单器只建工单、不建 Run）→ 工人 worker.claim → attach_session → report →
//   complete → 工单进 review。每一步 TicketSummary（列表和详情同一份）、内核的工单视图都按 protocol 的 schema 校验，
//   stage、hasRun、runtime 跟着变。工人的外部 Run 不起进程，daemon 重启的孤儿回收也不碰它。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { tempDir } from "@pi-lead-child/core/testing";
import { EXTERNAL_RUNTIME_ID, KernelTicketSchema, TicketSummarySchema } from "@pi-lead-child/protocol";
import {
  ChannelHub, ChannelRegistry, createSlackChannelAdapter, runTicketAction, setExecutionMode, workerTicket,
  type TicketActionCaller,
} from "@pi-lead-child/engine";
import { cardIdOf, FakeSlack, scriptedSmartModel } from "@pi-lead-child/engine/testing";
import { createControlPlaneService } from "@pi-lead-child/gateway";
import {
  createLoopbackBinding, getItem, getLatestOutcomeSnapshot, listActivities, listEvents, listRuns, openDb, type Db,
} from "@pi-lead-child/store";
import { MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";
import { createAgentTaskDispatcher } from "../src/agent-tasks.js";
import { recoverOrphans } from "../src/server.js";

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

    // 工人领单：外部 Run，工单进 active。
    const { binding } = createLoopbackBinding(db, { name: "Ethan's Claude Code", scopes: ["worker"] });
    const ethan: TicketActionCaller = { kind: "worker", bindingId: binding.id, workerName: binding.display_name };
    const claim = await runTicketAction(db, { itemId, action: "worker.claim", caller: ethan });
    const runId = (claim.result as { runId: number }).runId;
    expect(listRuns(db, itemId)).toMatchObject([{ id: runId, runtime: EXTERNAL_RUNTIME_ID, state: "running" }]);
    expect(summaryOf(itemId)).toMatchObject({ stage: "active", status: "active", hasRun: true, runtime: { activeAttemptId: runId } });

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
