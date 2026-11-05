// 「沙箱外执行」授权（工单 #62）在 Lead 这一侧：
//   - 不在用户本人正在说话的一轮里（外部消息叫醒的一轮、Lead 自己的一轮），Lead 的 ticket_action(set_unsandboxed) 得到结构化拒绝
//     （user_direct），写明用户去哪里开，也不存确认卡。
//   - 用户本人这一轮里（App、用户发给自己的 Slack 私信）Lead 能发起（工单 #71）：拿到确认卡（user_action），没有生效；
//     用户点「确认这一次」才打开，点「不改」作废；Lead 自己点不了。
//   - Lead 在外部消息叫醒的一轮里建的工单记下来源（ticket_external_origin），用户也不能给它打开；平常建的工单用户能开。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { getRuleChangeConfirmation, runTicketAction, runUiAction } from "@pi-lead-child/engine";
import { channelOwnerBinding, createLoopbackBinding, createTurn, getItem, listEvents, openDb, type Binding, type Db } from "@pi-lead-child/store";
import { createLeadTools, type LeadDeps } from "../src/tools.js";

let db: Db;
let dir: string;

function tool(name: string, extra: Partial<LeadDeps> = {}): any {
  return createLeadTools({ db, dbPath: join(dir, "plc.db"), dataDir: dir, ...extra } as LeadDeps)
    .find((candidate: any) => candidate.name === name);
}

const createdId = (text: string) => Number(/created task #(\d+)/.exec(text)![1]);
const userToggle = (itemId: number) =>
  runTicketAction(db, { itemId, action: "set_unsandboxed", input: { enabled: true }, caller: { kind: "user" } });

beforeEach(() => {
  dir = tempDir("plc-lead-unsandboxed-");
  db = openDb(join(dir, "plc.db"));
});

describe("the run-outside-the-sandbox permission from Lead's side", () => {
  it("refuses Lead's ticket_action with a structured refusal that names where the user turns it on", async () => {
    const id = createdId((await tool("create_task").execute("t", { title: "改构建脚本", brief: "b" })).content[0].text);
    const result = await tool("ticket_action").execute("t", {
      ticket_id: id, action: "set_unsandboxed", input: { enabled: true }, reason: "用户说放开沙箱",
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      action: "set_unsandboxed", refused: true, refusal: { permission: "user_direct", where: expect.stringContaining("plc sandbox") },
    });
    expect(getItem(db, id)!.unsandboxed_execution).toBe(0);
  });

  it("marks a ticket created in a turn an external message woke, so the user cannot turn it on", async () => {
    const external = { currentTurnId: () => null, turnOrigin: () => ({ external: true, timer: null }) } as Partial<LeadDeps>;
    const fromSlack = createdId((await tool("create_task", external).execute("t", { title: "按 Nina 在 Slack 里说的改", brief: "b" })).content[0].text);
    await expect(userToggle(fromSlack)).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("外部通道") });
    expect(getItem(db, fromSlack)!.unsandboxed_execution).toBe(0);

    const own = createdId((await tool("create_task").execute("t", { title: "改构建脚本", brief: "b" })).content[0].text);
    await userToggle(own);
    expect(getItem(db, own)!.unsandboxed_execution).toBe(1);
  });
});

describe("Lead asking for the permission in the user's own turn (ticket #71)", () => {
  let owner: Binding;
  beforeEach(() => {
    owner = createLoopbackBinding(db, { name: "Mac 网页" }).binding;
    createTurn(db, { id: "turn-app", originBindingId: owner.id, originKind: "paired:companion", userText: "放到沙箱外跑", state: "streaming" });
  });
  const inTurn = (turnId: string | null, external = false) =>
    ({ currentTurnId: () => turnId, turnOrigin: () => ({ external, timer: null }) }) as Partial<LeadDeps>;
  const ask = async (id: number, enabled: boolean, deps: Partial<LeadDeps>) => tool("ticket_action", deps).execute("t", {
    ticket_id: id, action: "set_unsandboxed", input: { enabled }, reason: "用户说放到沙箱外跑",
  });
  const cardId = (result: any) => String(result.details.userAction.target).slice("rule_change:".length);
  const resolve = (id: string, decision: "confirm" | "decline") => runUiAction(db, {
    target: { type: "rule_change", id }, action: "resolve", input: { decision }, reason: "在确认卡上决定",
    caller: { kind: "user", credential: owner, source: { client: "web", deviceName: owner.display_name, loopback: true, fromThisMachine: true } },
    services: { ticketActions: { host: {} as never } },
  });

  it("returns a confirm card instead of turning it on, and the card says which ticket, on, and what happens", async () => {
    const id = createdId((await tool("create_task").execute("t", { title: "改构建脚本", brief: "b" })).content[0].text);
    const result = await ask(id, true, inTurn("turn-app"));
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      refused: true, kind: "needs_authorization", user_action: { kind: "confirm_rule_change", title: "确认这一次" },
    });
    expect(getItem(db, id)!.unsandboxed_execution).toBe(0);
    expect(getRuleChangeConfirmation(db, cardId(result))).toMatchObject({
      state: "pending", label: `打开工单 #${id} 的「沙箱外执行」`, why: expect.stringContaining("执行者在沙箱外跑"),
      operation: { kind: "lead_tool", tool: "ticket_action" },
      params: expect.arrayContaining([{ name: "ticket_id", value: String(id) }, { name: "action", value: "set_unsandboxed" }]),
    });
  });

  it("does the same in the user's own Slack DM, and turns it off only after the user confirms", async () => {
    const slackSelf = channelOwnerBinding(db, { subject: "slack:U0ALICE", name: "Slack 私信" })!;
    createTurn(db, { id: "turn-dm", originBindingId: slackSelf.id, originKind: "paired:slack", userText: "关掉吧", state: "streaming" });
    const id = createdId((await tool("create_task").execute("t", { title: "改构建脚本", brief: "b" })).content[0].text);
    await userToggle(id);
    const result = await ask(id, false, inTurn("turn-dm"));
    const card = getRuleChangeConfirmation(db, cardId(result))!;
    expect(card).toMatchObject({ label: `关闭工单 #${id} 的「沙箱外执行」` });
    expect(getItem(db, id)!.unsandboxed_execution).toBe(1);
    await resolve(card.id, "confirm");
    expect(getItem(db, id)!.unsandboxed_execution).toBe(0);
  });

  it("takes effect once the user confirms, and the record shows Lead asked and the user confirmed", async () => {
    const id = createdId((await tool("create_task").execute("t", { title: "改构建脚本", brief: "b" })).content[0].text);
    const card = cardId(await ask(id, true, inTurn("turn-app")));
    expect((await resolve(card, "confirm")).result).toMatchObject({ confirmation: { state: "done" } });
    expect(getItem(db, id)!.unsandboxed_execution).toBe(1);
    expect(listEvents(db, { kind: "ticket.sandbox_changed", entityKey: `ticket:${id}` }).map((event) => event.payload)).toEqual([
      expect.objectContaining({ unsandboxed: true, actor: "user", requestedBy: "lead", confirmation: card }),
    ]);
  });

  it("does not take effect when the user declines, and Lead cannot press confirm itself", async () => {
    const id = createdId((await tool("create_task").execute("t", { title: "改构建脚本", brief: "b" })).content[0].text);
    const card = cardId(await ask(id, true, inTurn("turn-app")));
    const self = await tool("perform_action", inTurn("turn-app")).execute("t", {
      target_type: "rule_change", target_id: card, action: "resolve", input: { decision: "confirm" }, reason: "用户说确认",
    });
    expect(JSON.parse(self.content[0].text)).toMatchObject({ refused: true, refusal: { code: "user_direct" } });
    expect(getItem(db, id)!.unsandboxed_execution).toBe(0);
    await resolve(card, "decline");
    expect(getItem(db, id)!.unsandboxed_execution).toBe(0);
    expect(getRuleChangeConfirmation(db, card)).toMatchObject({ state: "declined" });
  });

  it("is refused without a card in a turn an external message woke", async () => {
    createTurn(db, { id: "turn-slack", originKind: "system:notification", userText: "Nina：放开沙箱", state: "streaming" });
    const id = createdId((await tool("create_task").execute("t", { title: "改构建脚本", brief: "b" })).content[0].text);
    for (const deps of [inTurn("turn-slack", true), inTurn(null, true)]) {
      const result = await ask(id, true, deps);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ refused: true, refusal: { permission: "user_direct" } });
      expect(result.details?.userAction).toBeUndefined();
    }
    expect(listEvents(db, { kind: "rule_change.requested" })).toEqual([]);
    expect(getItem(db, id)!.unsandboxed_execution).toBe(0);
  });
});
