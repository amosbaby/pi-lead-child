// 外部工人的 HTTP MCP 入口 /v1/worker/mcp（.scratch/external-worker-hub/spec.md P1-5）。网关、store、操作层都是真的。核对：
//   - 认证顺序：Host 必须是回环 → 带 Origin 的一律拒绝 → 只认 Authorization: Bearer（?token= 有效也拒绝）→ 凭证活着、带 worker 权限；
//     拒绝回 401/403 和一小段 JSON，不回显 token；
//   - 只收 POST + application/json，GET 回 405，请求体有上限；
//   - JSON-RPC：initialize（回显协议版本）、notifications/initialized（202 无内容）、tools/list（8 个工具）、tools/call；
//     不认识的方法回 -32601，批量请求回 -32600，参数不合 schema 回 -32602；
//   - 操作层的拒绝是 MCP 的工具错误（isError: true，文字是拒绝原因），不是 HTTP 500。
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { WORKER_MCP_TOOL_NAMES } from "@pi-lead-child/protocol";
import {
  createItem, createLoopbackBinding, createWorkerBinding, getItem, listRuns, openDb, revokeBinding, type Db,
} from "@pi-lead-child/store";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";

let db: Db;
const servers: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  db = openDb(join(tempDir("plc-worker-mcp-"), "plc.db"));
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  db.close();
});

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; text: string; body: any }

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
  // fetch 不让改 Host，这里用 node:http 原样发请求头。
  const send = (options: {
    method?: string; path?: string; headers?: Record<string, string>; body?: string;
  }): Promise<Reply> => new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1", port: server.port, method: options.method ?? "POST", path: options.path ?? "/v1/worker/mcp",
      headers: options.headers ?? {},
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = null; }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body });
      });
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
  const rpc = (token: string, message: unknown, headers: Record<string, string> = {}) => send({
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(message),
  });
  let nextId = 1;
  const call = async (token: string, name: string, args: unknown = {}) => {
    const reply = await rpc(token, { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } });
    expect(reply.status).toBe(200);
    return reply.body;
  };
  return { port: server.port, send, rpc, call };
}

const ticket = (title = "fix the retry policy") =>
  createItem(db, { title, brief: "the retry policy drops the last attempt", createdBy: "user" });

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } };

describe("the worker MCP endpoint: who may call it", () => {
  it("rejects ?token= even when valid", async () => {
    const { send } = await start();
    const { accessToken } = createWorkerBinding(db, { name: "ethan-cc" });
    const reply = await send({
      path: `/v1/worker/mcp?token=${encodeURIComponent(accessToken)}`,
      headers: { "content-type": "application/json" }, body: JSON.stringify(initialize),
    });
    expect(reply.status).toBe(401);
    expect(reply.body.error.code).toBe("unauthorized");
    expect(reply.text).not.toContain(accessToken);

    // 同时带上有效的 Authorization 也不行：token 不能出现在 URL 里（会进日志）。
    const both = await send({
      path: `/v1/worker/mcp?token=${encodeURIComponent(accessToken)}`,
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify(initialize),
    });
    expect(both.status).toBe(401);
    expect(both.text).not.toContain(accessToken);
  });

  it("rejects browser origin even with a valid token", async () => {
    const { rpc } = await start();
    const { accessToken } = createWorkerBinding(db, { name: "ethan-cc" });
    for (const origin of ["https://evil.example.com", "http://127.0.0.1:47130", "null"]) {
      const reply = await rpc(accessToken, initialize, { origin });
      expect(reply.status, origin).toBe(403);
      expect(reply.body.error.code).toBe("forbidden");
      expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
      expect(reply.text).not.toContain(accessToken);
    }
  });

  it("rejects a non-loopback Host header", async () => {
    const { rpc } = await start();
    const { accessToken } = createWorkerBinding(db, { name: "ethan-cc" });
    for (const host of ["evil.example.com", "127.0.0.1.example.com", "localhost.example.com:47130", "10.0.0.2:47130"]) {
      const reply = await rpc(accessToken, initialize, { host });
      expect(reply.status, host).toBe(403);
      expect(reply.text).not.toContain(accessToken);
    }
    for (const host of ["127.0.0.1", "127.0.0.1:47130", "localhost:47130", "LOCALHOST", "[::1]:47130"]) {
      expect((await rpc(accessToken, initialize, { host })).status, host).toBe(200);
    }
  });

  it("rejects a binding without the worker scope", async () => {
    const { rpc, send } = await start();
    const owner = createLoopbackBinding(db, { name: "本机网页" });
    const reply = await rpc(owner.accessToken, initialize);
    expect(reply.status).toBe(403);
    expect(reply.body.error.code).toBe("forbidden");
    expect(reply.text).not.toContain(owner.accessToken);

    // 没有凭证、凭证不对、凭证被撤销：401。
    expect((await send({ headers: { "content-type": "application/json" }, body: JSON.stringify(initialize) })).status).toBe(401);
    expect((await rpc("not-a-token", initialize)).status).toBe(401);
    const { binding, accessToken } = createWorkerBinding(db, { name: "ethan-cc" });
    expect((await rpc(accessToken, initialize)).status).toBe(200);
    revokeBinding(db, binding.id);
    expect((await rpc(accessToken, initialize)).status).toBe(401);
  });
});

describe("the worker MCP endpoint: the transport", () => {
  it("takes only POST with a JSON body of bounded size", async () => {
    const { send, rpc } = await start();
    const { accessToken } = createWorkerBinding(db, { name: "ethan-cc" });
    const auth = { authorization: `Bearer ${accessToken}` };
    expect((await send({ method: "GET", headers: auth })).status).toBe(405);
    expect((await send({ method: "DELETE", headers: auth })).status).toBe(405);
    expect((await send({ headers: { ...auth, "content-type": "text/plain" }, body: JSON.stringify(initialize) })).status).toBe(415);
    const big = await send({
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ ...initialize, params: { pad: "x".repeat(1_100_000) } }),
    });
    expect(big.status).toBe(413);

    const parse = await send({ headers: { ...auth, "content-type": "application/json" }, body: "{not json" });
    expect(parse.status).toBe(400);
    expect(parse.body).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32700 } });

    const batch = await rpc(accessToken, [initialize]);
    expect(batch.body).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });

    const unknown = await rpc(accessToken, { jsonrpc: "2.0", id: 9, method: "resources/list" });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toMatchObject({ jsonrpc: "2.0", id: 9, error: { code: -32601 } });
  });

  it("initializes, echoing the protocol version, and accepts the initialized notification without a body", async () => {
    const { rpc } = await start();
    const { accessToken } = createWorkerBinding(db, { name: "ethan-cc" });
    const init = await rpc(accessToken, initialize);
    expect(init.status).toBe(200);
    expect(init.headers["content-type"]).toMatch(/^application\/json/);
    expect(init.body).toMatchObject({
      jsonrpc: "2.0", id: 1,
      result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: expect.any(String) } },
    });
    const fallback = await rpc(accessToken, { jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
    expect(fallback.body.result.protocolVersion).toBe("2025-06-18");

    const notified = await rpc(accessToken, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notified.status).toBe(202);
    expect(notified.text).toBe("");
  });
});

describe("the worker MCP endpoint: the tools", () => {
  it("lists tools and claims through JSON-RPC", async () => {
    const { rpc, call } = await start();
    const { binding, accessToken } = createWorkerBinding(db, { name: "ethan-cc" });
    const listed = await rpc(accessToken, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = listed.body.result.tools as Array<{ name: string; description: string; inputSchema: any }>;
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_tickets", "claim", "track", "get_ticket", "report", "attach_session", "complete", "hand_back",
    ]);
    expect(tools.map((tool) => tool.name)).toEqual([...WORKER_MCP_TOOL_NAMES]);
    for (const tool of tools) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      // 给模型看的文字：home 写成 ~，没有真实路径。
      expect(tool.description, tool.name).not.toMatch(/\/Users\/|\/home\//);
    }
    const describe = (name: string) => tools.find((tool) => tool.name === name)!.description;
    expect(describe("complete")).toMatch(/review/i);
    expect(describe("complete")).toMatch(/accept/i);
    expect(describe("hand_back")).toMatch(/reason/i);
    expect(tools.map((tool) => tool.description).join("\n")).toMatch(/external/i);
    expect(tools.find((tool) => tool.name === "list_tickets")!.inputSchema.properties.filter).toBeTruthy();

    const itemId = ticket();
    expect((await call(accessToken, "list_tickets", { filter: "claimable" })).result.structuredContent.tickets)
      .toEqual([expect.objectContaining({ ticketId: itemId, title: "fix the retry policy" })]);

    const claimed = await call(accessToken, "claim", { ticketId: itemId });
    expect(claimed.result.isError).toBe(false);
    expect(claimed.result.content).toEqual([{ type: "text", text: expect.any(String) }]);
    expect(JSON.parse(claimed.result.content[0].text)).toMatchObject({ ticketId: itemId, stage: "active" });
    expect(getItem(db, itemId)!.stage).toBe("active");
    const runs = listRuns(db, itemId);
    expect(runs).toHaveLength(1);
    expect(JSON.parse(runs[0]!.metadata)).toMatchObject({ bindingId: binding.id });

    expect((await call(accessToken, "list_tickets", { filter: "mine" })).result.structuredContent.tickets)
      .toEqual([expect.objectContaining({ ticketId: itemId, claimedBy: "ethan-cc" })]);
    expect((await call(accessToken, "attach_session", { ticketId: itemId, url: "https://claude.ai/code/session-1" })).result.isError).toBe(false);
    expect((await call(accessToken, "report", { ticketId: itemId, text: "found the off-by-one", usage: { inputTokens: 10, outputTokens: 5 } })).result.isError).toBe(false);
    const view = await call(accessToken, "get_ticket", { ticketId: itemId });
    expect(view.result.structuredContent).toMatchObject({ ticketId: itemId, reports: [expect.objectContaining({ text: "found the off-by-one" })] });
    const done = await call(accessToken, "complete", { ticketId: itemId, summary: "fixed", evidence: "npm test passes" });
    expect(done.result.isError).toBe(false);
    expect(getItem(db, itemId)!.stage).toBe("review");
  });

  it("tracks a ticket from the worker's own session and hands one back", async () => {
    const { call } = await start();
    const { accessToken } = createWorkerBinding(db, { name: "ethan-cc" });
    const tracked = await call(accessToken, "track", { title: "look into PROJ-123", sourceUrl: "https://acme.atlassian.net/browse/PROJ-123" });
    expect(tracked.result.isError).toBe(false);
    const { ticketId } = tracked.result.structuredContent;
    expect(getItem(db, ticketId)!.stage).toBe("active");
    const back = await call(accessToken, "hand_back", { ticketId, reason: "needs a product decision" });
    expect(back.result.isError).toBe(false);
    expect(getItem(db, ticketId)!.stage).toBe("blocked");
    expect((await call(accessToken, "list_tickets", { filter: "needs_me" })).result.structuredContent.tickets)
      .toEqual([expect.objectContaining({ ticketId })]);
  });

  it("maps an action refusal to an MCP tool error, not a 500", async () => {
    const { call } = await start();
    const ethan = createWorkerBinding(db, { name: "ethan-cc" });
    const nina = createWorkerBinding(db, { name: "nina-codex" });
    const itemId = ticket();
    expect((await call(ethan.accessToken, "claim", { ticketId: itemId })).result.isError).toBe(false);

    const refused = await call(nina.accessToken, "claim", { ticketId: itemId });
    expect(refused.error).toBeUndefined();
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content).toEqual([{ type: "text", text: expect.stringContaining("ethan-cc") }]);

    // 不是自己领的单：回写、读都被拒绝，也是工具错误。
    for (const [name, args] of [
      ["report", { ticketId: itemId, text: "x" }], ["complete", { ticketId: itemId, summary: "x", evidence: "y" }],
      ["get_ticket", { ticketId: itemId }],
    ] as const) {
      const reply = await call(nina.accessToken, name, args);
      expect(reply.result.isError, name).toBe(true);
    }
    // 没有这张单。
    const missing = await call(ethan.accessToken, "claim", { ticketId: 99_999 });
    expect(missing.result.isError).toBe(true);
    // 操作层的输入校验（会话链接只收 https、claude）。
    const badUrl = await call(ethan.accessToken, "attach_session", { ticketId: itemId, url: "javascript:alert(1)" });
    expect(badUrl.result.isError).toBe(true);
  });

  it("refuses arguments that do not match the tool's schema, and an unknown tool, as JSON-RPC errors", async () => {
    const { call } = await start();
    const { accessToken } = createWorkerBinding(db, { name: "ethan-cc" });
    const itemId = ticket();
    for (const [name, args] of [
      ["claim", {}], ["claim", { ticketId: "1" }], ["claim", { ticketId: itemId, extra: true }],
      ["list_tickets", { filter: "everything" }], ["report", { ticketId: itemId }],
    ] as const) {
      const reply = await call(accessToken, name, args);
      expect(reply.error?.code, `${name} ${JSON.stringify(args)}`).toBe(-32602);
    }
    expect((await call(accessToken, "release", { ticketId: itemId })).error.code).toBe(-32602);
    expect(getItem(db, itemId)!.stage).toBe("ready");
  });
});
