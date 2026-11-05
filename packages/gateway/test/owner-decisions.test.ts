// 用户自己 Slack 私信里的决定请求，端到端（工单 #81）：真实的 hub、Slack 适配器、SQLite 和操作层的 decision.resolve，Slack 是假的。验证：
//   (a) Lead 在私信那一轮画的 ChoiceGroup：私信里出现带选项的消息；用户在 Slack 里点了，等同在 App 里选（同一个操作，
//       记在 Slack 私信的凭证名下），Lead 被叫醒；消息换成结果；
//   (b) 执行者要用户回答的决定请求主动推到私信：每条只推一次；同一张工单 10 分钟内的合成一条消息；只要 Lead 判断的不推；
//       没有私信时不推、记一条事件；在 App 里答了、撤了、过期了，消息改成结果；App 和 Slack 先后点不会重复生效；
//   要自己写回答的提示去 App；选项多时是下拉框；
//   (c) 私信那一轮建的工单记下来源私信，之后系统叫醒的一轮写给用户的话同步发过去，回 NO_REPLY 的不发。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { CHANNEL_EVENT_KINDS, UI_ACTION_PERFORMED_KIND } from "@pi-lead-child/protocol";
import {
  channelOwnerBinding, createItem, createRun, getDecisionRequest, recordTicketOrigin, getLeadProfile, latestItemId, leadProfileFields, listEvents, openDb,
  recordTurnTicketOrigins, updateRun, writeLeadProfile, type Binding, type Db,
} from "@pi-lead-child/store";
import {
  ChannelHub, ChannelRegistry, createCoordinator, createSlackChannelAdapter, SLACK_CHOOSE_ACTION, updateDesignPreferences,
} from "@pi-lead-child/engine";
import { FakeSlack } from "@pi-lead-child/engine/testing";
import {
  choiceGroupsOfSurface, createOwnerDecisionPusher, resolveOwnerDecision, type OwnerDecisionPusher,
} from "../src/owner-decisions.js";
import { dispatchedTicketOf, systemReplyForOwner } from "../src/owner-dm-relay.js";

const SELF_DM = "D0SELF";
const CONVERSATION = `slack:${SELF_DM}:main`;

let db: Db;
let slack: FakeSlack;
let clock: Date;
let binding: Binding;
let hub: ChannelHub;
let pusher: OwnerDecisionPusher;
let ticket: number;

beforeEach(() => {
  runs.clear();
  db = openDb(join(tempDir("plc-owner-decisions-"), "plc.db"));
  clock = new Date("2026-11-05T10:00:00.000Z");
  slack = new FakeSlack({ now: () => clock });
  updateDesignPreferences(db, { request: { locale: "zh" }, caller: { kind: "user" } });
  writeLeadProfile(db, { ...leadProfileFields(getLeadProfile(db)), name: "Red Bull" }, { by: "user", at: clock });
  binding = channelOwnerBinding(db, { subject: `slack:${slack.self.id}`, name: "Slack 私信（你自己）" })!;
  ticket = createItem(db, { title: "发布清单", brief: "b", createdBy: "lead" });
  const uiActions = { db, services: {}, log: () => {} };
  const adapter = createSlackChannelAdapter({ api: slack.api, now: () => clock });
  hub = new ChannelHub({
    db, registry: new ChannelRegistry([adapter]), now: () => clock, log: () => {}, assistantName: () => "Red Bull",
    credentials: { credential: async () => ({ ...slack.credential, team: { id: "T0HOME", name: "Acme" } }) },
    // daemon 的接法（server.ts 的 resolveChannelOwnerChoice）：凭证是这个账号的私信凭证。
    ownerChoose: async (click) => resolveOwnerDecision({ db, uiActions, log: () => {}, now: () => clock }, {
      target: click.target, option: click.option, conversation: click.conversation,
      binding: channelOwnerBinding(db, { subject: `${click.source}:${click.account}`, name: "Slack 私信（你自己）" })!,
    }),
  });
  pusher = createOwnerDecisionPusher({
    db, uiActions, log: () => {}, now: () => clock,
    transport: {
      sendOwnerChoices: (conversation, content, key) => hub.sendOwnerChoices(conversation, content, key),
      editOwnerChoices: (conversation, message, content) => hub.editOwnerChoices(conversation, message, content),
    },
  });
});

afterEach(() => {
  db.close();
});

const coordinator = () => createCoordinator({ db, now: () => clock });

// 执行者的决定请求挂在它那次执行上。
const runs = new Map<number, number>();
function runOf(itemId: number): number {
  if (!runs.has(itemId)) {
    const runId = createRun(db, { itemId, runtime: "codex" });
    updateRun(db, runId, { state: "running" });
    runs.set(itemId, runId);
  }
  return runs.get(itemId)!;
}

function ask(input: {
  origin?: "agent" | "lead"; audience?: "user" | "lead" | "lead_or_user"; prompt?: string; itemId?: number; allowCustom?: boolean;
  options?: Array<{ id: string; label: string; description?: string }>;
} = {}): number {
  return coordinator().requestDecision({
    itemId: input.itemId ?? ticket, runId: (input.origin ?? "agent") === "agent" ? runOf(input.itemId ?? ticket) : null, origin: input.origin ?? "agent", kind: "decision", audience: input.audience ?? "user",
    prompt: input.prompt ?? "发布窗口选哪天？", allowCustom: input.allowCustom ?? false,
    options: input.options ?? [{ id: "tue", label: "周二", description: "赶上月初的活动" }, { id: "thu", label: "周四" }],
    checkpoint: { title: "要你决定", summary: "发布窗口" },
  }).requestId;
}

const messages = () => slack.messages.filter((item) => item.channel === SELF_DM);
const blocksOf = (index = -1) => JSON.stringify(messages().at(index)!.blocks);
type Control = { type: string; action_id: string; value?: string; style?: string };
// 能点的：actions 里的按钮、下拉框，和每个选项一块时 section 旁边的按钮（工单 #82）。
const elementsOf = (index = -1) => (messages().at(index)!.blocks ?? []).flatMap((block) => (block.type === "actions" ? block.elements as Control[]
  : block.type === "section" && block.accessory ? [block.accessory as Control] : []));
const skipped = () => listEvents(db, { kind: CHANNEL_EVENT_KINDS.ownerDecisionSkipped, limit: 100 }).map((event) => event.payload as any);
const later = (ms: number) => { clock = new Date(clock.getTime() + ms); };

describe("(a) a ChoiceGroup drawn in the user's own Slack DM turn", () => {
  it("reads the ChoiceGroups, their decisions and recommendations from the drawn surface", () => {
    expect(choiceGroupsOfSurface({
      nodes: [
        { id: "t", type: "Text", props: { text: "x" } },
        { id: "c1", type: "ChoiceGroup", props: { ticket: 9, choices: [], decision: 41, recommendation: { choiceId: "tue", reason: "周四有冻结" } } },
        { id: "c2", type: "ChoiceGroup", props: { ticket: 9, choices: [], decision: 42 } },
        // 还没建决定请求的（流式的半成品）不算。
        { id: "c3", type: "ChoiceGroup", props: { ticket: 9, choices: [] } },
      ],
    })).toEqual([
      { decisionId: 41, recommended: "tue", reason: "周四有冻结" },
      { decisionId: 42, recommended: null, reason: null },
    ]);
    expect(choiceGroupsOfSurface(null)).toEqual([]);
  });

  it("posts the options, and a click in Slack resolves it like the App, wakes Lead and shows the result", async () => {
    const decision = ask({ origin: "lead" });
    await pusher.pushTurnChoices({ conversation: CONVERSATION, turnId: "turn_1", choices: [{ decisionId: decision, recommended: "tue", reason: "周四有冻结" }] });
    expect(messages()).toHaveLength(1);
    expect(blocksOf()).toContain("#");
    expect(blocksOf()).toContain("发布清单：要你决定");
    // 每个选项一块：选项名、说明（App 卡上的 consequence），推荐的有标记。
    expect(blocksOf()).toContain("*周二*  ·  _推荐_\\n赶上月初的活动");
    expect(blocksOf()).toContain("发布窗口选哪天？");
    expect(blocksOf()).toContain("推荐：周二。周四有冻结");
    expect(elementsOf()).toEqual([
      expect.objectContaining({ action_id: `${SLACK_CHOOSE_ACTION}:0`, value: `decision:${decision}#0`, style: "primary" }),
      expect.not.objectContaining({ style: "primary" }),
    ]);

    await hub.receiveFromTransport("slack", slack.click(messages()[0]!, `${SLACK_CHOOSE_ACTION}:0`));

    // 和 App 里选一样：同一个操作、记在 Slack 私信的凭证名下。
    expect(getDecisionRequest(db, decision)).toMatchObject({
      state: "resolved", selectedOptionId: "tue", resolvedBy: `user via paired binding:${binding.id}`,
    });
    expect(listEvents(db, { kind: UI_ACTION_PERFORMED_KIND, limit: 100 }).map((event) => event.payload as any))
      .toEqual([expect.objectContaining({ target: { type: "decision", id: String(decision) }, action: "resolve", actor: "user", bindingId: binding.id })]);
    // Lead 被叫醒去执行。
    const wake = db.prepare("SELECT summary, payload FROM inbox WHERE item_id = ? AND payload LIKE '%lead_decision_resolved%'").get(ticket) as
      { summary: string; payload: string } | undefined;
    expect(wake?.summary).toContain("选了「周二」");
    expect(JSON.parse(wake!.payload)).toMatchObject({ wakeLead: true, decisionRequestId: decision });
    // 消息换成结果，不再带选项。
    expect(elementsOf()).toEqual([]);
    expect(blocksOf()).toContain("已决定");
    expect(blocksOf()).toContain("选了「周二」");
    // Lead 被叫醒以后为这张工单写给用户的话也回到这个私信（(c)）。
    expect(systemReplyForOwner(db, { text: "按周二排好了。", events: [{ entityKey: `ticket:${ticket}` }] }).conversations).toEqual([CONVERSATION]);

    // 旧客户端还显示着按钮，再点另一个：不再生效。
    await hub.receiveFromTransport("slack", slack.click({ ...messages()[0]!, blocks: [] }, `${SLACK_CHOOSE_ACTION}:1`));
    expect(getDecisionRequest(db, decision)!.selectedOptionId).toBe("tue");
    // 这一拍不再改写（消息上已经是结果）。
    const edits = messages()[0]!.edits;
    await pusher.sync(CONVERSATION);
    expect(messages()[0]!.edits).toBe(edits);
  });
});

describe("(b) an executor's decision for the user", () => {
  it("is pushed to the user's own DM once, and merged with others of the same ticket within 10 minutes", async () => {
    const first = ask();
    await pusher.sync(CONVERSATION);
    await pusher.sync(CONVERSATION);
    expect(messages()).toHaveLength(1);
    expect(elementsOf().map((element) => element.value)).toEqual([`decision:${first}#0`, `decision:${first}#1`]);

    later(5 * 60_000);
    const second = ask({ prompt: "回滚脚本谁来写？", options: [{ id: "me", label: "我" }, { id: "agent", label: "执行者" }] });
    await pusher.sync(CONVERSATION);
    // 合进同一条消息（改写那条，不另发）。
    expect(messages()).toHaveLength(1);
    expect(blocksOf()).toContain("回滚脚本谁来写？");
    expect(elementsOf().map((element) => element.value)).toEqual([
      `decision:${first}#0`, `decision:${first}#1`, `decision:${second}#0`, `decision:${second}#1`,
    ]);

    later(11 * 60_000);
    ask({ prompt: "要不要通知客服？" });
    await pusher.sync(CONVERSATION);
    // 第一条推了超过 10 分钟：另发一条。
    expect(messages()).toHaveLength(2);
    expect(blocksOf(-1)).toContain("要不要通知客服？");
    expect(blocksOf(0)).not.toContain("要不要通知客服？");
  });

  it("does not push decisions only Lead needs to judge, Lead's own cards, or ones from before the last hour", async () => {
    ask({ audience: "lead" });
    ask({ audience: "lead_or_user" });
    ask({ origin: "lead" });
    const old = ask();
    later(61 * 60_000);
    await pusher.sync(CONVERSATION);
    expect(messages()).toHaveLength(0);
    expect(getDecisionRequest(db, old)!.state).toBe("pending");
  });

  it("does not push without the user's own DM and records it once per decision", async () => {
    const decision = ask();
    await pusher.sync(null);
    await pusher.sync(null);
    expect(messages()).toHaveLength(0);
    expect(skipped()).toEqual([expect.objectContaining({ decisionId: decision, ticketId: ticket, reason: "no_conversation" })]);
  });

  it("rewrites the message when it is answered in the App, and a later Slack click changes nothing", async () => {
    const decision = ask();
    await pusher.sync(CONVERSATION);
    const pushed = messages()[0]!;
    // 用户在 App 里选了周四（App 的路由走同一个操作）。
    coordinator().resolveDecision({ requestId: decision, decision: "select", optionId: "thu", actor: { kind: "user", resolvedBy: "user via page" } });
    await pusher.sync(CONVERSATION);
    expect(elementsOf()).toEqual([]);
    expect(blocksOf()).toContain("选了「周四」");
    const edits = messages()[0]!.edits;
    await pusher.sync(CONVERSATION);
    expect(messages()[0]!.edits).toBe(edits);

    // Slack 里还开着旧消息，点了周二：不重复生效，还是周四。
    await hub.receiveFromTransport("slack", slack.click(pushed, `${SLACK_CHOOSE_ACTION}:0`));
    expect(getDecisionRequest(db, decision)).toMatchObject({ state: "resolved", selectedOptionId: "thu", resolvedBy: "user via page" });
    expect(listEvents(db, { kind: UI_ACTION_PERFORMED_KIND, limit: 100 })).toEqual([]);
  });

  it("rewrites the message when the decision is dismissed or expires", async () => {
    const dismissed = ask();
    await pusher.sync(CONVERSATION);
    coordinator().resolveDecision({ requestId: dismissed, decision: "dismiss", reason: "不需要了", actor: { kind: "user", resolvedBy: "user via page" } });
    await pusher.sync(CONVERSATION);
    expect(blocksOf()).toContain("不处理：不需要了");

    later(11 * 60_000);
    const expiring = coordinator().requestDecision({
      itemId: ticket, runId: runOf(ticket), kind: "decision", audience: "user", prompt: "今天要不要发？",
      options: [{ id: "y", label: "发" }], expiresAt: new Date(clock.getTime() + 60_000).toISOString(),
      checkpoint: { title: "t", summary: "s" },
    }).requestId;
    await pusher.sync(CONVERSATION);
    expect(messages()).toHaveLength(2);
    later(2 * 60_000);
    coordinator().expireInterventions(clock);
    expect(getDecisionRequest(db, expiring)!.state).toBe("expired");
    await pusher.sync(CONVERSATION);
    expect(blocksOf()).toContain("已过期");
    expect(elementsOf()).toEqual([]);
  });

  it("stops rewriting a message the user deleted", async () => {
    const decision = ask();
    await pusher.sync(CONVERSATION);
    messages()[0]!.deleted = true;
    coordinator().resolveDecision({ requestId: decision, decision: "select", optionId: "tue", actor: { kind: "user", resolvedBy: "user via page" } });
    await pusher.sync(CONVERSATION);
    later(2 * 60_000);
    await pusher.sync(CONVERSATION);
    // 只试了一次（chat.update 回 message_not_found），之后不再试。
    expect(listEvents(db, { kind: CHANNEL_EVENT_KINDS.outboundFailed, limit: 10 })).toHaveLength(1);
    expect(db.prepare("SELECT shown_state FROM channel_decision_pushes WHERE decision_id = ?").get(decision)).toEqual({ shown_state: "resolved" });
  });

  it("asks the user to answer in the App when it needs a written answer", async () => {
    ask({ options: [], allowCustom: true, prompt: "上线公告怎么写？" });
    await pusher.sync(CONVERSATION);
    expect(elementsOf()).toEqual([]);
    expect(blocksOf()).toContain("这条要你写回答，去 App 里回答。");
  });

  it("uses a dropdown for many options and resolves the chosen one", async () => {
    const options = Array.from({ length: 11 }, (_, index) => ({ id: `opt-${index}`, label: `方案 ${index + 1}` }));
    const decision = ask({ options });
    await pusher.sync(CONVERSATION);
    expect(elementsOf()).toEqual([expect.objectContaining({ type: "static_select", action_id: SLACK_CHOOSE_ACTION })]);
    await hub.receiveFromTransport("slack", slack.select(messages()[0]!, { index: 10 }));
    expect(getDecisionRequest(db, decision)).toMatchObject({ state: "resolved", selectedOptionId: "opt-10" });
    expect(blocksOf()).toContain("选了「方案 11」");
  });

  it("refuses a click by someone else and records it, without resolving", async () => {
    const decision = ask();
    await pusher.sync(CONVERSATION);
    await hub.receiveFromTransport("slack", slack.click(messages()[0]!, `${SLACK_CHOOSE_ACTION}:0`, { user: "U0MALLORY" }));
    expect(getDecisionRequest(db, decision)!.state).toBe("pending");
    expect(listEvents(db, { kind: CHANNEL_EVENT_KINDS.ownerConfirmClicked, limit: 10 }).map((event) => event.payload as any))
      .toEqual([expect.objectContaining({ by: "U0MALLORY", accepted: false, refusal: "not_owner", target: `decision:${decision}` })]);
    expect(elementsOf()).toHaveLength(2);
  });
});

describe("(c) results of what the user asked in the DM", () => {
  it("relays Lead's words after a sub-agent task dispatched in the DM turn hands back, but not NO_REPLY", () => {
    const floor = latestItemId(db);
    // 派单器以 system 的名义建子 agent 工单（apps/daemon/src/agent-tasks.ts），按建单人认不出来。
    const task = createItem(db, { title: "看一下 acme/x#12", brief: "b", createdBy: "system", purpose: "lookup" });
    expect(recordTurnTicketOrigins(db, { afterItemId: floor, conversation: CONVERSATION, now: clock })).toEqual([]);
    // dispatch_agent_task 的结果（channel-tools.ts 的 json：JSON 正文）里有工单编号。
    const result = {
      content: [{ type: "text", text: JSON.stringify({ ok: true, itemId: task, runId: 7, grant: ["读 acme/x"], dropped: [], next: "结果回到通道" }, null, 2) }],
      details: {},
    };
    expect(dispatchedTicketOf("dispatch_agent_task", result)).toBe(task);
    expect(dispatchedTicketOf("create_task", result)).toBeNull();
    expect(dispatchedTicketOf("dispatch_agent_task", { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "x" }) }] })).toBeNull();
    expect(recordTicketOrigin(db, { itemId: task, conversation: CONVERSATION, now: clock })).toBe(true);

    // 子 agent 交回：通道的 channel.task.finished 记在通道卡上，工单编号在 payload 里；轻子 agent 的 Run 结束记在 ticket:N 上。
    const handedBack = [{ entityKey: "slack:C0ACME:1793000000.000100", payload: { itemId: task, runId: 7, status: "finished" } }];
    expect(systemReplyForOwner(db, { text: "看完了：acme/x#12 可以合。", events: handedBack }))
      .toEqual({ text: "看完了：acme/x#12 可以合。", conversations: [CONVERSATION] });
    expect(systemReplyForOwner(db, { text: "看完了。", events: [{ entityKey: `ticket:${task}` }] }).conversations).toEqual([CONVERSATION]);
    expect(systemReplyForOwner(db, { text: "NO_REPLY", events: handedBack }).conversations).toEqual([]);
  });

  it("relays Lead's later words about a ticket made in the DM turn, including its subtickets, but not NO_REPLY", async () => {
    const floor = latestItemId(db);
    const made = createItem(db, { title: "查一下发布失败的原因", brief: "b", createdBy: "lead" });
    const child = createItem(db, { title: "子工单", brief: "b", createdBy: "lead", parentItemId: made });
    expect(recordTurnTicketOrigins(db, { afterItemId: floor, conversation: CONVERSATION, now: clock })).toEqual([made, child]);

    expect(systemReplyForOwner(db, { text: "查到了：缓存没清。", events: [{ entityKey: `ticket:${made}` }] }))
      .toEqual({ text: "查到了：缓存没清。", conversations: [CONVERSATION] });
    // 纯内部的一轮。
    expect(systemReplyForOwner(db, { text: "NO_REPLY", events: [{ entityKey: `ticket:${made}` }] }).conversations).toEqual([]);
    expect(systemReplyForOwner(db, { text: "", events: [{ entityKey: `ticket:${made}` }] }).conversations).toEqual([]);
    // 和私信里建的工单无关的事。
    expect(systemReplyForOwner(db, { text: "别的事。", events: [{ entityKey: `ticket:${ticket}` }, { entityKey: "chat:main" }] }).conversations).toEqual([]);

    // 发出去和用户本人那一轮的回复走同一条路：Markdown 换成 Slack 的格式，带色条和署名。
    await hub.replyToOwner(CONVERSATION, "**查到了**：缓存没清。", "system:turn_9");
    const reply = messages().at(-1)!;
    expect(JSON.stringify(reply.attachments)).toContain("*查到了*：缓存没清。");
    expect(JSON.stringify(reply.attachments)).toContain("Red Bull");
  });
});
