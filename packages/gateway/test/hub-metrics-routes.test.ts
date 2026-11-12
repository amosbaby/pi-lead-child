// GET /v1/hub/metrics 和「找不到」的页面入口（计划 Task 14）。网关、store、操作层是真的。这里核对：
//   - 读指标要 tickets:view；since 只认 Nd、Nh，缺省 7d，别的写法回 400；窗口外的工单、「找不到」不算；
//   - 记「找不到」是通用的 POST /v1/actions/ticket_miss/hub/record：要 tickets:create，只读的设备记不了；
//     写一行、记账本（user）；空的、太长的回 400，什么也不写；记完以后指标里的次数加一。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { TICKET_MISS_TEXT_MAX, UI_ACTION_PERFORMED_KIND } from "@pi-lead-child/protocol";
import { addTicketSource, createItem, createLoopbackBinding, openDb, recordMiss, type Db } from "@pi-lead-child/store";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";

let db: Db;
const servers: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  db = openDb(join(tempDir("plc-hub-metrics-routes-"), "plc.db"));
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  db.close();
});

async function start() {
  const server = await startPairedServer({
    db,
    controlPlane: createControlPlaneService(db, {
      runtime: () => ({ model: "stub/model", sessionId: "stub-session", busy: false, runningItemIds: [], aish: null }),
      now: () => new Date(),
    }),
    hello: () => ({}),
    chat: () => "started",
    addClient: () => () => {},
    log: () => {},
  }, { port: 0 });
  servers.push(server);
  const owner = createLoopbackBinding(db, { name: "本机网页" });
  const reader = createLoopbackBinding(db, { name: "只读", scopes: ["tickets:view"] });
  const call = async (method: "GET" | "POST", path: string, body?: unknown, token = owner.accessToken) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { call, reader };
}

const ledger = () => db.prepare("SELECT payload FROM events WHERE kind=? ORDER BY seq").all(UI_ACTION_PERFORMED_KIND).map((row: any) => JSON.parse(row.payload));
const missRows = () => (db.prepare("SELECT COUNT(*) AS n FROM ticket_misses").get() as { n: number }).n;

describe("GET /v1/hub/metrics", () => {
  it("reads with tickets:view, defaults to 7 days, and counts only the window", async () => {
    const { call, reader } = await start();
    const recent = createItem(db, { title: "recent", brief: "b", createdBy: "lead" });
    addTicketSource(db, { itemId: recent, kind: "slack", conversation: "slack:C0TEAM:1" });
    createItem(db, { title: "no source", brief: "b", createdBy: "lead" });
    const old = createItem(db, { title: "old", brief: "b", createdBy: "lead" });
    db.prepare("UPDATE items SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 10 * 86_400_000).toISOString(), old);
    recordMiss(db, "in the window");
    recordMiss(db, "before the window", new Date(Date.now() - 10 * 86_400_000));

    const week = await call("GET", "/v1/hub/metrics", undefined, reader.accessToken);
    expect(week).toEqual({
      status: 200,
      body: {
        since: "7d",
        metrics: { tickets: 2, withSource: 1, withSession: 0, sourceCoverage: 0.5, sessionCoverage: 0, medianClaimMinutes: null, misses: 1 },
      },
    });
    const longer = await call("GET", "/v1/hub/metrics?since=30d");
    expect(longer.body).toMatchObject({ since: "30d", metrics: { tickets: 3, misses: 2 } });
    expect((await call("GET", "/v1/hub/metrics?since=12h")).body).toMatchObject({ since: "12h", metrics: { tickets: 2 } });
  });

  it("refuses a since that is not Nd or Nh", async () => {
    const { call } = await start();
    for (const since of ["7", "0d", "-1d", "7w", "d", "1.5d", "7d;", "99999d", "%20"]) {
      expect((await call("GET", `/v1/hub/metrics?since=${encodeURIComponent(since)}`)).status, since).toBe(400);
    }
  });
});

describe("POST /v1/actions/ticket_miss/hub/record", () => {
  it("records a miss as you with tickets:create; a view-only device cannot", async () => {
    const { call, reader } = await start();
    const path = "/v1/actions/ticket_miss/hub/record";
    expect((await call("POST", path, { input: { text: "the Jira ticket" } }, reader.accessToken)).status).toBe(403);
    expect(missRows()).toBe(0);

    expect((await call("POST", path, { input: { text: "  the Jira ticket  " } })).status).toBe(200);
    expect(db.prepare("SELECT text FROM ticket_misses").all()).toEqual([{ text: "the Jira ticket" }]);
    expect(ledger()).toEqual([expect.objectContaining({ target: { type: "ticket_miss", id: "hub" }, action: "record", actor: "user" })]);
    expect((await call("GET", "/v1/hub/metrics")).body.metrics.misses).toBe(1);
  });

  it("refuses an empty or over-long text with 400 and writes nothing", async () => {
    const { call } = await start();
    const path = "/v1/actions/ticket_miss/hub/record";
    for (const text of ["", "   ", "x".repeat(TICKET_MISS_TEXT_MAX + 1)]) {
      expect((await call("POST", path, { input: { text } })).status).toBe(400);
    }
    expect(missRows()).toBe(0);
    expect(ledger()).toEqual([]);
  });
});
