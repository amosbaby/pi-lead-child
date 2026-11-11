// 旧库导入 hub 数据目录：WAL 安全地复制、完整性检查、再打开一次让对齐和迁移在副本上跑；原库不动。
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createItem, openDb, transition, type Db } from "../src/index.js";
import { importLegacyDb } from "../src/hub-import.js";

const USAGE_PARTS = ["uncached_input_tokens", "cache_write_tokens", "cache_read_tokens", "output_tokens"];
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const stageCounts = (db: Db | Database.Database) => db.prepare("SELECT stage, COUNT(*) AS n FROM items GROUP BY stage ORDER BY stage").all();
const columns = (db: Db, table: string) => (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);

// 一个有几条不同阶段工单的旧库，已经关闭（WAL 已并回主文件）。
function legacyDb(path: string): void {
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
  db.close();
}

// 造成 integration/latest 迁移过的样子：v64–v67 的行换成 latest 的，hub 在 v64/v65 才加的列去掉。
function makeLatestShaped(path: string): void {
  const db = openDb(path);
  for (const column of USAGE_PARTS) db.exec(`ALTER TABLE items DROP COLUMN ${column}`);
  db.exec("ALTER TABLE watches DROP COLUMN host_run");
  db.prepare("DELETE FROM schema_migrations WHERE version >= 64").run();
  const insert = db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)");
  for (const [version, name] of [[64, "unsandboxed-execution-v1"], [65, "channel-owner-dm-v1"], [66, "claude-memory-sync-v1"], [67, "token-usage-resume-recompute-v1"]] as const) {
    insert.run(version, name);
  }
  db.close();
}

function paths(prefix: string) {
  const root = tempDir(prefix);
  const legacyDir = join(root, "legacy");
  const hubDir = join(root, "hub");
  mkdirSync(legacyDir);
  mkdirSync(hubDir);
  return { legacyPath: join(legacyDir, "plc.db"), hubPath: join(hubDir, "plc.db"), hubDir };
}

describe("importLegacyDb", () => {
  it("copies with backup, checks integrity, and reports unchanged rows", async () => {
    const { legacyPath, hubPath } = paths("plc-hub-import-");
    legacyDb(legacyPath);
    const legacyHash = sha(legacyPath);
    const legacyMtime = statSync(legacyPath).mtimeMs;
    const before = new Database(legacyPath, { readonly: true });
    const sameBeforeAfter = Object.fromEntries((before.prepare("SELECT stage, COUNT(*) AS n FROM items GROUP BY stage").all() as Array<{ stage: string; n: number }>)
      .map((row) => [row.stage, { before: row.n, after: row.n }]));
    before.close();

    const report = await importLegacyDb({ from: legacyPath, to: hubPath });

    expect(report.stages).toEqual(sameBeforeAfter);
    expect(report.stages).toEqual({ ready: { before: 1, after: 1 }, active: { before: 1, after: 1 }, done: { before: 1, after: 1 } });
    expect(report.tableRows.items).toEqual({ before: 3, after: 3 });
    expect(report.reconcile).toEqual({ renumbered: [], foreign: [] });
    // 原库不动：修改时间和内容都一样，旁边没有留下别的文件。
    expect(statSync(legacyPath).mtimeMs).toBe(legacyMtime);
    expect(sha(legacyPath)).toBe(legacyHash);
    // 副本能打开，阶段分布一致，目录里没有残留的暂存文件。
    const copy = openDb(hubPath);
    expect(stageCounts(copy)).toEqual([{ stage: "active", n: 1 }, { stage: "done", n: 1 }, { stage: "ready", n: 1 }]);
    copy.close();
    expect(readdirSync(join(hubPath, "..")).filter((name) => name !== "plc.db" && !name.startsWith("plc.db-"))).toEqual([]);
  });

  it("copies what is still only in the write-ahead log", async () => {
    const { legacyPath, hubPath } = paths("plc-hub-import-wal-");
    legacyDb(legacyPath);
    // 一个还开着的写入连接：新行在 plc.db-wal 里，主文件还没有它。直接复制文件字节会丢掉这一行。
    const live = openDb(legacyPath);
    live.pragma("wal_autocheckpoint = 0");
    createItem(live, { title: "only in wal", brief: "b", createdBy: "user" });
    expect(existsSync(`${legacyPath}-wal`)).toBe(true);

    try {
      const report = await importLegacyDb({ from: legacyPath, to: hubPath });
      expect(report.tableRows.items).toEqual({ before: 4, after: 4 });
      expect(report.stages.ready).toEqual({ before: 2, after: 2 });
    } finally {
      live.close();
    }
    const copy = new Database(hubPath, { readonly: true });
    expect(copy.prepare("SELECT COUNT(*) AS n FROM items WHERE title = 'only in wal'").get()).toEqual({ n: 1 });
    copy.close();
  });

  it("refuses when the target already has a database", async () => {
    const { legacyPath, hubPath } = paths("plc-hub-import-exists-");
    legacyDb(legacyPath);
    writeFileSync(hubPath, "not touched");
    await expect(importLegacyDb({ from: legacyPath, to: hubPath })).rejects.toThrow(/already exists/);
    expect(readFileSync(hubPath, "utf8")).toBe("not touched");
  });

  it("refuses when the source is missing or is the target", async () => {
    const { legacyPath, hubPath } = paths("plc-hub-import-missing-");
    await expect(importLegacyDb({ from: legacyPath, to: hubPath })).rejects.toThrow(/no database/);
    expect(existsSync(hubPath)).toBe(false);
    legacyDb(legacyPath);
    await expect(importLegacyDb({ from: legacyPath, to: legacyPath })).rejects.toThrow(/same/);
  });

  it("opens the copy through reconcile and migrations, and leaves the original latest-shaped", async () => {
    const { legacyPath, hubPath } = paths("plc-hub-import-latest-");
    legacyDb(legacyPath);
    makeLatestShaped(legacyPath);
    const legacyHash = sha(legacyPath);

    const report = await importLegacyDb({ from: legacyPath, to: hubPath });

    expect(report.reconcile).toEqual({
      renumbered: [
        { name: "unsandboxed-execution-v1", from: 64, to: 66 },
        { name: "channel-owner-dm-v1", from: 65, to: 67 },
      ],
      foreign: ["claude-memory-sync-v1", "token-usage-resume-recompute-v1"],
    });
    expect(report.stages).toEqual({ ready: { before: 1, after: 1 }, active: { before: 1, after: 1 }, done: { before: 1, after: 1 } });
    expect(report.tableRows.items).toEqual({ before: 3, after: 3 });
    expect(report.tableRows).not.toHaveProperty("schema_migrations");
    expect(sha(legacyPath)).toBe(legacyHash);
    const original = new Database(legacyPath, { readonly: true });
    expect(original.prepare("SELECT name FROM schema_migrations WHERE version = 66").get()).toEqual({ name: "claude-memory-sync-v1" });
    original.close();
    const copy = openDb(hubPath);
    expect(copy.prepare("SELECT name FROM schema_migrations WHERE version = 66").get()).toEqual({ name: "unsandboxed-execution-v1" });
    for (const column of USAGE_PARTS) expect(columns(copy, "items")).toContain(column);
    expect(columns(copy, "watches")).toContain("host_run");
    copy.close();
  });

  it("leaves no target behind when the copy cannot be opened by this build", async () => {
    const { legacyPath, hubPath, hubDir } = paths("plc-hub-import-unknown-");
    legacyDb(legacyPath);
    const raw = openDb(legacyPath); // 账本的写入守卫只认 openDb 的连接
    raw.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(99, "mystery-v1");
    raw.close();
    await expect(importLegacyDb({ from: legacyPath, to: hubPath })).rejects.toThrow(/mystery-v1/);
    expect(readdirSync(hubDir)).toEqual([]);
    // 原来没有的东西没出现，原库的行也没变。
    const original = new Database(legacyPath, { readonly: true });
    expect(original.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name = 'mystery-v1'").get()).toEqual({ n: 1 });
    original.close();
  });
});
