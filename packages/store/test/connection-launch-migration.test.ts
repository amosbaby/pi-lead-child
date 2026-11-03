// v63：本地 MCP 的启动参数（.scratch/lead-self-install/spec.md D3）。connections 只加一列 launch_json，不重建表，不回填。
// 三条路径：新库、老库（v62）升级、重新打开。已有的连接行一列都不变，工单的生命周期字段和活动也不变。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  createItem, getConnection, insertConnection, LATEST_SCHEMA_VERSION, openDb, SCHEMA_MIGRATION_VERSIONS, transition, updateConnection, type Db,
} from "../src/index.js";

const columns = (db: Db) => (db.pragma("table_info(connections)") as Array<{ name: string }>).map((column) => column.name);
const launch = JSON.stringify({ registry: "npm", package: "@acme/fake-mcp", version: "1.2.3", bin: "fake-mcp", args: [] });

describe("the v63 connection launch migration", () => {
  it("has the column in a new database and records the version", () => {
    const db = openDb(join(tempDir("plc-v63-fresh-"), "plc.db"));
    expect(columns(db)).toContain("launch_json");
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 63").get()).toEqual({ name: "connection-launch-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(63);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(63);
    const row = insertConnection(db, { provider: "custom", label: "fake", serverUrl: "stdio:npm:@acme/fake-mcp@1.2.3", tokenSource: "oauth", launchJson: launch });
    expect(getConnection(db, row.id)!.launch_json).toBe(launch);
    db.close();
  });

  it("upgrades a v62 database without touching connections, items or activities, then reopens", () => {
    const path = join(tempDir("plc-v63-legacy-"), "plc.db");
    const legacy = openDb(path);
    const itemId = createItem(legacy, { title: "done", brief: "b", createdBy: "user" });
    transition(legacy, { itemId, to: "active", actor: "system", reason: "spawn" });
    transition(legacy, { itemId, to: "review", actor: "system", reason: "delivered" });
    transition(legacy, { itemId, to: "done", actor: "user", reason: "accepted" });
    const remote = insertConnection(legacy, { provider: "custom", label: "mcp.example.com", serverUrl: "https://mcp.example.com/mcp", tokenSource: "oauth" });
    updateConnection(legacy, remote.id, { status: "connected", account_label: "alice@example.com" });
    // 退回 v62 的样子：没有这一列，也没有 v63 的记录。
    legacy.exec("ALTER TABLE connections DROP COLUMN launch_json");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 63").run();
    const snapshot = (db: Db) => ({
      items: db.prepare("SELECT * FROM items ORDER BY id").all(),
      activities: db.prepare("SELECT * FROM activities ORDER BY id").all(),
      connections: db.prepare("SELECT id, provider, label, server_url, status, account_label, roles, write_policy FROM connections ORDER BY id").all(),
    });
    const before = snapshot(legacy);
    expect(columns(legacy)).not.toContain("launch_json");
    legacy.close();

    const upgraded = openDb(path);
    expect(columns(upgraded)).toContain("launch_json");
    expect(upgraded.prepare("SELECT name FROM schema_migrations WHERE version = 63").get()).toEqual({ name: "connection-launch-v1" });
    expect(snapshot(upgraded)).toEqual(before);
    expect(getConnection(upgraded, remote.id)!.launch_json).toBeNull();
    const local = insertConnection(upgraded, { provider: "custom", label: "fake", serverUrl: "stdio:npm:@acme/fake-mcp@1.2.3", tokenSource: "oauth", launchJson: launch });
    upgraded.close();

    const reopened = openDb(path);
    expect(snapshot(reopened).items).toEqual(before.items);
    expect(getConnection(reopened, local.id)!.launch_json).toBe(launch);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 63").get()).toEqual({ n: 1 });
    reopened.close();
  });
});
