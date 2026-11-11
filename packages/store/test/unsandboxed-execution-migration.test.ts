// v66：「沙箱外执行」授权（工单 #62）。items 只加一列 unsandboxed_execution（缺省 0），不重建表，不回填。
// 三条路径：新库、老库（v65）升级、重新打开。已有工单的生命周期字段和活动一个都不变。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  addActivity, createItem, getItem, LATEST_SCHEMA_VERSION, listEvents, openDb, SCHEMA_MIGRATION_VERSIONS,
  setItemUnsandboxedExecution, transition, type Db,
} from "../src/index.js";

const columns = (db: Db) => (db.pragma("table_info(items)") as Array<{ name: string }>).map((column) => column.name);

describe("the v66 unsandboxed execution migration", () => {
  it("has the column in a new database, off by default, and records the version", () => {
    const db = openDb(join(tempDir("plc-v66-fresh-"), "plc.db"));
    // 放在最后：老库用 ALTER 补在末尾，新库和老库的列顺序一致。
    expect(columns(db).at(-1)).toBe("unsandboxed_execution");
    expect(db.prepare("SELECT name FROM schema_migrations WHERE version = 66").get()).toEqual({ name: "unsandboxed-execution-v1" });
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(66);
    expect(SCHEMA_MIGRATION_VERSIONS).toContain(66);
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
    expect(getItem(db, itemId)!.unsandboxed_execution).toBe(0);
    expect(() => db.prepare("UPDATE items SET unsandboxed_execution = 2 WHERE id = ?").run(itemId)).toThrow(/CHECK/);
    db.close();
  });

  it("upgrades a v65 database without touching items or activities, then reopens", () => {
    const path = join(tempDir("plc-v66-legacy-"), "plc.db");
    const legacy = openDb(path);
    const done = createItem(legacy, { title: "done", brief: "b", createdBy: "user" });
    transition(legacy, { itemId: done, to: "active", actor: "system", reason: "spawn" });
    transition(legacy, { itemId: done, to: "review", actor: "system", reason: "delivered" });
    transition(legacy, { itemId: done, to: "done", actor: "user", reason: "accepted" });
    const open = createItem(legacy, { title: "open", brief: "b", createdBy: "lead" });
    addActivity(legacy, { itemId: open, actor: "lead", kind: "comment", payload: { text: "hi" } });
    // 退回 v65 的样子：没有这一列，也没有 v66 的记录。
    legacy.exec("ALTER TABLE items DROP COLUMN unsandboxed_execution");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 66").run();
    const snapshot = (db: Db) => ({
      items: db.prepare(
        "SELECT id, kind, stage, stage_changed_at, closed_at, first_run_at, created_by, updated_at FROM items ORDER BY id",
      ).all(),
      activities: db.prepare("SELECT * FROM activities ORDER BY id").all(),
    });
    const before = snapshot(legacy);
    expect(columns(legacy)).not.toContain("unsandboxed_execution");
    legacy.close();

    const upgraded = openDb(path);
    expect(columns(upgraded).at(-1)).toBe("unsandboxed_execution");
    expect(snapshot(upgraded)).toEqual(before);
    expect(getItem(upgraded, done)!.unsandboxed_execution).toBe(0);
    expect(getItem(upgraded, open)!.unsandboxed_execution).toBe(0);
    expect(setItemUnsandboxedExecution(upgraded, open, true, { actor: "user", reason: "用户打开" })).toBe(true);
    upgraded.close();

    const reopened = openDb(path);
    expect(getItem(reopened, open)!.unsandboxed_execution).toBe(1);
    expect(getItem(reopened, done)!.stage).toBe("done");
    expect(listEvents(reopened, { kind: "ticket.sandbox_changed" }).map((event) => event.payload))
      .toEqual([expect.objectContaining({ itemId: open, unsandboxed: true, actor: "user" })]);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 66").get()).toEqual({ n: 1 });
    reopened.close();
  });
});
