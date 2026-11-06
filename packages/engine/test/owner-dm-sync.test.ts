// 「我不在看 App 时，把 Lead 的消息同步到我的 Slack 私信」开关（工单 #88）。页面和 Lead 的 perform_action 都经操作层的 owner_dm_sync：
//   - 缺省关；页面能开能关。
//   - Lead 只能在用户本人正在说话的这一轮切换（App 或者用户自己的 Slack 私信）。外部消息叫醒的一轮、定时器叫醒的一轮
//     （包括用户自己设的跟进到点）都拒绝。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  addLeadFollowUp, completeTurn, createLoopbackBinding, createTurn, getOwnerDmSync, openDb, type Binding, type Db,
} from "@pi-lead-child/store";
import { listLeadUiActions, runUiAction } from "../src/index.js";

let db: Db;
let owner: Binding;

beforeEach(() => {
  db = openDb(join(tempDir("plc-owner-dm-sync-"), "plc.db"));
  owner = createLoopbackBinding(db, { name: "Mac 网页" }).binding;
});

const target = { type: "owner_dm_sync", id: "user" } as const;
const NOW = new Date("2026-11-06T02:00:00.000Z");

const user = () => ({
  kind: "user", credential: owner, source: { client: "web", deviceName: owner.display_name, loopback: true, fromThisMachine: true },
}) as const;

function userTurn(id: string, originKind = "paired:companion") {
  createTurn(db, { id, originBindingId: owner.id, originKind, userText: "开启同步", state: "streaming" });
}

describe("owner_dm_sync from the settings page", () => {
  it("is off by default, and the page turns it on and off", async () => {
    expect(getOwnerDmSync(db).enabled).toBe(false);
    await runUiAction(db, { target, action: "enable", caller: user() as never, now: NOW });
    expect(getOwnerDmSync(db)).toEqual({ enabled: true, updatedAt: NOW.toISOString(), updatedBy: "user" });
    await expect(runUiAction(db, { target, action: "enable", caller: user() as never })).rejects.toMatchObject({ code: "unavailable" });
    await runUiAction(db, { target, action: "disable", caller: user() as never });
    expect(getOwnerDmSync(db).enabled).toBe(false);
  });
});

describe("owner_dm_sync from Lead", () => {
  it("switches in the user's own live turn, in the App or in the user's own Slack DM", async () => {
    userTurn("turn-app");
    const outcome = await runUiAction(db, { target, action: "enable", reason: "用户说开启同步", caller: { kind: "lead", turnId: "turn-app" } });
    expect(outcome.by).toMatchObject({ actor: "lead", onBehalfOf: { actor: "user", sourceTurnId: "turn-app" } });
    expect(getOwnerDmSync(db)).toMatchObject({ enabled: true, updatedBy: "lead" });
    userTurn("turn-slack", "paired:slack");
    await runUiAction(db, { target, action: "disable", reason: "用户在私信里说关闭同步", caller: { kind: "lead", turnId: "turn-slack" } });
    expect(getOwnerDmSync(db).enabled).toBe(false);
  });

  it("refuses a turn an external message woke", async () => {
    await expect(runUiAction(db, {
      target, action: "enable", reason: "Slack 里有人让我打开",
      caller: { kind: "lead", turnId: null, externalContent: [{ via: "message", source: "slack" }] },
    })).rejects.toMatchObject({ code: "external_turn" });
    expect(getOwnerDmSync(db).enabled).toBe(false);
  });

  it("refuses a turn Lead's own timer or system event woke", async () => {
    await expect(runUiAction(db, {
      target, action: "enable", reason: "到点了", caller: { kind: "lead", turnId: null },
    })).rejects.toMatchObject({ code: "needs_user_turn" });
    const system = createTurn(db, { originKind: "system:reminder", userText: "", state: "streaming" });
    await expect(runUiAction(db, {
      target, action: "enable", reason: "到点了", caller: { kind: "lead", turnId: system.id },
    })).rejects.toMatchObject({ code: "needs_user_turn" });
    expect(getOwnerDmSync(db).enabled).toBe(false);
  });

  it("refuses the turn of a follow-up the user set, though that turn counts as the user's for other actions", async () => {
    userTurn("turn-set");
    const followUp = addLeadFollowUp(db, {
      at: new Date(Date.now() - 1_000), note: "到点开启同步", setBy: { turnId: "turn-set", bindingId: owner.id, startedAt: new Date().toISOString() },
    });
    completeTurn(db, "turn-set");
    await expect(runUiAction(db, {
      target, action: "enable", reason: "用户昨天让我今天打开", caller: { kind: "lead", turnId: `timer:${followUp}` },
    })).rejects.toMatchObject({ code: "needs_user_turn", message: expect.stringContaining("定时器") });
    const listing = await listLeadUiActions(db, target, { turnId: `timer:${followUp}` });
    expect(listing.actions.find((action) => action.id === "enable")).toMatchObject({ leadReady: false, leadReason: expect.stringContaining("定时器") });
    expect(getOwnerDmSync(db).enabled).toBe(false);
  });

  it("lists the switch for Lead with its state", async () => {
    userTurn("turn-app");
    const listing = await listLeadUiActions(db, target, { turnId: "turn-app" });
    expect(listing.target).toMatchObject({ type: "owner_dm_sync", enabled: false });
    expect(listing.actions.map((action) => [action.id, action.available, action.leadReady])).toEqual([["enable", true, true], ["disable", false, false]]);
  });
});
