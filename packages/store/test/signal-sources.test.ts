// 信号源存在 kv 里（用户 2026-11-12）：一个信号源一行 JSON，不开新表。
// 建、改、删、挑到点的、记一次运行的结果；连续出错到上限就暂停。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { SIGNAL_SOURCE_LIMITS, type SignalSourceInput } from "@pi-lead-child/protocol";
import {
  createSignalSource, deleteSignalSource, dueSignalSources, getSignalSource, listSignalSources, openDb,
  recordSignalSourceRun, updateSignalSource, type Db,
} from "../src/index.js";

let db: Db;
const NOW = new Date("2026-11-12T02:00:00.000Z");
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

const input = (name = "work-mail"): SignalSourceInput => ({
  name, label: "Work mail", fetch: [{ connection: "workspace", tool: "list_messages", arguments: { max: 20 } }],
  command: "node tidy.mjs",
});

beforeEach(() => {
  db = openDb(join(tempDir("plc-signal-sources-"), "plc.db"));
});

describe("signal sources in kv", () => {
  it("creates a source that is due at once, with the default interval and the ask-first policy", () => {
    const source = createSignalSource(db, input(), { by: "lead", now: NOW });
    expect(source).toMatchObject({
      name: "work-mail", enabled: true, actForUser: false, rules: [], createdBy: "lead",
      everySeconds: SIGNAL_SOURCE_LIMITS.defaultEverySeconds, lastRunAt: null, consecutiveErrors: 0,
    });
    expect(dueSignalSources(db, NOW).map((entry) => entry.name)).toEqual(["work-mail"]);
    expect(getSignalSource(db, "work-mail")).toEqual(source);
  });

  it("refuses a second source with the same name and keeps the first", () => {
    createSignalSource(db, input(), { by: "lead", now: NOW });
    expect(createSignalSource(db, { ...input(), label: "Other" }, { by: "user", now: NOW })).toBeNull();
    expect(getSignalSource(db, "work-mail")?.label).toBe("Work mail");
  });

  it("lists sources by name and skips a row that is not a valid source", () => {
    createSignalSource(db, input("b-calendar"), { by: "lead", now: NOW });
    createSignalSource(db, input("a-mail"), { by: "lead", now: NOW });
    db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))").run("signal-source:broken", "{not json");
    expect(listSignalSources(db).map((entry) => entry.name)).toEqual(["a-mail", "b-calendar"]);
    expect(getSignalSource(db, "broken")).toBeNull();
  });

  it("schedules the next run one interval after a run and counts the events", () => {
    createSignalSource(db, { ...input(), everySeconds: 120 }, { by: "lead", now: NOW });
    const recorded = recordSignalSourceRun(db, "work-mail", { ok: true, emitted: 3 }, NOW);
    expect(recorded).toMatchObject({ paused: false, source: { lastStatus: "ok", emitted: 3, nextRunAt: later(120).toISOString() } });
    expect(dueSignalSources(db, later(119))).toEqual([]);
    expect(dueSignalSources(db, later(120))).toHaveLength(1);
  });

  it("pauses after the limit of consecutive errors, and a success in between resets the count", () => {
    createSignalSource(db, input(), { by: "lead", now: NOW });
    for (let run = 1; run < SIGNAL_SOURCE_LIMITS.maxConsecutiveErrors; run++) {
      expect(recordSignalSourceRun(db, "work-mail", { ok: false, error: "boom" }, NOW)?.paused).toBe(false);
    }
    recordSignalSourceRun(db, "work-mail", { ok: true, emitted: 0 }, NOW);
    for (let run = 1; run < SIGNAL_SOURCE_LIMITS.maxConsecutiveErrors; run++) {
      expect(recordSignalSourceRun(db, "work-mail", { ok: false, error: "boom" }, NOW)?.paused).toBe(false);
    }
    const last = recordSignalSourceRun(db, "work-mail", { ok: false, error: "boom again" }, NOW);
    expect(last).toMatchObject({ paused: true, source: { enabled: false, lastStatus: "error", lastError: "boom again" } });
    expect(dueSignalSources(db, later(86_400))).toEqual([]);
  });

  it("clears the error count on resume, and keeps the rules and the policy the user gave", () => {
    createSignalSource(db, input(), { by: "lead", now: NOW });
    for (let run = 0; run < SIGNAL_SOURCE_LIMITS.maxConsecutiveErrors; run++) {
      recordSignalSourceRun(db, "work-mail", { ok: false, error: "boom" }, NOW);
    }
    updateSignalSource(db, "work-mail", { rules: [{ text: "mail from my manager", level: "now" }], policy: "You may accept invites.", actForUser: true });
    const resumed = updateSignalSource(db, "work-mail", { enabled: true });
    expect(resumed).toMatchObject({
      enabled: true, consecutiveErrors: 0, actForUser: true, policy: "You may accept invites.",
      rules: [{ text: "mail from my manager", level: "now" }],
    });
  });

  it("deletes a source, and reports nothing to change for a missing one", () => {
    createSignalSource(db, input(), { by: "lead", now: NOW });
    expect(deleteSignalSource(db, "work-mail")).toBe(true);
    expect(deleteSignalSource(db, "work-mail")).toBe(false);
    expect(updateSignalSource(db, "work-mail", { enabled: false })).toBeNull();
    expect(recordSignalSourceRun(db, "work-mail", { ok: true, emitted: 0 }, NOW)).toBeNull();
  });
});
