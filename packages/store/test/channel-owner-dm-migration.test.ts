// v65：用户自己私信里的决定请求和工单的来源对话（工单 #81）。只加 channel_decision_pushes、channel_ticket_origins 两张表，不回填。
// 三条路径：新库、老库（v64）升级、重新打开。已有工单的生命周期字段和活动一个都不变，以前的决定请求不会被当成推过的。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  addActivity, createItem, insertDecisionPush, insertDecisionRequest, LATEST_SCHEMA_VERSION, openDb, recordTicketOrigin, SCHEMA_MIGRATION_VERSIONS,
  ticketOriginConversations, transition, unpushedUserDecisions, type Db,
} from "../src/index.js";

const tables = (db: Db) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);

describe("the v65 channel owner DM migration", () => {
  it("has both tables in a new database and records the version", () => {
    const db = openDb(join(tempDir("plc-v65-fresh-"), "plc.db"));
    expect(tables(db)).toEqual(expect.arrayContaining(["channel_decision_pushes", "channel_ticket_origins"]));
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 65").get()).toEqual({ name: "channel-owner-dm-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(65);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(65);
    db.close();
  });

  it("upgrades a v64 database without touching items, activities or decisions, then reopens", () => {
    const path = join(tempDir("plc-v65-legacy-"), "plc.db");
    const legacy = openDb(path);
    const done = createItem(legacy, { title: "done", brief: "b", createdBy: "user" });
    transition(legacy, { itemId: done, to: "active", actor: "system", reason: "spawn" });
    transition(legacy, { itemId: done, to: "review", actor: "system", reason: "delivered" });
    transition(legacy, { itemId: done, to: "done", actor: "user", reason: "accepted" });
    const open = createItem(legacy, { title: "open", brief: "b", createdBy: "lead" });
    addActivity(legacy, { itemId: open, actor: "lead", kind: "comment", payload: { text: "hi" } });
    const decision = insertDecisionRequest(legacy, {
      itemId: open, origin: "agent", kind: "decision", audience: "user", prompt: "哪天发？", options: [{ id: "a", label: "周二" }],
      now: new Date("2026-11-05T09:30:00.000Z"),
    });
    // 退回 v64 的样子：没有这两张表，也没有 v65 的记录。
    legacy.exec("DROP TABLE channel_decision_pushes; DROP TABLE channel_ticket_origins;");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 65").run();
    const snapshot = (db: Db) => ({
      items: db.prepare("SELECT id, kind, stage, stage_changed_at, closed_at, first_run_at, created_by, updated_at FROM items ORDER BY id").all(),
      activities: db.prepare("SELECT * FROM activities ORDER BY id").all(),
      decisions: db.prepare("SELECT * FROM decision_requests ORDER BY id").all(),
    });
    const before = snapshot(legacy);
    legacy.close();

    const upgraded = openDb(path);
    expect(tables(upgraded)).toEqual(expect.arrayContaining(["channel_decision_pushes", "channel_ticket_origins"]));
    expect(snapshot(upgraded)).toEqual(before);
    // 以前的决定请求没有推过；按「最近一小时」的窗口才会推。
    const at = new Date("2026-11-05T10:00:00.000Z");
    expect(unpushedUserDecisions(upgraded, { since: new Date(at.getTime() - 60 * 60_000) })).toEqual([{ id: decision.id, itemId: open, origin: "agent" }]);
    expect(insertDecisionPush(upgraded, {
      decisionId: decision.id, itemId: open, conversation: "slack:D0SELF:main", messageKey: `push:${decision.id}`, shownState: "pending", now: at,
    })).toBe(true);
    expect(recordTicketOrigin(upgraded, { itemId: open, conversation: "slack:D0SELF:main", now: at })).toBe(true);
    upgraded.close();

    const reopened = openDb(path);
    expect(unpushedUserDecisions(reopened, { since: new Date(0) })).toEqual([]);
    expect(ticketOriginConversations(reopened, [open])).toEqual(["slack:D0SELF:main"]);
    expect(reopened.prepare("SELECT stage FROM items WHERE id = ?").get(done)).toEqual({ stage: "done" });
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 65").get()).toEqual({ n: 1 });
    reopened.close();
  });
});
