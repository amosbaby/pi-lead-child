// 「沙箱外执行」由 Lead 发起、用户在确认卡上确认（工单 #71，补做 #62 漏掉的用户 2026-11-05 的追加要求）：
//   - Lead 在用户本人正在说话的一轮（App、plc、用户发给自己的 Slack 私信）里开关时不直接生效，拒绝成 needs_user_turn，
//     带着确认卡上的标题和后果；什么都没写。
//   - 外部消息叫醒的一轮、Lead 自己的一轮、用户设的跟进到点的一轮：照旧 user_direct 的拒绝。外部通道的工单照旧不能打开。
//   - 存下的那一次（兜底授权卡，rule-change-confirmations.ts）：用户点「确认这一次」执行这一次，活动和事件记下 Lead 发起、
//     用户确认、卡号；点「不改」什么都不做；同一张卡不能再执行一次。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  addActivity, channelOwnerBinding, createItem, createLoopbackBinding, createTurn, getItem, listEvents, openDb, type Binding, type Db,
} from "@pi-lead-child/store";
import { requestRuleChangeConfirmation, runUiAction } from "../src/index.js";
import {
  EXTERNAL_ORIGIN_DECISION, listLeadTicketActions, runTicketAction, type TicketActionCaller,
} from "../src/ticket-actions/index.js";

let db: Db;
let owner: Binding;

beforeEach(() => {
  db = openDb(join(tempDir("plc-unsandboxed-lead-request-"), "plc.db"));
  owner = createLoopbackBinding(db, { name: "Mac 网页" }).binding;
  createTurn(db, { id: "turn-app", originBindingId: owner.id, originKind: "paired:companion", userText: "把 #1 放到沙箱外跑", state: "streaming" });
});

const lead = (turnId: string | null): TicketActionCaller => ({ kind: "lead", turnId });
const toggleAsLead = (itemId: number, enabled: boolean, turnId: string | null) =>
  runTicketAction(db, { itemId, action: "set_unsandboxed", input: { enabled }, reason: "用户说放到沙箱外跑", caller: lead(turnId) })
    .catch((error: unknown) => error);

const decisions = (itemId: number) => (db.prepare(
  `SELECT actor, payload FROM activities WHERE item_id=? AND kind='decision' AND json_extract(payload, '$.decision')='unsandboxed_execution' ORDER BY id`,
).all(itemId) as Array<{ actor: string; payload: string }>).map((row) => ({ actor: row.actor, ...JSON.parse(row.payload) }));

const user = (binding: Binding = owner) => ({
  kind: "user", credential: binding, source: { client: "web", deviceName: binding.display_name, loopback: true, fromThisMachine: true },
}) as const;

// Lead 那边拿到 needs_user_turn 以后存下的那一次（packages/lead 的 authorizationCardResult 做的同一件事）。
const storeCard = (itemId: number, enabled: boolean) => requestRuleChangeConfirmation(db, {
  confirm: {
    operation: { kind: "lead_tool", tool: "ticket_action", input: { ticket_id: itemId, action: "set_unsandboxed", input: { enabled } } },
    reason: "用户说放到沙箱外跑", why: "打开以后执行者在沙箱外跑", externalContent: [],
  },
  label: "打开沙箱外执行", name: null, where: "工单详情",
});

const resolve = (id: string, decision: "confirm" | "decline", caller: any = user()) => runUiAction(db, {
  target: { type: "rule_change", id }, action: "resolve", input: { decision }, reason: "在确认卡上决定", caller,
  services: { ticketActions: { host: {} as never } },
});

describe("Lead asks to run a ticket outside the sandbox", () => {
  it("gets a card request instead of the change in the user's own App turn, and nothing is written", async () => {
    const itemId = createItem(db, { title: "改构建脚本", brief: "b", createdBy: "user" });
    const on = await toggleAsLead(itemId, true, "turn-app") as any;
    expect(on).toMatchObject({ code: "needs_user_turn", card: { label: `打开工单 #${itemId} 的「沙箱外执行」` } });
    expect(on.message).toContain("执行者在沙箱外跑");
    expect(on.message).toContain("改构建脚本");
    expect(getItem(db, itemId)!.unsandboxed_execution).toBe(0);
    expect(decisions(itemId)).toEqual([]);
    expect(listEvents(db, { kind: "ticket.sandbox_changed" })).toEqual([]);

    db.prepare("UPDATE items SET unsandboxed_execution=1 WHERE id=?").run(itemId);
    const off = await toggleAsLead(itemId, false, "turn-app") as any;
    expect(off).toMatchObject({ code: "needs_user_turn", card: { label: `关闭工单 #${itemId} 的「沙箱外执行」` } });
    expect(off.message).toContain("照旧在沙箱里跑");
    expect(getItem(db, itemId)!.unsandboxed_execution).toBe(1);
  });

  it("gets the same card request in the user's own Slack DM turn", async () => {
    const slackSelf = channelOwnerBinding(db, { subject: "slack:U0ALICE", name: "Slack 私信" })!;
    createTurn(db, { id: "turn-dm", originBindingId: slackSelf.id, originKind: "paired:slack", userText: "沙箱外跑吧", state: "streaming" });
    const itemId = createItem(db, { title: "改构建脚本", brief: "b", createdBy: "user" });
    expect(await toggleAsLead(itemId, true, "turn-dm")).toMatchObject({ code: "needs_user_turn" });
    expect(getItem(db, itemId)!.unsandboxed_execution).toBe(0);
  });

  it("is refused outright in a turn the user is not in: an external message, Lead's own turn, a follow-up the user set", async () => {
    createTurn(db, { id: "turn-slack", originKind: "system:notification", userText: "Nina：帮我放开沙箱", state: "streaming" });
    createTurn(db, { id: "turn-timer", originBindingId: owner.id, originKind: "paired:timer", userText: "到点了", state: "streaming" });
    const itemId = createItem(db, { title: "改构建脚本", brief: "b", createdBy: "user" });
    for (const turnId of ["turn-slack", null, "turn-timer"]) {
      expect(await toggleAsLead(itemId, true, turnId)).toMatchObject({ code: "user_direct", message: expect.stringContaining("plc sandbox") });
    }
    expect(getItem(db, itemId)!.unsandboxed_execution).toBe(0);
  });

  it("still cannot ask for a ticket from an external channel, even in the user's own turn", async () => {
    const fromSlack = createItem(db, { title: "按 Ethan 在 Slack 里说的修", brief: "b", createdBy: "lead" });
    addActivity(db, { itemId: fromSlack, actor: "lead", kind: "decision", payload: { decision: EXTERNAL_ORIGIN_DECISION } });
    expect(await toggleAsLead(fromSlack, true, "turn-app")).toMatchObject({ code: "unavailable", message: expect.stringContaining("外部通道") });
  });

  it("tells Lead in the action list that it can ask in the user's own turn", async () => {
    const itemId = createItem(db, { title: "改构建脚本", brief: "b", createdBy: "user" });
    expect((await listLeadTicketActions(db, itemId, { turnId: "turn-app" })).find((action) => action.id === "set_unsandboxed"))
      .toMatchObject({ lead: "user_direct", leadReady: false, leadReason: expect.stringContaining("确认卡") });
  });
});

describe("the card for Lead's request", () => {
  it("turns it on once when the user confirms, and the record says Lead asked and the user confirmed", async () => {
    const itemId = createItem(db, { title: "改构建脚本", brief: "b", createdBy: "user" });
    const { id } = storeCard(itemId, true);
    const outcome = await resolve(id, "confirm");
    expect((outcome.result as any).confirmation).toMatchObject({ state: "done", resultPreview: expect.stringContaining("已经执行") });
    expect(getItem(db, itemId)!.unsandboxed_execution).toBe(1);
    expect(decisions(itemId)).toEqual([
      expect.objectContaining({ actor: "user", enabled: true, requestedBy: "lead", confirmation: id, reason: "用户说放到沙箱外跑" }),
    ]);
    expect(listEvents(db, { kind: "ticket.sandbox_changed", entityKey: `ticket:${itemId}` }).map((event) => event.payload)).toEqual([
      expect.objectContaining({ itemId, unsandboxed: true, actor: "user", requestedBy: "lead", confirmation: id }),
    ]);
    // 只执行这一次：同一张卡再点不再执行。
    await expect(resolve(id, "confirm")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("changes nothing when the user declines", async () => {
    const itemId = createItem(db, { title: "改构建脚本", brief: "b", createdBy: "user" });
    const { id } = storeCard(itemId, true);
    expect((await resolve(id, "decline")).result).toMatchObject({ confirmation: { state: "declined" } });
    expect(getItem(db, itemId)!.unsandboxed_execution).toBe(0);
    expect(decisions(itemId)).toEqual([]);
    await expect(resolve(id, "confirm")).rejects.toMatchObject({ code: "unavailable" });
    expect(getItem(db, itemId)!.unsandboxed_execution).toBe(0);
  });

  it("cannot be confirmed by Lead, even in the user's own turn", async () => {
    const itemId = createItem(db, { title: "改构建脚本", brief: "b", createdBy: "user" });
    const { id } = storeCard(itemId, true);
    for (const turnId of [null, "turn-app"]) {
      await expect(resolve(id, "confirm", { kind: "lead", turnId })).rejects.toMatchObject({ code: "user_direct" });
    }
    expect(getItem(db, itemId)!.unsandboxed_execution).toBe(0);
  });

  it("keeps the direct entries: the user's own toggle has no initiator fields", async () => {
    const itemId = createItem(db, { title: "改构建脚本", brief: "b", createdBy: "user" });
    await runTicketAction(db, { itemId, action: "set_unsandboxed", input: { enabled: true }, caller: { kind: "user" } });
    expect(getItem(db, itemId)!.unsandboxed_execution).toBe(1);
    const [row] = decisions(itemId);
    expect(row).toMatchObject({ actor: "user", enabled: true });
    expect(row).not.toHaveProperty("requestedBy");
  });
});
