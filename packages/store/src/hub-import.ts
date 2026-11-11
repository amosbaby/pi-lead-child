import Database from "better-sqlite3";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openDb } from "./db.js";
import type { ReconcileReport } from "./migration-reconcile.js";

// 把旧数据目录里的 plc.db 复制进 hub 自己的数据目录，并在副本上跑 hub 的对齐和迁移。
// hub 不和旧 daemon 共用数据目录：两边各自迁移同一个库会互相踩号码。原库只读打开，一个字节都不改。
// 复制走 SQLite 的 backup API（WAL 里还没并回主文件的行也会进副本）；直接复制文件字节会丢掉它们。

export type RowCounts = Record<string, { before: number; after: number }>;

export type HubImportReport = {
  tableRows: RowCounts;
  stages: RowCounts;
  reconcile: ReconcileReport;
};

// 行数不比较的表：迁移账本本来就是对齐要改的；FTS 影子表和 SQLite 内部表由 SQLite 自己维护，行数随索引重建变化。
const EXCLUDED_TABLES = /^(schema_migrations|schema_migrations_foreign|sqlite_.*|notes_fts.*)$/;

type Reader = Pick<Database.Database, "prepare">;

function tableRows(db: Reader): Record<string, number> {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => !EXCLUDED_TABLES.test(name));
  return Object.fromEntries(names.map((name) => [name, (db.prepare(`SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`).get() as { n: number }).n]));
}

function stageRows(db: Reader): Record<string, number> {
  const hasStage = db.prepare("SELECT 1 FROM pragma_table_info('items') WHERE name = 'stage'").get();
  if (!hasStage) return {};
  const rows = db.prepare("SELECT stage, COUNT(*) AS n FROM items GROUP BY stage").all() as Array<{ stage: string; n: number }>;
  return Object.fromEntries(rows.map((row) => [row.stage, row.n]));
}

function pair(before: Record<string, number>, after: Record<string, number>): RowCounts {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return Object.fromEntries(keys.map((key) => [key, { before: before[key] ?? 0, after: after[key] ?? 0 }]));
}

function removeDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${path}${suffix}`, { force: true });
}

// from / to 是 plc.db 文件的路径。目标已有库时拒绝；失败时目标路径上不留任何东西（先写暂存文件，成功后改名）。
export async function importLegacyDb(input: { from: string; to: string }): Promise<HubImportReport> {
  const from = resolve(input.from);
  const to = resolve(input.to);
  if (from === to) throw new Error("the source and the target are the same database");
  if (!existsSync(from)) throw new Error("no database at the source");
  if (existsSync(to) || existsSync(`${to}-wal`)) throw new Error("the target already exists; refusing to overwrite it");
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });

  const staging = `${to}.importing`;
  removeDb(staging); // 上一次中断留下的暂存文件，是这个命令自己的
  try {
    const source = new Database(from, { readonly: true, fileMustExist: true });
    let before: { tables: Record<string, number>; stages: Record<string, number> };
    try {
      source.pragma("busy_timeout = 5000");
      before = { tables: tableRows(source), stages: stageRows(source) };
      await source.backup(staging);
    } finally {
      source.close();
    }

    const check = new Database(staging, { readonly: true, fileMustExist: true });
    try {
      const result = check.pragma("integrity_check") as Array<{ integrity_check: string }>;
      if (result.length !== 1 || result[0]!.integrity_check !== "ok") {
        throw new Error(`integrity_check failed on the copy: ${result.slice(0, 5).map((row) => row.integrity_check).join("; ")}`);
      }
    } finally {
      check.close();
    }

    // 副本上跑 hub 的对齐和迁移（openDb 的第一步就是 reconcileMigrationRows）。
    let reconcile: ReconcileReport = { renumbered: [], foreign: [] };
    const db = openDb(staging, { onReconcile: (report) => { reconcile = report; } });
    let after: { tables: Record<string, number>; stages: Record<string, number> };
    try {
      after = { tables: tableRows(db), stages: stageRows(db) };
    } finally {
      db.close();
    }
    // close 会把 WAL 并回主文件；确认没有残留的旁文件再改名，否则它们会被留在暂存名下。
    for (const suffix of ["-wal", "-shm"]) rmSync(`${staging}${suffix}`, { force: true });
    renameSync(staging, to);
    return { tableRows: pair(before.tables, after.tables), stages: pair(before.stages, after.stages), reconcile };
  } catch (error) {
    removeDb(staging);
    throw error;
  }
}
