// 外部工人的凭证（scope 只有 worker）只开 /v1/worker/mcp（裁定 R30，最终审阅 I1）。别处一律 403：
//   - 事件 WebSocket（v1 和 v2，Authorization 头或 ?token=），否则 v1 会收到 daemon 的全部广播（Lead 的流、工具调用）；
//   - 不要求 scope 的路由（/v1/paired/me、/v1/paired/ws-ticket）；
//   - 本机网页的配对邀请（否则局域网监听时能拿它换一张缺省 scope 的配对）。
// 工人的 MCP 照常可用；普通的 Companion 凭证不受影响。
import { mkdirSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLoopbackBinding, createWorkerBinding, openDb, type Db } from "@pi-lead-child/store";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";

let db: Db;
let webRoot: string;
let broadcastClients: number;
const servers: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  const root = tempDir("plc-worker-confine-");
  db = openDb(join(root, "plc.db"));
  webRoot = join(root, "web");
  mkdirSync(webRoot, { recursive: true });
  writeFileSync(join(webRoot, "index.html"), "<html>companion</html>");
  broadcastClients = 0;
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  db.close();
});

function runtime() {
  return { model: "stub/model", sessionId: "stub-session", busy: false, runningItemIds: [], aish: null };
}

async function start() {
  const server = await startPairedServer({
    db,
    controlPlane: createControlPlaneService(db, { runtime }),
    hello: runtime,
    chat: () => "started",
    addClient: () => { broadcastClients += 1; return () => {}; },
    log: () => {},
  }, {
    port: 0, allowLoopbackAutoPair: true, webRoot,
    // 局域网监听时邀请才有地址：给一块假的 Wi-Fi 网卡。
    lanInterfaces: () => ({
      en0: [{ address: "192.168.1.20", family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: "192.168.1.20/24" }],
    }),
    host: "0.0.0.0",
  });
  servers.push(server);
  return { port: server.port, base: `http://127.0.0.1:${server.port}`, origin: `http://127.0.0.1:${server.port}` };
}

// 连上就回 "open"，被拒就回 HTTP 状态码。
function connect(url: string, headers: Record<string, string> = {}): Promise<number | "open"> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => { ws.close(); resolve("open"); });
    ws.once("unexpected-response", (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
    ws.once("error", (err) => { if (!String(err.message).includes("Unexpected server response")) reject(err); });
  });
}

function mcpInitialize(port: number, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1", port, method: "POST", path: "/v1/worker/mcp",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
    req.on("error", reject);
    req.end(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    }));
  });
}

describe("a worker token opens only the worker MCP endpoint", () => {
  it("is refused on the v1 and v2 event sockets and never joins the broadcast", async () => {
    const { port } = await start();
    const { accessToken } = createWorkerBinding(db, { name: "ethan-cc" });
    const events = `ws://127.0.0.1:${port}/v1/paired/events`;
    expect(await connect(events, { authorization: `Bearer ${accessToken}` })).toBe(403);
    expect(await connect(`${events}?token=${accessToken}`)).toBe(403);
    expect(await connect(`${events}?protocol=2`, { authorization: `Bearer ${accessToken}` })).toBe(403);
    expect(await connect(`${events}?token=${accessToken}&protocol=2`)).toBe(403);
    expect(broadcastClients).toBe(0);
  });

  it("is refused on routes that take any binding", async () => {
    const { base } = await start();
    const { accessToken } = createWorkerBinding(db, { name: "ethan-cc" });
    const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
    const me = await fetch(`${base}/v1/paired/me`, { headers });
    expect(me.status).toBe(403);
    const ticket = await fetch(`${base}/v1/paired/ws-ticket`, { method: "POST", headers, body: "{}" });
    expect(ticket.status).toBe(403);
    expect(await ticket.text()).not.toContain("ws_ticket");
  });

  it("cannot mint a phone pairing invitation, even from a loopback page origin", async () => {
    const { base, origin } = await start();
    const { accessToken } = createWorkerBinding(db, { name: "ethan-cc" });
    const response = await fetch(`${base}/v1/paired/loopback/invitations`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", origin },
      body: JSON.stringify({ name: "手机" }),
    });
    expect(response.status).toBe(403);
    expect(db.prepare("SELECT COUNT(*) AS n FROM pairings").get()).toEqual({ n: 0 });
  });

  it("still works on the worker MCP endpoint", async () => {
    const { port } = await start();
    const { accessToken } = createWorkerBinding(db, { name: "ethan-cc" });
    expect(await mcpInitialize(port, accessToken)).toBe(200);
  });

  it("leaves a normal Companion binding as it was", async () => {
    const { port, base } = await start();
    const { accessToken } = createLoopbackBinding(db, { name: "本机网页" });
    const headers = { authorization: `Bearer ${accessToken}` };
    expect((await fetch(`${base}/v1/paired/me`, { headers })).status).toBe(200);
    expect((await fetch(`${base}/v1/paired/ws-ticket`, { method: "POST", headers })).status).toBe(201);
    expect(await connect(`ws://127.0.0.1:${port}/v1/paired/events`, headers)).toBe("open");
    expect(await connect(`ws://127.0.0.1:${port}/v1/paired/events?protocol=2`, headers)).toBe("open");
    expect(broadcastClients).toBe(1);
  });
});
