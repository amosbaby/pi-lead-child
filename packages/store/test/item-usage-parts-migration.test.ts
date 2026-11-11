// v64：工单的 token 按计费不同的几部分记（用户 2026-11-06）。items 只加四列，不重建表，不回填。
// 三条路径：新库、老库（v63）升级、重新打开。已有的工单行一列都不变，生命周期字段和活动也不变。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createItem, getItem, LATEST_SCHEMA_VERSION, openDb, SCHEMA_MIGRATION_VERSIONS, transition, type Db } from "../src/index.js";

const PARTS = ["uncached_input_tokens", "cache_write_tokens", "cache_read_tokens", "output_tokens"];
const columns = (db: Db) => (db.pragma("table_info(items)") as Array<{ name: string }>).map((column) => column.name);

describe("the v64 item usage parts migration", () => {
  it("has the columns in a new database and records the version", () => {
    const db = openDb(join(tempDir("plc-v64-fresh-"), "plc.db"));
    expect(columns(db)).toEqual(expect.arrayContaining(PARTS));
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 64").get()).toEqual({ name: "item-usage-parts-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(64);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(64);
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
    expect(getItem(db, itemId)).toMatchObject({ uncached_input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 0 });
    db.close();
  });

  it("upgrades a v63 database without touching items or activities, then reopens", () => {
    const path = join(tempDir("plc-v64-legacy-"), "plc.db");
    const legacy = openDb(path);
    const itemId = createItem(legacy, { title: "done", brief: "b", createdBy: "user" });
    transition(legacy, { itemId, to: "active", actor: "system", reason: "spawn" });
    transition(legacy, { itemId, to: "review", actor: "system", reason: "delivered" });
    transition(legacy, { itemId, to: "done", actor: "user", reason: "accepted" });
    legacy.prepare("UPDATE items SET total_tokens = 12345, total_cost_usd = 1.5 WHERE id = ?").run(itemId);
    // 退回 v63 的样子：没有这四列，也没有 v64 的记录。
    for (const column of PARTS) legacy.exec(`ALTER TABLE items DROP COLUMN ${column}`);
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 64").run();
    const snapshot = (db: Db) => ({
      items: (db.prepare("SELECT * FROM items ORDER BY id").all() as Array<Record<string, unknown>>)
        .map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !PARTS.includes(key)))),
      activities: db.prepare("SELECT * FROM activities ORDER BY id").all(),
    });
    const before = snapshot(legacy);
    expect(columns(legacy)).not.toContain("output_tokens");
    legacy.close();

    const upgraded = openDb(path);
    expect(columns(upgraded).slice(-4)).toEqual(PARTS);
    expect(upgraded.prepare("SELECT name FROM schema_migrations WHERE version = 64").get()).toEqual({ name: "item-usage-parts-v1" });
    expect(snapshot(upgraded)).toEqual(before);
    // 以前的用量没有拆分：四列是 0，total_tokens 原样，减去四列就是未拆分的部分。
    expect(getItem(upgraded, itemId)).toMatchObject({
      total_tokens: 12345, uncached_input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 0,
    });
    upgraded.prepare("UPDATE items SET cache_read_tokens = 7 WHERE id = ?").run(itemId);
    upgraded.close();

    const reopened = openDb(path);
    expect(snapshot(reopened).items).toEqual(before.items);
    expect(getItem(reopened, itemId)!.cache_read_tokens).toBe(7);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 64").get()).toEqual({ n: 1 });
    reopened.close();
  });
});
