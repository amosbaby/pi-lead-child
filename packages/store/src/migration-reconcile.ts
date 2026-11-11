import type { Db } from "./db.js";

// hub 分支和 integration/latest 分支从同一个祖先分出来，各自在 v64 之后加了不同的迁移，号码撞了：
// 同一个 schema_migrations 号码在两边是不同的迁移。每个 migrate* 函数按「这个号码有没有记」判断要不要执行，
// 所以 hub 打开 latest 迁移过的库时，会把自己的 v64/v65 当成已做过而跳过，缺列。
// 这里在迁移链开始之前按名字对齐：hub 认识的名字改回 hub 的号码，latest 独有的名字挪到 schema_migrations_foreign
// 留档。只改 schema_migrations 的行，不碰业务表，也不碰 items.stage 等生命周期字段。
// 缺的列和表由 hub 自己的迁移链随后补上。

// hub 的迁移名到号码。新加迁移时在这里补一行。
export const HUB_MIGRATION_NAMES: ReadonlyMap<string, number> = new Map([
  ["item-usage-parts-v1", 64],
  ["watch-host-run-v1", 65],
  ["unsandboxed-execution-v1", 66],
  ["channel-owner-dm-v1", 67],
  ["worker-hub-v1", 68],
]);

// integration/latest 独有的迁移名：hub 没有对应代码，行留档但不留在 schema_migrations 里。
// claude-memory-sync-v1 建的 claude_memory_sync 表在 hub 上不用，有就留着不动。
export const KNOWN_FOREIGN_MIGRATIONS: readonly string[] = ["claude-memory-sync-v1", "token-usage-resume-recompute-v1"];

// 两条分支开始分叉的第一个号码。比它小的号码两边含义一致，不看。
const FIRST_DIVERGED_VERSION = 64;

export type ReconcileReport = {
  renumbered: Array<{ name: string; from: number; to: number }>;
  foreign: string[];
};

export function reconcileMigrationRows(db: Db): ReconcileReport {
  const report: ReconcileReport = { renumbered: [], foreign: [] };
  // 全新的库还没有 schema_migrations 表（它由随后的 exec(SCHEMA) 建），没有东西可对齐。
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!hasTable) return report;

  const rows = db.prepare("SELECT version, name FROM schema_migrations WHERE version >= ? ORDER BY version")
    .all(FIRST_DIVERGED_VERSION) as Array<{ version: number; name: string }>;
  const foreign = rows.filter((row) => KNOWN_FOREIGN_MIGRATIONS.includes(row.name));
  const moved = rows.filter((row) => HUB_MIGRATION_NAMES.has(row.name) && HUB_MIGRATION_NAMES.get(row.name) !== row.version);
  // 不认识的名字一律停下：它可能是 latest 之后又加的迁移，替它猜号码会让 hub 的迁移链错过或重做某一步。
  // 先检查再动手，库保持原样。
  const unknown = rows.filter((row) => !KNOWN_FOREIGN_MIGRATIONS.includes(row.name) && !HUB_MIGRATION_NAMES.has(row.name));
  if (unknown.length) {
    throw new Error(
      `schema_migrations has migrations this build does not know: ${unknown.map((row) => `v${row.version} ${row.name}`).join(", ")}. ` +
      "The database was migrated by a different branch; refusing to open it.",
    );
  }
  const names = rows.map((row) => row.name);
  const duplicated = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicated) throw new Error(`schema_migrations records ${duplicated} more than once at or above v${FIRST_DIVERGED_VERSION}`);
  if (!foreign.length && !moved.length) return report;

  db.transaction(() => {
    if (foreign.length) {
      db.exec("CREATE TABLE IF NOT EXISTS schema_migrations_foreign (version INTEGER, name TEXT, moved_at TEXT)");
      const archive = db.prepare("INSERT INTO schema_migrations_foreign (version, name, moved_at) VALUES (?, ?, datetime('now'))");
      const remove = db.prepare("DELETE FROM schema_migrations WHERE version = ?");
      for (const row of foreign) {
        archive.run(row.version, row.name);
        remove.run(row.version);
        report.foreign.push(row.name);
      }
    }
    // version 是主键，目标号可能正被另一行占着（latest 的 64 是 hub 的 66，hub 的 64 又在别人手里）。
    // 先全部挪到负数临时号，再改到目标号，中途不会撞。
    const park = db.prepare("UPDATE schema_migrations SET version = ? WHERE version = ?");
    for (const row of moved) park.run(-row.version, row.version);
    for (const row of moved) {
      const to = HUB_MIGRATION_NAMES.get(row.name)!;
      park.run(to, -row.version);
      report.renumbered.push({ name: row.name, from: row.version, to });
    }
  })();
  return report;
}
