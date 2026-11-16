// What the guards on Lead's automatic model calls keep across a daemon restart (lead-call-guards.ts, 2026-11-16):
// one kv row for each guard, read back by the next daemon process.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, readLeadCallGuard, writeLeadCallGuard } from "../src/index.js";

describe("the saved state of Lead's call guards", () => {
  it("reads back what was written, for each guard on its own, after the database is opened again", () => {
    const path = join(tempDir("plc-call-guards-"), "plc.db");
    const db = openDb(path);
    expect(readLeadCallGuard(db, "model_hold")).toBeNull();
    expect(readLeadCallGuard(db, "auto_budget")).toBeNull();
    const hold = { version: 1, at: 5, state: { kind: "breaker", since: 1, source: "turn", error: "503", retryAt: 300_000 }, failures: 3, reopens: 0, lastError: "503" };
    writeLeadCallGuard(db, "model_hold", hold);
    writeLeadCallGuard(db, "auto_budget", [[1, 1_000], [2, 0]]);
    writeLeadCallGuard(db, "auto_budget", [[1, 1_000], [2, 0], [3, 250_000]]);
    db.close();

    const again = openDb(path);
    expect(readLeadCallGuard(again, "model_hold")).toEqual(hold);
    expect(readLeadCallGuard(again, "auto_budget")).toEqual([[1, 1_000], [2, 0], [3, 250_000]]);
    expect((again.prepare("SELECT count(*) AS n FROM kv WHERE key IN ('lead.model_hold', 'lead.auto_budget')").get() as { n: number }).n).toBe(2);
    again.close();
  });

  it("reads a row that does not hold JSON as nothing", () => {
    const db = openDb(join(tempDir("plc-call-guards-bad-"), "plc.db"));
    db.prepare("INSERT INTO kv (key, value) VALUES ('lead.model_hold', '{not json')").run();
    expect(readLeadCallGuard(db, "model_hold")).toBeNull();
    writeLeadCallGuard(db, "model_hold", null);
    expect(readLeadCallGuard(db, "model_hold")).toBeNull();
    db.close();
  });
});
