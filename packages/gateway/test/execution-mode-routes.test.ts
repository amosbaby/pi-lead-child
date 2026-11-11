// /v1/execution-mode 的路由（执行模式，spec P1-1）。网关、store、操作层是真的。这里核对：
//   - 读：tickets:view；切换：tickets:create，只读的设备切不了；
//   - 请求体是 { mode }，不认识的模式回 400，什么也不写；
//   - 切换以你本人的名义记一条 ui_action.performed，回的是新的模式。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { UI_ACTION_PERFORMED_KIND } from "@pi-lead-child/protocol";
import { createLoopbackBinding, openDb, type Db } from "@pi-lead-child/store";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";

let db: Db;
const servers: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  db = openDb(join(tempDir("plc-execution-mode-routes-"), "plc.db"));
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
  const call = async (method: "GET" | "POST", body?: unknown, token = owner.accessToken) => {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/execution-mode`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { call, reader };
}

function ledger() {
  return db.prepare("SELECT payload FROM events WHERE kind=? ORDER BY seq").all(UI_ACTION_PERFORMED_KIND).map((row: any) => JSON.parse(row.payload));
}

describe("the execution-mode routes", () => {
  it("reads with tickets:view, and switches with tickets:create as you", async () => {
    const { call, reader } = await start();
    expect(await call("GET", undefined, reader.accessToken)).toEqual({ status: 200, body: { executionMode: { mode: "self" } } });
    expect((await call("POST", { mode: "external" }, reader.accessToken)).status).toBe(403);

    expect(await call("POST", { mode: "external" })).toEqual({ status: 200, body: { executionMode: { mode: "external" } } });
    expect((await call("GET")).body.executionMode.mode).toBe("external");
    expect(await call("POST", { mode: "paused" })).toEqual({ status: 200, body: { executionMode: { mode: "paused" } } });
    expect(ledger()).toEqual([
      expect.objectContaining({ target: { type: "execution_mode", id: "daemon" }, action: "set", actor: "user" }),
      expect.objectContaining({ target: { type: "execution_mode", id: "daemon" }, action: "set", actor: "user" }),
    ]);
  });

  it("refuses a body that is not a known mode, and writes nothing", async () => {
    const { call } = await start();
    for (const body of [{ mode: "fast" }, {}, { mode: "external", extra: 1 }, null, "external"]) {
      expect((await call("POST", body)).status).toBe(400);
    }
    expect((await call("GET")).body.executionMode.mode).toBe("self");
    expect(ledger()).toEqual([]);
  });
});
