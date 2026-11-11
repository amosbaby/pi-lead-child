// v68 worker-hub-v1：来源表、工单判断列、推送表、「没找到」记录。只加表和列，已有的行回填来源但不改。
// 三条路径：新库、v67 的老库升级（含回填）、重新打开。items 的生命周期字段一个都不变。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  addActivity, createChannelLookup, createItem, LATEST_SCHEMA_VERSION, openChannelCard, openDb, recordChannelLaneMessage,
  recordTicketOrigin, SCHEMA_MIGRATION_VERSIONS, ticketSources, transition, updateChannelLookup, type ChannelLookupIntake, type Db,
} from "../src/index.js";

const tables = (db: Db) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
const columns = (db: Db, table: string) => (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
const NEW_ITEM_COLUMNS = ["handling", "handling_reason", "complexity", "external_origin"];

const INTAKE: ChannelLookupIntake = {
  answered: true, askKind: "lookup", askConfidence: 0.8, targetRepo: "acme/x", sensitive: {}, topics: {}, gate: null,
  at: "2026-11-05T06:30:00.000Z",
};

function cardIn(db: Db, objectKey: string, replyTarget: Record<string, string>): number {
  const lane = recordChannelLaneMessage(db, {
    source: "slack", objectKey, label: "对话", message: { at: new Date().toISOString(), seq: null, role: "them", sender: "Nina", text: "hi" },
  });
  return openChannelCard(db, {
    laneId: lane.id, source: "slack", objectKey, delivery: "card", seq: 1,
    sender: { id: "u1", name: "Nina", trust: "colleague" }, excerpt: "hi", replyTarget,
  }).id;
}

function lookupFor(db: Db, cardId: number, objectKey: string, itemId: number | null): number {
  const lookup = createChannelLookup(db, {
    cardId, source: "slack", objectKey, forSeq: 1, playbook: "lookup",
    requester: { id: "u1", name: "Nina", trust: "colleague" }, question: "why did the webhook not fire?", intake: INTAKE,
    at: new Date("2026-11-05T07:00:00.000Z"),
  });
  if (itemId !== null) updateChannelLookup(db, lookup.id, { itemId, state: "running" });
  return lookup.id;
}

describe("the v68 worker hub migration", () => {
  it("has the tables and columns in a new database and records the version", () => {
    const db = openDb(join(tempDir("plc-v68-fresh-"), "plc.db"));
    expect(tables(db)).toEqual(expect.arrayContaining(["ticket_sources", "ticket_pushes", "ticket_misses"]));
    expect(columns(db, "ticket_sources")).toEqual(["id", "item_id", "kind", "url", "external_key", "conversation", "message_ts", "created_at"]);
    expect(columns(db, "ticket_pushes")).toEqual(["item_id", "reason", "conversation", "message_ref", "shown_state", "created_at", "updated_at"]);
    expect(columns(db, "ticket_misses")).toEqual(["id", "text", "created_at"]);
    for (const column of NEW_ITEM_COLUMNS) expect(columns(db, "items")).toContain(column);
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 68").get()).toEqual({ name: "worker-hub-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(68);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(68);
    // A new ticket is not judged yet and did not come from outside.
    const id = createItem(db, { title: "t", brief: "b", createdBy: "user" });
    expect(db.prepare("SELECT handling, handling_reason, complexity, external_origin FROM items WHERE id = ?").get(id))
      .toEqual({ handling: null, handling_reason: null, complexity: null, external_origin: 0 });
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'ticket_sources_external_key'").get())
      .toEqual({ sql: expect.stringMatching(/UNIQUE INDEX .*\(kind, external_key\) WHERE external_key IS NOT NULL/) });
    db.close();
  });

  it("rejects values outside the CHECK lists", () => {
    const db = openDb(join(tempDir("plc-v68-check-"), "plc.db"));
    const id = createItem(db, { title: "t", brief: "b", createdBy: "user" });
    expect(() => db.prepare("UPDATE items SET handling = 'maybe' WHERE id = ?").run(id)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE items SET complexity = 'huge' WHERE id = ?").run(id)).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO ticket_sources (item_id, kind, created_at) VALUES (?, 'email', 'x')").run(id)).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO ticket_pushes (item_id, message_ref, created_at, updated_at) VALUES (?, 'not json', 'x', 'x')").run(id))
      .toThrow(/CHECK/);
    db.close();
  });

  it("upgrades a v67 database: backfills sources from owner DM origins and lookup cards, changes no item, then reopens", () => {
    const path = join(tempDir("plc-v68-legacy-"), "plc.db");
    const legacy = openDb(path);
    const done = createItem(legacy, { title: "done", brief: "b", createdBy: "user" });
    transition(legacy, { itemId: done, to: "active", actor: "system", reason: "spawn" });
    transition(legacy, { itemId: done, to: "review", actor: "system", reason: "delivered" });
    transition(legacy, { itemId: done, to: "done", actor: "user", reason: "accepted" });
    const cancelled = createItem(legacy, { title: "cancelled", brief: "b", createdBy: "user" });
    transition(legacy, { itemId: cancelled, to: "cancelled", actor: "user", reason: "no" });
    const fromDm = createItem(legacy, { title: "from the owner DM", brief: "b", createdBy: "lead" });
    addActivity(legacy, { itemId: fromDm, actor: "lead", kind: "comment", payload: { text: "hi" } });
    const fromLookup = createItem(legacy, { title: "from a lookup card", brief: "b", createdBy: "lead" });
    const unlinked = createItem(legacy, { title: "lookup without a ticket yet", brief: "b", createdBy: "lead" });
    void unlinked;
    recordTicketOrigin(legacy, { itemId: fromDm, conversation: "slack:D0SELF:main", now: new Date("2026-11-05T09:30:00.000Z") });
    const cardId = cardIn(legacy, "slack:C0TEAM:1730790000.000100", { channel: "C0TEAM", thread_ts: "1730790000.000100" });
    lookupFor(legacy, cardId, "slack:C0TEAM:1730790000.000100", fromLookup);
    // A lookup card that never got a ticket gives no source.
    const bareCard = cardIn(legacy, "slack:C0TEAM:1730790100.000200", { channel: "C0TEAM", thread_ts: "1730790100.000200" });
    lookupFor(legacy, bareCard, "slack:C0TEAM:1730790100.000200", null);
    // Back to v67: no v68 tables or columns, no v68 row.
    legacy.exec("DROP TABLE ticket_sources; DROP TABLE ticket_pushes; DROP TABLE ticket_misses;");
    for (const column of NEW_ITEM_COLUMNS) legacy.exec(`ALTER TABLE items DROP COLUMN ${column}`);
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 68").run();
    const lifecycle = (db: Db) => db.prepare(
      "SELECT id, kind, stage, stage_changed_at, closed_at, first_run_at, created_by, updated_at, plan_state, retry_limit FROM items ORDER BY id",
    ).all();
    const stages = (db: Db) => db.prepare("SELECT stage, COUNT(*) AS n FROM items GROUP BY stage ORDER BY stage").all();
    const rows = (db: Db, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
    const before = {
      lifecycle: lifecycle(legacy), stages: stages(legacy), activities: rows(legacy, "activities"), cards: rows(legacy, "channel_cards"),
      lookups: rows(legacy, "channel_lookups"), origins: rows(legacy, "channel_ticket_origins"),
    };
    legacy.close();

    const upgraded = openDb(path);
    for (const column of NEW_ITEM_COLUMNS) expect(columns(upgraded, "items")).toContain(column);
    expect(lifecycle(upgraded)).toEqual(before.lifecycle);
    expect(stages(upgraded)).toEqual(before.stages);
    expect(rows(upgraded, "activities")).toEqual(before.activities);
    expect(rows(upgraded, "channel_cards")).toEqual(before.cards);
    expect(rows(upgraded, "channel_lookups")).toEqual(before.lookups);
    expect(rows(upgraded, "channel_ticket_origins")).toEqual(before.origins);
    // Old tickets are not marked as external and not judged.
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM items WHERE external_origin <> 0 OR handling IS NOT NULL OR complexity IS NOT NULL").get())
      .toEqual({ n: 0 });
    // The owner DM origin has no message position; the lookup card has one; neither has a URL (no workspace domain in code).
    expect(ticketSources(upgraded, fromDm)).toEqual([expect.objectContaining({
      itemId: fromDm, kind: "slack", url: null, externalKey: null, conversation: "slack:D0SELF:main", messageTs: null, createdAt: "2026-11-05T09:30:00.000Z",
    })]);
    expect(ticketSources(upgraded, fromLookup)).toEqual([expect.objectContaining({
      itemId: fromLookup, kind: "slack", url: null, externalKey: null, conversation: "slack:C0TEAM:1730790000.000100", messageTs: "1730790000.000100",
    })]);
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM ticket_sources").get()).toEqual({ n: 2 });
    upgraded.close();

    const reopened = openDb(path);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM ticket_sources").get()).toEqual({ n: 2 });
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 68").get()).toEqual({ n: 1 });
    expect(reopened.prepare("SELECT stage FROM items WHERE id = ?").get(done)).toEqual({ stage: "done" });
    expect(lifecycle(reopened)).toEqual(before.lifecycle);
    reopened.close();
  });

  it("does not duplicate a backfilled source when the migration runs again over the same rows", () => {
    const path = join(tempDir("plc-v68-rerun-"), "plc.db");
    const db = openDb(path);
    const item = createItem(db, { title: "t", brief: "b", createdBy: "lead" });
    recordTicketOrigin(db, { itemId: item, conversation: "slack:D0SELF:main", now: new Date("2026-11-05T09:30:00.000Z") });
    db.prepare("DELETE FROM schema_migrations WHERE version = 68").run();
    db.prepare("INSERT INTO ticket_sources (item_id, kind, conversation, created_at) VALUES (?, 'slack', 'slack:D0SELF:main', 'x')").run(item);
    db.close();
    const again = openDb(path);
    expect(again.prepare("SELECT COUNT(*) AS n FROM ticket_sources WHERE item_id = ?").get(item)).toEqual({ n: 1 });
    again.close();
  });
});
