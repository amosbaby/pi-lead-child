// 「找不到」记录（计划 Task 14）：操作层的 ticket_miss.record。网页按钮和 plc miss 走同一个操作，Lead 也能做（lead_allowed），
// 都写账本。核对：写一行（去掉首尾空白）；空的、全是空白的、超过 500 个字符的被拒；账本里页面是 user、Lead 是 lead；
// 外部消息叫醒的一轮 Lead 也能记（不改规则）。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { TICKET_MISS_TEXT_MAX, UI_ACTION_PERFORMED_KIND } from "@pi-lead-child/protocol";
import { createLoopbackBinding, missesSince, openDb, type Db } from "@pi-lead-child/store";
import { listLeadUiActions, runUiAction, UI_ACTIONS } from "../src/index.js";

let db: Db;
beforeEach(() => { db = openDb(join(tempDir("plc-ticket-miss-"), "plc.db")); });
afterEach(() => { db.close(); });

const TARGET = { type: "ticket_miss", id: "hub" } as const;
const EPOCH = new Date(0);

const user = () => {
  const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
  return {
    kind: "user", credential: binding, source: { client: "web", deviceName: binding.display_name, loopback: true, fromThisMachine: true },
  } as never;
};

const rows = () => db.prepare("SELECT text FROM ticket_misses ORDER BY id").all() as Array<{ text: string }>;
function ledger() {
  return db.prepare("SELECT entity_key, payload FROM events WHERE kind = ? ORDER BY seq").all(UI_ACTION_PERFORMED_KIND)
    .map((row: any) => ({ entityKey: row.entity_key, ...JSON.parse(row.payload) }));
}

describe("ticket_miss.record", () => {
  it("is Lead-allowed, does not change rules, and writes a trimmed row plus a ledger entry", async () => {
    expect(UI_ACTIONS.ticket_miss.record).toMatchObject({ permission: "lead_allowed", changesRules: false, external: false, irreversible: false });
    const outcome = await runUiAction(db, { target: TARGET, action: "record", input: { text: "  the Jira ticket from Nina  " }, caller: user() });
    expect(rows()).toEqual([{ text: "the Jira ticket from Nina" }]);
    expect(missesSince(db, EPOCH)).toBe(1);
    expect(outcome.by).toEqual({ actor: "user" });
    expect(ledger()).toMatchObject([{ entityKey: "ticket_miss:hub", actor: "user", action: "record" }]);
  });

  it("lets Lead record one, in any turn, including one an external message woke", async () => {
    await runUiAction(db, { target: TARGET, action: "record", input: { text: "the report ticket" }, reason: "用户说没找到", caller: { kind: "lead", turnId: null } });
    await runUiAction(db, {
      target: TARGET, action: "record", input: { text: "another one" }, reason: "用户说没找到",
      caller: { kind: "lead", turnId: null, externalContent: [{ via: "message", source: "slack" }] },
    });
    expect(rows().map((row) => row.text)).toEqual(["the report ticket", "another one"]);
    expect(ledger().map((entry) => entry.actor)).toEqual(["lead", "lead"]);
  });

  it("refuses a blank text, a text over the cap, and a missing text; nothing is written", async () => {
    for (const text of ["", "   \n\t ", "x".repeat(TICKET_MISS_TEXT_MAX + 1), `  ${"x".repeat(TICKET_MISS_TEXT_MAX + 1)}  `]) {
      await expect(runUiAction(db, { target: TARGET, action: "record", input: { text }, caller: user() }), JSON.stringify(text.slice(0, 5)))
        .rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(runUiAction(db, { target: TARGET, action: "record", input: {}, caller: user() })).rejects.toMatchObject({ code: "invalid_input" });
    expect(rows()).toEqual([]);
    expect(ledger()).toEqual([]);
  });

  it("takes a text of exactly the cap, with padding around it", async () => {
    await runUiAction(db, { target: TARGET, action: "record", input: { text: ` ${"x".repeat(TICKET_MISS_TEXT_MAX)} ` }, caller: user() });
    expect(rows()[0]!.text).toHaveLength(TICKET_MISS_TEXT_MAX);
  });

  it("answers an unknown target id with not_found, and Lead sees it as available", async () => {
    await expect(runUiAction(db, { target: { type: "ticket_miss", id: "other" }, action: "record", input: { text: "x" }, caller: user() }))
      .rejects.toMatchObject({ code: "not_found" });
    const listing = await listLeadUiActions(db, TARGET, { turnId: null });
    expect(listing.actions.map((action) => [action.id, action.available, action.leadReady])).toEqual([["record", true, true]]);
  });
});
