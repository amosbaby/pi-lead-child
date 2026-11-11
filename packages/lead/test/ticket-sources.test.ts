// Lead 建单时记下工单从哪来（.scratch/external-worker-hub/spec.md P1-2）：
//   - external_origin 取这一轮的 turnOrigin().external：外部消息叫醒的一轮、读过外部内容的一轮里建的单是 1，用户自己的一轮是 0；
//   - 叫醒这一轮的外部通道消息有通道卡时，ticket_sources 记一条：种类是卡的来源，对话是卡的对象键，消息位置是卡的锚点
//     （线程的根或者开卡的那条消息）；没有卡的一轮不记；
//   - 拆出来的子工单一样。
// 消息事件是真的通道 hub 记的（假 Slack），和 handbook-guard.test.ts 同一套夹具。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { ChannelHub, ChannelRegistry, createSlackChannelAdapter } from "@pi-lead-child/engine";
import { cardIdOf, FakeAgentTaskDispatcher, FakeSlack, scriptedSmartModel } from "@pi-lead-child/engine/testing";
import { MESSAGE_EVENT_KIND } from "@pi-lead-child/protocol";
import { getChannelCard, listEvents, openDb, ticketSources, type Db } from "@pi-lead-child/store";
import { createLeadTools, type LeadDeps } from "../src/tools.js";
import type { LeadTurnOrigin } from "../src/turn-origin.js";

let db: Db;
let dir: string;
let slack: FakeSlack;
const hubs: ChannelHub[] = [];

beforeEach(() => {
  dir = tempDir("plc-lead-ticket-sources-");
  db = openDb(join(dir, "plc.db"));
  slack = new FakeSlack({ users: { U0NINA: { name: "Nina" } } });
});

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.idle();
  db.close();
});

function hub(): ChannelHub {
  const dispatcher = new FakeAgentTaskDispatcher(db, {});
  const instance = new ChannelHub({
    db, registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api })]),
    credentials: { credential: async () => slack.credential },
    smartModel: () => scriptedSmartModel({ answers: { situation: "other", needs_reply: 0.95, rule_change: "none" } }),
    lead: { dispatcher, available: () => true }, audit: { rate: 0 },
  });
  dispatcher.hub = instance;
  hubs.push(instance);
  return instance;
}

// 交给 Lead 的消息事件和它的卡。
async function messageEvent(text: string): Promise<{ seq: number; cardId: number }> {
  const channels = hub();
  const item = (await channels.receive("slack", slack.dm("U0NINA", text))).items[0]!;
  await channels.idle();
  const cardId = cardIdOf(db, item)!;
  const seq = listEvents(db, { kind: MESSAGE_EVENT_KIND }).filter((event) => event.payload.cardId === cardId).at(-1)!.seq;
  return { seq, cardId };
}

function tool(name: string, origin?: LeadTurnOrigin): any {
  return createLeadTools({
    db, dbPath: join(dir, "plc.db"), dataDir: dir, currentTurnId: () => null, ...(origin ? { turnOrigin: () => origin } : {}),
  } as LeadDeps).find((candidate: any) => candidate.name === name);
}

const createdId = (result: any) => Number(/created task #(\d+)/.exec(result.content[0].text)![1]);
const externalOrigin = (itemId: number) => (db.prepare("SELECT external_origin FROM items WHERE id=?").get(itemId) as { external_origin: number }).external_origin;

describe("a ticket Lead creates", () => {
  it("lead-created ticket in an external turn is marked external", async () => {
    const external = await tool("create_task", { external: true, timer: null }).execute("t", { title: "按 Nina 说的改重试", brief: "b" });
    expect(externalOrigin(createdId(external))).toBe(1);
    const own = await tool("create_task", { external: false, timer: null }).execute("t", { title: "改构建脚本", brief: "b" });
    expect(externalOrigin(createdId(own))).toBe(0);
    const noOrigin = await tool("create_task").execute("t", { title: "改文档", brief: "b" });
    expect(externalOrigin(createdId(noOrigin))).toBe(0);
    expect(ticketSources(db, createdId(external))).toEqual([]);
  });

  it("records the channel card of the message that woke the turn as the ticket's source", async () => {
    const { seq, cardId } = await messageEvent("can you fix the retry policy?");
    const card = getChannelCard(db, cardId)!;
    const origin: LeadTurnOrigin = { external: true, timer: null, externalBy: [{ via: "message", source: "slack" }], externalEvents: [seq] };
    const parent = createdId(await tool("create_task", origin).execute("t", { title: "修重试", brief: "b" }));
    expect(ticketSources(db, parent)).toEqual([expect.objectContaining({
      kind: "slack", conversation: card.objectKey, messageTs: card.replyTarget.thread_ts ?? null, externalKey: null,
    })]);
    expect(card.replyTarget.thread_ts).toEqual(expect.any(String));
    expect(externalOrigin(parent)).toBe(1);

    const child = createdId(await tool("create_task", origin).execute("t", { title: "修重试的测试", brief: "b", parent_ticket_id: parent }));
    expect(ticketSources(db, child)).toMatchObject([{ kind: "slack", conversation: card.objectKey }]);
    expect(externalOrigin(child)).toBe(1);
  });
});
