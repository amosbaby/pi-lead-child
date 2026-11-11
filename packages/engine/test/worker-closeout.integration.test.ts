// 不记两遍账（.scratch/external-worker-hub/spec.md P1-6，Task 11）：工单关联的会话卡结束成「你用草稿回了」（replied）或
// 「你在来源里自己回了」（resolved_elsewhere）时，工单收尾：关掉外部工人的 Run，system 推到 review，记一条 replied_in_source；
// 只读类（代查 purpose=lookup）回复已经发出，接着 review → done；交付类停在 review 等你验收。「你在来源里说了一句但没回答」
// （replying_self）不算。已经 done 的工单什么也不做（核心不变量：终态是权威）。
// 也包括 CARRY→Task 11：外部 / 暂停模式下派的子 agent 工单在卡上留的排队记录（channel_lookups queued，run_id null）
// 什么时候结束：只要工单还能由外部工人接着做（ready / active / blocked，并且不是 self 模式或者有人领着）就留着，否则结束。
// 真的 SQLite、真的通道 hub 和 Slack 来源插件、假的 Slack、假的 SmartModel、假的派单器。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { EXTERNAL_RUNTIME_ID, MESSAGE_EVENT_KIND, type Scope } from "@pi-lead-child/protocol";
import {
  createItem, createLoopbackBinding, getActiveLookupForCard, getChannelCard, getItem, getLatestLookupForCard, listActivities, listEvents,
  listRuns, openDb, transition, type Db,
} from "@pi-lead-child/store";
import {
  ChannelHub, ChannelRegistry, createSlackChannelAdapter, onCardDisposed, recordCardTicketSource, runTicketAction, runUiAction, setExecutionMode,
  TicketActionError, type TicketActionCaller,
} from "../src/index.js";
import { cardIdOf, FakeAgentTaskDispatcher, FakeSlack, scriptedSmartModel } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let clock: Date;
let dispatcher: FakeAgentTaskDispatcher;
const hubs: ChannelHub[] = [];

beforeEach(() => {
  db = openDb(join(tempDir("plc-worker-closeout-"), "plc.db"));
  clock = new Date("2026-11-12T10:00:00.000Z");
  slack = new FakeSlack({ now: () => clock, users: { U0NINA: { name: "Nina" } } });
  dispatcher = new FakeAgentTaskDispatcher(db, { "acme/x": "/Users/alice/x" });
  setExecutionMode(db, "external");
});

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.idle();
  db.close();
});

// 你在来源里说的话：带「看了」的回答了对方（resolved_elsewhere），别的只是说一句（replying_self）。
function hub(): ChannelHub {
  const model = scriptedSmartModel({
    answers: {
      ask_kind: "other", handling_verb: "looking", needs_user_now: 0.05, target_repo: "acme/x",
      answers_request: (state) => (state.includes("看了") ? 0.9 : 0.1),
    },
  });
  const instance = new ChannelHub({
    db,
    registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api, now: () => clock })]),
    credentials: { credential: async () => slack.credential },
    now: () => clock, push: () => undefined, classifyTimeoutMs: 60_000, outboundRetryBaseMs: 1_000,
    smartModel: () => model,
    lookupCandidates: () => [{ repo: "acme/x", root: "/Users/alice/x", github: { owner: "acme", repo: "x" } }],
    lead: { dispatcher, available: () => true },
    audit: { rate: 0 },
  });
  dispatcher.hub = instance;
  hubs.push(instance);
  return instance;
}

type Worker = Extract<TicketActionCaller, { kind: "worker" }>;
function worker(name = "Ethan's Claude Code", scopes: Scope[] = ["worker"]): Worker {
  const { binding } = createLoopbackBinding(db, { name, scopes });
  return { kind: "worker", bindingId: binding.id, workerName: name };
}
const act = (caller: TicketActionCaller, itemId: number, action: string, input: unknown = {}) =>
  runTicketAction(db, { itemId, action, input, caller });

async function question(channels: ChannelHub, text = "订单服务的重试上限是多少？") {
  const item = (await channels.receive("slack", slack.dm("U0NINA", text))).items[0]!;
  await channels.idle();
  return cardIdOf(db, item)!;
}
const eventOf = (cardId: number) => listEvents(db, { kind: MESSAGE_EVENT_KIND }).filter((event) => event.payload.cardId === cardId).at(-1)!.seq;

// Lead 在外部模式下派的子 agent 工单（ruling R12）：只读类（purpose=lookup），ready，没有 Run，卡上一条排着的记录。
async function deferredTicket(channels: ChannelHub, cardId: number): Promise<number> {
  dispatcher.deferNext = true;
  const dispatched = await channels.leadDispatch(eventOf(cardId), { summary: "查订单服务的重试上限", intent: "knowledge" });
  await channels.idle();
  return dispatched.itemId;
}

async function userReplies(channels: ChannelHub, text: string) {
  await channels.receive("slack", slack.selfReply("D0NINA", text));
  await channels.idle();
}

const decisions = (itemId: number, name: string) => listActivities(db, itemId, 1000)
  .map((activity) => ({ kind: activity.kind, actor: activity.actor, payload: JSON.parse(activity.payload) as Record<string, unknown> }))
  .filter((activity) => activity.kind === "decision" && activity.payload.decision === name);
const transitions = (itemId: number) => listActivities(db, itemId, 1000)
  .filter((activity) => activity.kind === "transition")
  .map((activity) => {
    const payload = JSON.parse(activity.payload) as { from: string; to: string };
    return `${payload.from}->${payload.to} ${activity.actor}`;
  });
const externalRuns = (itemId: number) => listRuns(db, itemId).filter((run) => run.runtime === EXTERNAL_RUNTIME_ID);

async function refusal(promise: Promise<unknown>): Promise<{ code: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TicketActionError) return { code: error.code };
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("a card you answered in the source closes out its ticket", () => {
  it("closes a claimed read-only ticket: the worker's Run stops, review then done, replied_in_source, the card's queued record ends", async () => {
    const channels = hub();
    const cardId = await question(channels);
    const itemId = await deferredTicket(channels, cardId);
    const ethan = worker();
    await act(ethan, itemId, "worker.claim");
    expect(getItem(db, itemId)!.stage).toBe("active");

    await userReplies(channels, "看了，上限是 5 次");

    expect(getChannelCard(db, cardId)!.state).toBe("resolved_elsewhere");
    expect(getItem(db, itemId)!.stage).toBe("done");
    expect(externalRuns(itemId).map((run) => run.state)).toEqual(["stopped"]);
    expect(transitions(itemId)).toEqual(["ready->active system", "active->review system", "review->done system"]);
    expect(decisions(itemId, "replied_in_source")).toMatchObject([{
      actor: "system", payload: { cardId, cardState: "resolved_elsewhere", from: "active", to: "done", closedRunId: externalRuns(itemId)[0]!.id },
    }]);
    // 卡上排着的记录结束了（「已结束」）：这张卡不再占着唯一的进行中记录。
    expect(getActiveLookupForCard(db, cardId)).toBeUndefined();
    expect(getLatestLookupForCard(db, cardId)).toMatchObject({ state: "finished", itemId });
    // 工人后来再交：单已经不是它领着的了，不会再走一次 review。
    expect(await refusal(act(ethan, itemId, "worker.complete", { summary: "上限 5 次", evidence: "config/retry.ts" }))).toMatchObject({ code: "forbidden" });
    expect(transitions(itemId)).toHaveLength(3);
  });

  it("closes an unclaimed read-only ticket that still waits in ready the same way", async () => {
    const channels = hub();
    const cardId = await question(channels);
    const itemId = await deferredTicket(channels, cardId);

    await userReplies(channels, "看了，上限是 5 次");

    expect(getItem(db, itemId)!.stage).toBe("done");
    expect(transitions(itemId)).toEqual(["ready->review system", "review->done system"]);
    expect(decisions(itemId, "replied_in_source")).toMatchObject([{ payload: { from: "ready", to: "done", closedRunId: null } }]);
    expect(getLatestLookupForCard(db, cardId)).toMatchObject({ state: "finished" });
    // 不能再领。
    expect(await refusal(act(worker(), itemId, "worker.claim"))).toMatchObject({ code: "unavailable" });
  });

  it("stops a delivery ticket in review when you replied with the card (replied), and does not mark it done", async () => {
    const channels = hub();
    const cardId = await question(channels, "能帮忙把重试上限改成 5 吗？");
    // Lead 在这条消息叫醒的一轮里建的单：来源记成这张卡（ticket_sources，对话和锚点）。
    const itemId = createItem(db, { title: "把重试上限改成 5", brief: "acme/x 的重试上限", createdBy: "lead" });
    recordCardTicketSource(db, { itemId, cardId });
    const ethan = worker();
    await act(ethan, itemId, "worker.claim");

    await channels.act(cardId, "send_edited", { by: "user via test", text: "好的，我让人改了" });
    await channels.idle();

    expect(getChannelCard(db, cardId)!.state).toBe("replied");
    expect(getItem(db, itemId)!.stage).toBe("review");
    expect(externalRuns(itemId).map((run) => run.state)).toEqual(["stopped"]);
    expect(transitions(itemId)).toEqual(["ready->active system", "active->review system"]);
    expect(decisions(itemId, "replied_in_source")).toMatchObject([{ payload: { cardId, cardState: "replied", from: "active", to: "review" } }]);
  });

  it("does nothing when you only said something in the source without answering (replying_self)", async () => {
    const channels = hub();
    const cardId = await question(channels);
    const itemId = await deferredTicket(channels, cardId);
    await act(worker(), itemId, "worker.claim");

    await userReplies(channels, "收到，稍等");

    expect(getChannelCard(db, cardId)!.state).toBe("replying_self");
    expect(getItem(db, itemId)!.stage).toBe("active");
    expect(externalRuns(itemId).map((run) => run.state)).toEqual(["running"]);
    expect(decisions(itemId, "replied_in_source")).toEqual([]);
    expect(getActiveLookupForCard(db, cardId)).toMatchObject({ state: "queued", itemId });
    // 收尾的函数自己也不认 replying_self（hub 在这种处置下本来就不调它）。
    expect(onCardDisposed(db, getChannelCard(db, cardId)!, { state: "replying_self" })).toEqual([]);
    expect(getItem(db, itemId)!.stage).toBe("active");
  });

  it("leaves a done ticket alone", async () => {
    const channels = hub();
    const cardId = await question(channels);
    const itemId = await deferredTicket(channels, cardId);
    const ethan = worker();
    await act(ethan, itemId, "worker.claim");
    await act(ethan, itemId, "worker.complete", { summary: "上限 5 次", evidence: "config/retry.ts" });
    transition(db, { itemId, to: "done", actor: "user", reason: "验收" });
    const before = listActivities(db, itemId, 1000).length;

    await userReplies(channels, "看了，上限是 5 次");

    expect(getChannelCard(db, cardId)!.state).toBe("resolved_elsewhere");
    expect(getItem(db, itemId)!.stage).toBe("done");
    expect(listActivities(db, itemId, 1000)).toHaveLength(before);
  });

  it("leaves a ticket whose own Run is running alone (self mode: the existing pipeline owns it)", async () => {
    setExecutionMode(db, "self");
    const channels = hub();
    const cardId = await question(channels);
    const dispatched = await channels.leadDispatch(eventOf(cardId), { summary: "查订单服务的重试上限", intent: "knowledge" });
    await channels.idle();
    const stage = getItem(db, dispatched.itemId)!.stage;

    await userReplies(channels, "看了，上限是 5 次");

    expect(getChannelCard(db, cardId)!.state).toBe("resolved_elsewhere");
    expect(getItem(db, dispatched.itemId)!.stage).toBe(stage);
    expect(decisions(dispatched.itemId, "replied_in_source")).toEqual([]);
  });
});

describe("a worker's complete on a read-only ticket and the reply", () => {
  it("goes to review on complete, then the system marks it done once you replied — one transition each", async () => {
    const channels = hub();
    const cardId = await question(channels);
    const itemId = await deferredTicket(channels, cardId);
    const ethan = worker();
    await act(ethan, itemId, "worker.claim");
    await act(ethan, itemId, "worker.complete", { summary: "上限 5 次", evidence: "config/retry.ts" });
    expect(getItem(db, itemId)!.stage).toBe("review");
    // 工人交了：卡上排着的记录结束，卡又能派活。
    expect(getActiveLookupForCard(db, cardId)).toBeUndefined();

    await userReplies(channels, "看了，上限是 5 次");

    expect(getItem(db, itemId)!.stage).toBe("done");
    expect(transitions(itemId)).toEqual(["ready->active system", "active->review system", "review->done system"]);
    expect(decisions(itemId, "replied_in_source")).toMatchObject([{ payload: { from: "review", to: "done", closedRunId: null } }]);
  });

  it("goes straight on to done when you had already replied before the worker completed", async () => {
    const channels = hub();
    const cardId = await question(channels);
    const itemId = await deferredTicket(channels, cardId);
    const ethan = worker();
    await act(ethan, itemId, "worker.claim");
    await act(ethan, itemId, "worker.hand_back", { reason: "需要你确认用哪个环境" });
    // 交回给你的单（blocked）不收尾：等你决定。
    await userReplies(channels, "看了，上限是 5 次");
    expect(getItem(db, itemId)!.stage).toBe("blocked");

    await act(ethan, itemId, "worker.claim");
    await act(ethan, itemId, "worker.complete", { summary: "上限 5 次", evidence: "config/retry.ts" });

    expect(getItem(db, itemId)!.stage).toBe("done");
    expect(transitions(itemId).slice(-2)).toEqual(["active->review system", "review->done system"]);
    expect(decisions(itemId, "replied_in_source")).toMatchObject([{ payload: { cardId, from: "review", to: "done" } }]);
  });

  it("keeps a delivery ticket in review after complete even when you had replied", async () => {
    const channels = hub();
    const cardId = await question(channels, "能帮忙把重试上限改成 5 吗？");
    const itemId = createItem(db, { title: "把重试上限改成 5", brief: "acme/x 的重试上限", createdBy: "lead" });
    recordCardTicketSource(db, { itemId, cardId });
    const ethan = worker();
    await act(ethan, itemId, "worker.claim");
    await act(ethan, itemId, "worker.complete", { summary: "改好了", evidence: "PR acme/x#7" });
    await userReplies(channels, "看了，改好了");
    expect(getItem(db, itemId)!.stage).toBe("review");
  });
});

describe("the queued record a deferred dispatch leaves on the card (CARRY→Task 11)", () => {
  async function setUp() {
    const channels = hub();
    const cardId = await question(channels);
    const itemId = await deferredTicket(channels, cardId);
    return { channels, cardId, itemId };
  }
  const switchTo = (mode: "self" | "external" | "paused") => {
    const { binding } = createLoopbackBinding(db, { name: "Mac web" });
    return runUiAction(db, {
      target: { type: "execution_mode", id: "daemon" }, action: "set", input: { mode },
      caller: { kind: "user", credential: binding, source: { client: "web", deviceName: "Mac web", loopback: true, fromThisMachine: true } } as never,
    });
  };

  it("ends when you switch back to self and nobody holds the ticket, so the card can dispatch again", async () => {
    const { cardId, itemId } = await setUp();
    await switchTo("self");
    expect(getActiveLookupForCard(db, cardId)).toBeUndefined();
    expect(getLatestLookupForCard(db, cardId)).toMatchObject({ state: "cancelled", itemId, reply: { decision: "hand_over" } });
    // 工单本身不动：还在 ready，可以开始或者领。
    expect(getItem(db, itemId)!.stage).toBe("ready");
  });

  it("stays while a worker holds the ticket after switching back to self, and ends when the worker hands it back", async () => {
    const { cardId, itemId } = await setUp();
    const ethan = worker();
    await act(ethan, itemId, "worker.claim");
    await switchTo("self");
    expect(getActiveLookupForCard(db, cardId)).toMatchObject({ state: "queued", itemId });
    await act(ethan, itemId, "worker.hand_back", { reason: "需要你确认" });
    expect(getActiveLookupForCard(db, cardId)).toBeUndefined();
    expect(getLatestLookupForCard(db, cardId)).toMatchObject({ state: "cancelled" });
  });

  it("stays when released or handed back in external mode (the ticket waits for the next worker), and ends on release in self mode", async () => {
    const { cardId, itemId } = await setUp();
    const ethan = worker();
    const user = { kind: "user" } as const;
    await act(ethan, itemId, "worker.claim");
    await act(user, itemId, "ticket.release");
    expect(getItem(db, itemId)!.stage).toBe("ready");
    expect(getActiveLookupForCard(db, cardId)).toMatchObject({ state: "queued" });
    await act(ethan, itemId, "worker.claim");
    await act(ethan, itemId, "worker.hand_back", { reason: "需要你确认" });
    expect(getActiveLookupForCard(db, cardId)).toMatchObject({ state: "queued" });
    await act(ethan, itemId, "worker.claim");
    setExecutionMode(db, "self");
    await act(user, itemId, "ticket.release");
    expect(getActiveLookupForCard(db, cardId)).toBeUndefined();
  });
});
