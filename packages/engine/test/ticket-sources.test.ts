// 派活建的单记来源（ticket-sources.ts 的 recordDispatchedCardSource，external-worker-hub P1-2）：
//   - 派单器建单时一律是外部来源（失败时宁可多算外部）；这里记卡的对话、锚点和在来源里打开这条消息的链接；
//   - 派活的那条消息是用户本人写的（self_reply）时，external_origin 清成 0；别人的消息留着 1；
//   - 链接只收 https（protocol 的 sourceLink）。
// 卡是真的通道 hub 记的（假 Slack）。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  appendEvent, createContinuation, createItem, createRun, enqueueContinuationEvent, getChannelCard, getEvent, grantDelegationPolicy, openDb,
  ticketSources, updateRun, type Db,
} from "@pi-lead-child/store";
import {
  ChannelHub, ChannelRegistry, createCoordinator, createSlackChannelAdapter, processContinuations, recordDispatchedCardSource,
} from "../src/index.js";
import { cardIdOf, FakeAgentTaskDispatcher, FakeSlack, scriptedSmartModel } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
const hubs: ChannelHub[] = [];

beforeEach(() => {
  db = openDb(join(tempDir("plc-ticket-sources-"), "plc.db"));
  slack = new FakeSlack({ users: { U0NINA: { name: "Nina" } } });
});

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.idle();
  db.close();
});

async function card(): Promise<number> {
  const dispatcher = new FakeAgentTaskDispatcher(db, {});
  const hub = new ChannelHub({
    db, registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api })]),
    credentials: { credential: async () => slack.credential },
    smartModel: () => scriptedSmartModel({ answers: { situation: "other", needs_reply: 0.95, rule_change: "none" } }),
    lead: { dispatcher, available: () => true }, audit: { rate: 0 },
  });
  hubs.push(hub);
  const item = (await hub.receive("slack", slack.dm("U0NINA", "can you check the retry policy?"))).items[0]!;
  await hub.idle();
  return cardIdOf(db, item)!;
}

const lookupTicket = () => createItem(db, { title: "lookup", brief: "b", createdBy: "system", purpose: "lookup", externalOrigin: true });
const externalOrigin = (itemId: number) => (db.prepare("SELECT external_origin FROM items WHERE id=?").get(itemId) as { external_origin: number }).external_origin;

describe("the source of a dispatched ticket", () => {
  it("records the card's conversation, anchor and link, and stays external for someone else's message", async () => {
    const cardId = await card();
    const found = getChannelCard(db, cardId)!;
    const itemId = lookupTicket();
    recordDispatchedCardSource(db, { itemId, cardId, eventSeq: found.firstSeq, url: "https://acme.slack.com/archives/D0NINA/p1762934400000100" });
    expect(ticketSources(db, itemId)).toEqual([expect.objectContaining({
      kind: "slack", conversation: found.objectKey, messageTs: found.replyTarget.thread_ts,
      url: "https://acme.slack.com/archives/D0NINA/p1762934400000100",
    })]);
    expect(externalOrigin(itemId)).toBe(1);
  });

  it("clears external_origin when the message is the user's own (self_reply)", async () => {
    const cardId = await card();
    const found = getChannelCard(db, cardId)!;
    const theirs = getEvent(db, found.firstSeq)!;
    const own = db.transaction(() => appendEvent(db, {
      source: theirs.source, kind: theirs.kind, entityKey: theirs.entityKey, correlationId: theirs.correlationId, level: "record",
      occurredAt: new Date().toISOString(), payload: { ...theirs.payload, role: "self_reply", urgent: false },
    }))();
    const itemId = lookupTicket();
    recordDispatchedCardSource(db, { itemId, cardId, eventSeq: own.event.seq, url: null });
    expect(externalOrigin(itemId)).toBe(0);
    expect(ticketSources(db, itemId)).toMatchObject([{ kind: "slack", url: null }]);
  });

  it("keeps only an https link", async () => {
    const cardId = await card();
    const itemId = lookupTicket();
    recordDispatchedCardSource(db, { itemId, cardId, eventSeq: getChannelCard(db, cardId)!.firstSeq, url: "javascript:alert(1)" });
    expect(ticketSources(db, itemId)).toMatchObject([{ url: null }]);
  });
});

// 派生的单（执行者拆的子单、续作建的单）跟着上级走：上级来自外部来源时它们也是（Lead 的子单、后台检查的轻工单在 lead 的测试里）。
describe("tickets derived from an external ticket", () => {
  it("an executor's subitem inherits external_origin from its parent", () => {
    const coordinator = createCoordinator({ db });
    for (const external of [true, false]) {
      const parent = coordinator.createRootItem({ title: "root", brief: "b", createdBy: "system", externalOrigin: external });
      const runId = createRun(db, { itemId: parent });
      updateRun(db, runId, { state: "running" });
      const revision = coordinator.beginPlanning({ itemId: parent, runId });
      const child = coordinator.createSubitem({ itemId: parent, runId, revision }, { title: "child", brief: "b" });
      expect(externalOrigin(child)).toBe(external ? 1 : 0);
    }
  });

  it("a continuation's ticket inherits external_origin from the ticket it hangs on", () => {
    for (const external of [true, false]) {
      const itemId = createItem(db, { title: `from ${external ? "Nina" : "me"}`, brief: "b", createdBy: "system", externalOrigin: external });
      const policy = grantDelegationPolicy(db, { itemId, createdVia: "test" });
      createContinuation(db, {
        itemId, delegationPolicyId: policy.id, triggerEvent: "review_passed", idempotencyKey: `follow-${itemId}`,
        actions: [{ type: "create_task", key: "follow", title: `Follow-up ${itemId}`, brief: "b" }],
      });
      enqueueContinuationEvent(db, { itemId, eventType: "review_passed", payload: { reviewerRunId: 99, policyId: policy.id }, idempotencyKey: `passed-${itemId}` });
      processContinuations(db, { requestDispatch: () => { throw new Error("no dispatch expected"); } });
      const follow = (db.prepare("SELECT id FROM items WHERE title=?").get(`Follow-up ${itemId}`) as { id: number }).id;
      expect(externalOrigin(follow)).toBe(external ? 1 : 0);
    }
  });
});
