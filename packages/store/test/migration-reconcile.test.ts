// 迁移行按名字对齐：hub 分支打开 integration/latest 已经迁移过的库。
// 两条分支的 v64–v67 号码相同、内容不同；对齐只改 schema_migrations 里的号码，不碰业务表和生命周期字段。
import Database from "better-sqlite3";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createItem, openDb, transition, type Db } from "../src/index.js";
import { HUB_MIGRATION_NAMES, KNOWN_FOREIGN_MIGRATIONS, reconcileMigrationRows } from "../src/migration-reconcile.js";

const USAGE_PARTS = ["uncached_input_tokens", "cache_write_tokens", "cache_read_tokens", "output_tokens"];

const columns = (db: Db, table: string) => (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
const tableNames = (db: Db) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
const versions = (db: Db) =>
  (db.prepare("SELECT version, name FROM schema_migrations WHERE version >= 64 ORDER BY version").all() as Array<{ version: number; name: string }>)
    .map((r) => [r.version, r.name]);
const foreignNames = (db: Db) =>
  tableNames(db).includes("schema_migrations_foreign")
    ? (db.prepare("SELECT name FROM schema_migrations_foreign ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name)
    : [];
// 每张业务表的行数。排除的表：schema_migrations 和 schema_migrations_foreign 本来就是对齐要改的；
// notes_fts*（FTS 影子表）和 sqlite_*（SQLite 内部表）由 SQLite 自己维护，行数随索引重建变化，和用户数据无关。
// hub 迁移链在每次打开时幂等播种的表（常设指令、交接说明等）没有单独排除：库是用 hub 的 openDb 建的，种子已经在里面，
// 再次打开不会变；如果哪天某张表因此变了，这个断言应该失败，让人看一眼。
const EXCLUDED_FROM_COUNTS = /^(schema_migrations|schema_migrations_foreign|sqlite_.*|notes_fts.*)$/;
const rowCounts = (db: Db, only?: string[]): Record<string, number> => {
  const names = tableNames(db).filter((name) => !EXCLUDED_FROM_COUNTS.test(name) && (!only || only.includes(name))).sort();
  return Object.fromEntries(names.map((name) => [name, (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n]));
};
const stageCounts = (db: Db) => db.prepare("SELECT stage, COUNT(*) AS n FROM items GROUP BY stage ORDER BY stage").all();

const LATEST_ROWS: Array<[number, string]> = [
  [64, "unsandboxed-execution-v1"],
  [65, "channel-owner-dm-v1"],
  [66, "claude-memory-sync-v1"],
  [67, "token-usage-resume-recompute-v1"],
];

// 造一个 integration/latest 迁移过的库：先用 hub 的完整入口建库，再把 v64–v67 的行换成 latest 的，
// 去掉 hub 在 v64/v65 才加的列，补上 latest 的 claude_memory_sync 表。items.unsandboxed_execution 本来就在。
function latestShapedDb(path: string): { stages: unknown; unsandboxedId: number; counts: Record<string, number> } {
  const db = openDb(path);
  const ids = [
    createItem(db, { title: "draft", brief: "b", createdBy: "user" }),
    createItem(db, { title: "active", brief: "b", createdBy: "user" }),
    createItem(db, { title: "done", brief: "b", createdBy: "user" }),
  ];
  transition(db, { itemId: ids[1]!, to: "active", actor: "system", reason: "spawn" });
  transition(db, { itemId: ids[2]!, to: "active", actor: "system", reason: "spawn" });
  transition(db, { itemId: ids[2]!, to: "review", actor: "system", reason: "delivered" });
  transition(db, { itemId: ids[2]!, to: "done", actor: "user", reason: "accepted" });
  db.prepare("UPDATE items SET unsandboxed_execution = 1 WHERE id = ?").run(ids[1]);
  for (const column of USAGE_PARTS) db.exec(`ALTER TABLE items DROP COLUMN ${column}`);
  db.exec("ALTER TABLE watches DROP COLUMN host_run");
  db.exec(`CREATE TABLE claude_memory_sync (
    bank_index TEXT NOT NULL, document_id TEXT NOT NULL, fingerprint TEXT NOT NULL, operation_id TEXT NOT NULL,
    state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (bank_index, document_id)
  )`);
  db.prepare("DELETE FROM schema_migrations WHERE version >= 64").run();
  const insert = db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)");
  for (const [version, name] of LATEST_ROWS) insert.run(version, name);
  const stages = stageCounts(db);
  const counts = rowCounts(db);
  db.close();
  return { stages, unsandboxedId: ids[1]!, counts };
}

describe("reconcileMigrationRows", () => {
  it("names the hub migrations and the known foreign ones", () => {
    expect([...HUB_MIGRATION_NAMES]).toEqual([
      ["item-usage-parts-v1", 64], ["watch-host-run-v1", 65], ["unsandboxed-execution-v1", 66], ["channel-owner-dm-v1", 67],
      ["worker-hub-v1", 68],
    ]);
    expect(KNOWN_FOREIGN_MIGRATIONS).toEqual(["claude-memory-sync-v1", "token-usage-resume-recompute-v1"]);
  });

  it("reconciles a latest-branch database", () => {
    const path = join(tempDir("plc-reconcile-latest-"), "plc.db");
    const { stages, unsandboxedId, counts } = latestShapedDb(path);

    const db = openDb(path); // 完整入口：对齐、再跑 hub 自己的迁移
    expect(versions(db)).toEqual(expect.arrayContaining([
      [64, "item-usage-parts-v1"], [65, "watch-host-run-v1"], [66, "unsandboxed-execution-v1"], [67, "channel-owner-dm-v1"],
      [68, "worker-hub-v1"],
    ]));
    expect(versions(db)).toHaveLength(5);
    expect(foreignNames(db)).toEqual(["claude-memory-sync-v1", "token-usage-resume-recompute-v1"]);
    expect(stageCounts(db)).toEqual(stages); // 生命周期不变
    expect(rowCounts(db, Object.keys(counts))).toEqual(counts); // 每张业务表的行数不变（对齐只改迁移账本）
    expect(counts.items).toBe(3);
    expect(Object.values(counts).some((n) => n > 0)).toBe(true);
    // latest 的库已经有 unsandboxed_execution：hub 的 v66 已记，不再加列，也没有报错，值原样。
    expect(columns(db, "items").filter((c) => c === "unsandboxed_execution")).toHaveLength(1);
    expect(db.prepare("SELECT unsandboxed_execution AS v FROM items WHERE id = ?").get(unsandboxedId)).toEqual({ v: 1 });
    // 缺的 v64/v65 的列由 hub 自己的 migrateDb 补上。
    for (const column of USAGE_PARTS) expect(columns(db, "items")).toContain(column);
    expect(columns(db, "watches")).toContain("host_run");
    // latest 独有的表原样留着。
    expect(tableNames(db)).toContain("claude_memory_sync");
    db.close();
  });

  it("is idempotent on reopen", () => {
    const path = join(tempDir("plc-reconcile-reopen-"), "plc.db");
    latestShapedDb(path);
    const first = openDb(path);
    const rows = first.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
    const foreign = first.prepare("SELECT version, name, moved_at FROM schema_migrations_foreign ORDER BY name").all();
    first.close();

    const second = openDb(path);
    expect(reconcileMigrationRows(second)).toEqual({ renumbered: [], foreign: [] });
    expect(second.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all()).toEqual(rows);
    expect(second.prepare("SELECT version, name, moved_at FROM schema_migrations_foreign ORDER BY name").all()).toEqual(foreign);
    second.close();
  });

  it("reports what it moved", () => {
    const path = join(tempDir("plc-reconcile-report-"), "plc.db");
    latestShapedDb(path);
    const raw = openDb(path);
    // 退回对齐之前的样子（openDb 已经对齐过一次，这里重新换成 latest 的行）。
    raw.prepare("DELETE FROM schema_migrations WHERE version >= 64").run();
    raw.exec("DELETE FROM schema_migrations_foreign");
    const insert = raw.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)");
    for (const [version, name] of LATEST_ROWS) insert.run(version, name);
    expect(reconcileMigrationRows(raw)).toEqual({
      renumbered: [
        { name: "unsandboxed-execution-v1", from: 64, to: 66 },
        { name: "channel-owner-dm-v1", from: 65, to: 67 },
      ],
      foreign: ["claude-memory-sync-v1", "token-usage-resume-recompute-v1"],
    });
    raw.close();
  });

  it("leaves a fresh database untouched", () => {
    const db = openDb(join(tempDir("plc-reconcile-fresh-"), "plc.db"));
    expect(tableNames(db)).not.toContain("schema_migrations_foreign");
    expect(foreignNames(db)).toEqual([]);
    expect(versions(db).map(([, name]) => name)).toEqual(["item-usage-parts-v1", "watch-host-run-v1", "unsandboxed-execution-v1", "channel-owner-dm-v1", "worker-hub-v1"]);
    expect(reconcileMigrationRows(db)).toEqual({ renumbered: [], foreign: [] });
    db.close();
  });

  it("returns an empty report when there is no schema_migrations table yet", () => {
    const db = openDb(join(tempDir("plc-reconcile-empty-"), "plc.db"));
    db.exec("DROP TABLE schema_migrations");
    expect(reconcileMigrationRows(db)).toEqual({ renumbered: [], foreign: [] });
    expect(tableNames(db)).not.toContain("schema_migrations");
    db.close();
  });

  it("leaves an upstream-only database untouched", () => {
    // 只跑过 hub 自己 v64/v65（上游那两条）的库：行的名字和号码本来就对。
    const path = join(tempDir("plc-reconcile-upstream-"), "plc.db");
    const legacy = openDb(path);
    createItem(legacy, { title: "draft", brief: "b", createdBy: "user" });
    const active = createItem(legacy, { title: "active", brief: "b", createdBy: "user" });
    transition(legacy, { itemId: active, to: "active", actor: "system", reason: "spawn" });
    legacy.prepare("DELETE FROM schema_migrations WHERE version >= 66").run();
    legacy.exec("DROP TABLE channel_decision_pushes; DROP TABLE channel_ticket_origins;");
    const before = legacy.prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version").all();
    const stagesBefore = stageCounts(legacy);
    const countsBefore = rowCounts(legacy);
    expect(countsBefore.items).toBe(2);
    expect(reconcileMigrationRows(legacy)).toEqual({ renumbered: [], foreign: [] });
    expect(stageCounts(legacy)).toEqual(stagesBefore);
    expect(rowCounts(legacy)).toEqual(countsBefore);
    expect(legacy.prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version").all()).toEqual(before);
    expect(foreignNames(legacy)).toEqual([]);
    legacy.close();
    const reopened = openDb(path);
    expect(foreignNames(reopened)).toEqual([]);
    expect(versions(reopened).map(([version]) => version)).toEqual([64, 65, 66, 67, 68]);
    // 重新打开补回 v66/v67 时新建的两张表不在「之前」里，其余表的行数和阶段分布不变。
    expect(stageCounts(reopened)).toEqual(stagesBefore);
    expect(rowCounts(reopened, Object.keys(countsBefore))).toEqual(countsBefore);
    reopened.close();
  });

  it("stops on an unknown migration name at or above v64", () => {
    const path = join(tempDir("plc-reconcile-unknown-"), "plc.db");
    latestShapedDb(path);
    const raw = openDb(path);
    raw.prepare("DELETE FROM schema_migrations WHERE version >= 64").run();
    raw.exec("DROP TABLE IF EXISTS schema_migrations_foreign");
    const insert = raw.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)");
    insert.run(64, "unsandboxed-execution-v1");
    insert.run(65, "claude-memory-sync-v1");
    insert.run(66, "mystery-v1");
    const before = raw.prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version").all();
    raw.close();

    expect(() => openDb(path)).toThrow(/mystery-v1/);

    // 抛错之前什么都没改：行原样，外来表没建。
    const check = new Database(path, { readonly: true, fileMustExist: true });
    expect(check.prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version").all()).toEqual(before);
    expect(tableNames(check)).not.toContain("schema_migrations_foreign");
    check.close();
  });
});
