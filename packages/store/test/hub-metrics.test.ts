// 外部工人 hub 的指标（计划 Task 14）：来源链接覆盖率、会话链接覆盖率、领取中位时长、「没找到」次数。
// 口径：只数窗口内建的根工单（kind=task、没有 parent）；来源看这张单自己的 ticket_sources；会话看这张单自己的外部 Run
// （runtime=external）的 metadata.sessions，有 url 或 sessionId 才算；领取时长是第一次外部 Run 的 started_at 减去工单的 created_at。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { addTicketSource, createItem, hubMetrics, missesSince, openDb, recordMiss, type Db } from "../src/index.js";

const SINCE = new Date("2026-11-05T00:00:00.000Z");

function db(): Db {
  return openDb(join(tempDir("plc-hub-metrics-"), "plc.db"));
}

// 工单的创建时间要定下来：items.created_at 是 SQLite 的 UTC 格式（YYYY-MM-DD HH:MM:SS）。
function ticket(d: Db, createdAt: string, extra: { parentItemId?: number; kind?: "task" | "reminder" } = {}): number {
  const id = extra.kind === "reminder"
    ? createItem(d, { title: "r", brief: "b", createdBy: "user", kind: "reminder", remindAt: "2026-12-01T00:00:00.000Z" })
    : createItem(d, { title: "t", brief: "b", createdBy: "lead", ...(extra.parentItemId ? { parentItemId: extra.parentItemId } : {}) });
  d.prepare("UPDATE items SET created_at = ? WHERE id = ?").run(createdAt, id);
  return id;
}

function externalRun(d: Db, itemId: number, startedAt: string, sessions: Array<{ url: string | null; sessionId: string | null }>, runtime = "external"): number {
  const metadata = { bindingId: 1, claimMode: "manual", sessions: sessions.map((s) => ({ ...s, attachedAt: startedAt })) };
  return Number(d.prepare(
    "INSERT INTO runs (item_id, runtime, state, metadata, started_at) VALUES (?, ?, 'running', ?, ?)",
  ).run(itemId, runtime, JSON.stringify(metadata), startedAt).lastInsertRowid);
}

describe("hubMetrics", () => {
  it("10 tickets, 9 with a source, 8 with a session: coverage 0.9 and 0.8, median claim time, misses", () => {
    const d = db();
    const ids = Array.from({ length: 10 }, (_, i) => ticket(d, `2026-11-06 0${i}:00:00`));
    ids.slice(0, 9).forEach((id) => addTicketSource(d, { itemId: id, kind: "slack", conversation: "slack:C0TEAM:1", messageTs: `1.${id}` }));
    // 8 张有会话：url 的、只有 sessionId 的都算。第 9、10 张领了但没挂会话链接。
    ids.slice(0, 5).forEach((id, i) => externalRun(d, id, `2026-11-06 0${i}:10:00`, [{ url: "https://claude.ai/code/session_abc", sessionId: null }]));
    ids.slice(5, 8).forEach((id, i) => externalRun(d, id, `2026-11-06 0${i + 5}:30:00`, [{ url: null, sessionId: "sess-1" }]));
    externalRun(d, ids[8]!, "2026-11-06 08:20:00", []);
    recordMiss(d, "the Jira ticket from Nina", new Date("2026-11-06T12:00:00.000Z"));
    recordMiss(d, "the report ticket", new Date("2026-11-07T12:00:00.000Z"));
    recordMiss(d, "before the window", new Date("2026-11-01T12:00:00.000Z"));

    const metrics = hubMetrics(d, SINCE);
    expect(metrics.tickets).toBe(10);
    expect(metrics.withSource).toBe(9);
    expect(metrics.withSession).toBe(8);
    expect(metrics.sourceCoverage).toBeCloseTo(0.9);
    expect(metrics.sessionCoverage).toBeCloseTo(0.8);
    // 领取时长（分钟）：前 5 张 10、第 6–8 张 30、第 9 张 20；第 10 张没领。中位数在 9 个值里：10×5、20、30×3 → 第 5 个是 10。
    expect(metrics.medianClaimMinutes).toBe(10);
    expect(metrics.misses).toBe(2);
    expect(metrics.misses).toBe(missesSince(d, SINCE));
    d.close();
  });

  it("takes the mean of the two middle values for an even count and keeps fractions of a minute", () => {
    const d = db();
    const a = ticket(d, "2026-11-06 00:00:00");
    const b = ticket(d, "2026-11-06 00:00:00");
    externalRun(d, a, "2026-11-06 00:05:00", []);
    externalRun(d, b, "2026-11-06 00:10:30", []);
    expect(hubMetrics(d, SINCE).medianClaimMinutes).toBe(7.75);
    d.close();
  });

  it("measures from the first external Run only, and ignores Runs of other runtimes", () => {
    const d = db();
    const id = ticket(d, "2026-11-06 00:00:00");
    externalRun(d, id, "2026-11-06 00:03:00", [], "pi");
    externalRun(d, id, "2026-11-06 01:00:00", [{ url: "https://claude.ai/code/s", sessionId: null }]);
    externalRun(d, id, "2026-11-06 02:00:00", []);
    const metrics = hubMetrics(d, SINCE);
    expect(metrics.medianClaimMinutes).toBe(60);
    expect(metrics.withSession).toBe(1);
    d.close();
  });

  it("does not count a session link on a Run of another runtime, an empty session, or a malformed metadata", () => {
    const d = db();
    const internal = ticket(d, "2026-11-06 00:00:00");
    externalRun(d, internal, "2026-11-06 00:03:00", [{ url: "https://claude.ai/code/s", sessionId: "x" }], "pi");
    const empty = ticket(d, "2026-11-06 00:00:00");
    externalRun(d, empty, "2026-11-06 00:03:00", [{ url: null, sessionId: null }, { url: "", sessionId: "" }]);
    const broken = ticket(d, "2026-11-06 00:00:00");
    d.prepare("INSERT INTO runs (item_id, runtime, state, metadata, started_at) VALUES (?, 'external', 'running', ?, ?)")
      .run(broken, "{not json", "2026-11-06 00:05:00");
    const metrics = hubMetrics(d, SINCE);
    expect(metrics.tickets).toBe(3);
    expect(metrics.withSession).toBe(0);
    expect(metrics.medianClaimMinutes).toBe(4);
    d.close();
  });

  it("counts only root tasks: reminders, child tickets and tickets before the window are out", () => {
    const d = db();
    const root = ticket(d, "2026-11-06 00:00:00");
    addTicketSource(d, { itemId: root, kind: "jira", externalKey: "PROJ-123" });
    const child = ticket(d, "2026-11-06 00:01:00", { parentItemId: root });
    addTicketSource(d, { itemId: child, kind: "jira", externalKey: "PROJ-124" });
    externalRun(d, child, "2026-11-06 00:02:00", [{ url: "https://claude.ai/code/s", sessionId: null }]);
    ticket(d, "2026-11-06 00:00:00", { kind: "reminder" });
    const old = ticket(d, "2026-11-04 23:59:59");
    addTicketSource(d, { itemId: old, kind: "slack", conversation: "slack:C0TEAM:2" });
    const metrics = hubMetrics(d, SINCE);
    expect(metrics).toMatchObject({ tickets: 1, withSource: 1, withSession: 0, medianClaimMinutes: null });
    d.close();
  });

  it("includes a ticket created exactly at the start of the window", () => {
    const d = db();
    ticket(d, "2026-11-05 00:00:00");
    expect(hubMetrics(d, SINCE).tickets).toBe(1);
    d.close();
  });

  it("reads items created with an ISO timestamp as well as the SQLite format", () => {
    const d = db();
    ticket(d, "2026-11-06T03:00:00.000Z");
    expect(hubMetrics(d, SINCE).tickets).toBe(1);
    d.close();
  });

  it("returns zero coverage and a null median when nothing is in the window", () => {
    const d = db();
    expect(hubMetrics(d, SINCE)).toEqual({
      tickets: 0, withSource: 0, withSession: 0, sourceCoverage: 0, sessionCoverage: 0, medianClaimMinutes: null, misses: 0,
    });
    d.close();
  });

  it("never reports a negative claim time", () => {
    const d = db();
    const id = ticket(d, "2026-11-06 00:10:00");
    externalRun(d, id, "2026-11-06 00:09:00", []);
    expect(hubMetrics(d, SINCE).medianClaimMinutes).toBe(0);
    d.close();
  });
});
