// Lead 自己装 MCP（2026-11-02，.scratch/lead-self-install/spec.md D2、D3）在连接中心里的部分：
//   - requestCustom：要授权的远程 MCP 先建行、列出来、能撤回；不要授权的直接连上；地址里的密钥不收。
//   - addLocal：真的起一个 stdio 进程（testing/fake-stdio-mcp.mjs），读工具、调用、断开后进程停掉；环境里没有 daemon 的密钥。
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import type { LocalMcpLaunch } from "@pi-lead-child/protocol";
import { connectionRequestPending, getConnection, getConnectionByServer, listConnectionEvents, openDb, type Db } from "@pi-lead-child/store";
import { ConnectionError, ConnectionHub, type ConnectionHubOptions } from "../src/hub.js";
import { localMcpEnv, localServerUrl } from "../src/mcp-stdio.js";
import { Vault } from "../src/vault.js";
import { FakeVendor } from "../testing/fake-vendor.js";
import { FAKE_STDIO_MCP } from "../testing/fake-stdio-mcp-path.js";

const REDIRECT = "http://127.0.0.1:47130/oauth/callback";
const FIXTURE = FAKE_STDIO_MCP;

let clock: number;
let db: Db;
let dir: string;
let vendor: FakeVendor;
const hubs: ConnectionHub[] = [];

beforeEach(() => {
  clock = Date.parse("2026-11-02T08:00:00.000Z");
  dir = tempDir("plc-installs-");
  db = openDb(join(dir, "plc.db"));
  vendor = new FakeVendor(() => clock);
});

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((h) => h.close()));
  delete process.env.PLC_FAKE_SECRET;
});

function hub(overrides: Partial<ConnectionHubOptions> = {}): ConnectionHub {
  const h = new ConnectionHub({
    db, vault: new Vault(randomBytes(32)), config: { clients: {} }, redirectUri: () => REDIRECT,
    fetch: vendor.fetch, now: () => clock, gh: { token: async () => null }, ghInstalled: () => false,
    localMcpDir: join(dir, "mcp"),
    // 不经过 npx：直接用 node 跑假的服务器，launch 的 args 原样传过去。
    localCommand: (launch) => ({ executable: process.execPath, args: [FIXTURE, ...launch.args] }),
    ...overrides,
  });
  hubs.push(h);
  return h;
}

const launch = (args: string[] = []): LocalMcpLaunch => ({ registry: "npm", package: "@acme/fake-mcp", version: "1.2.3", bin: "fake-mcp", args });

describe("requestCustom: a remote MCP that needs authorization", () => {
  it("creates a pending row that the list and the authorize card can find, and finishing the browser step connects it", async () => {
    const h = hub();
    const outcome = await h.requestCustom(vendor.mcpUrl, { actor: "lead", reason: "the user asked for it" });
    expect(outcome).toMatchObject({ state: "needs_authorization", existing: false, toolCount: null });
    const key = outcome.connection.key;
    expect(key).toMatch(/^custom-\d+$/);
    const row = getConnectionByServer(db, vendor.mcpUrl)!;
    expect(row.status).toBe("disconnected");
    expect(connectionRequestPending(db, row.id)).toBe(true);
    expect(listConnectionEvents(db, row.id).map((event) => event.kind)).toContain("requested");
    // 设置页和授权卡（按 key 找）看得到它，状态是未连接。
    expect(h.list().find((item) => item.key === key)).toMatchObject({ state: "not_connected", serverUrl: vendor.mcpUrl });

    // 用户在卡上点连接：和设置页一样的 start，浏览器授权完成以后连上，同一行。
    const started = await h.start(key);
    if (started.flow !== "browser") throw new Error("expected a browser flow");
    const callback = vendor.approve(started.authorizeUrl);
    await h.completeCallback({ ...callback, error: null, errorDescription: null });
    expect(getConnection(db, row.id)!.status).toBe("connected");
    expect(connectionRequestPending(db, row.id)).toBe(false);
    expect(h.get(key)).toMatchObject({ state: "connected", tools: { total: 3 } });
  });

  it("withdraws a pending request on disconnect, and the list no longer shows it", async () => {
    const h = hub();
    const { connection } = await h.requestCustom(vendor.mcpUrl, { actor: "lead", reason: "try it" });
    await h.disconnect(connection.key);
    const row = getConnectionByServer(db, vendor.mcpUrl)!;
    expect(connectionRequestPending(db, row.id)).toBe(false);
    expect(listConnectionEvents(db, row.id)[0]!.kind).toBe("removed");
    expect(h.list().some((item) => item.key === connection.key)).toBe(false);
  });

  it("reports an existing live connection instead of adding it again", async () => {
    const h = hub();
    const first = await h.requestCustom(vendor.mcpUrl, { actor: "user", reason: "settings" });
    const started = await h.start(first.connection.key);
    if (started.flow !== "browser") throw new Error("expected a browser flow");
    await h.completeCallback({ ...vendor.approve(started.authorizeUrl), error: null, errorDescription: null });
    const again = await h.requestCustom(vendor.mcpUrl, { actor: "lead", reason: "again" });
    expect(again).toMatchObject({ state: "connected", existing: true, toolCount: 3, connection: { key: first.connection.key } });
  });

  it("refuses an address that carries a key or token", async () => {
    const h = hub();
    await expect(h.requestCustom(`${vendor.mcpUrl}?api_key=abc123`, { actor: "lead", reason: "x" }))
      .rejects.toMatchObject({ code: "invalid_request" });
    await expect(h.requestCustom(`${vendor.mcpUrl}?q=ghp_${"a".repeat(36)}`, { actor: "lead", reason: "x" }))
      .rejects.toBeInstanceOf(ConnectionError);
    expect(getConnectionByServer(db, vendor.mcpUrl)).toBeNull();
  });

  it("refuses an address that is not https", async () => {
    await expect(hub().requestCustom("http://mcp.fake.test/mcp", { actor: "lead", reason: "x" })).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("addLocal: a local stdio MCP", () => {
  it("starts the process, reads its tools, calls one, and stops the process on disconnect", async () => {
    const h = hub();
    const added = await h.addLocal(launch(), { actor: "lead", reason: "the user asked for it" });
    expect(added.toolCount).toBe(2);
    const row = getConnectionByServer(db, localServerUrl(launch()))!;
    expect(row).toMatchObject({ status: "connected", provider: "custom" });
    expect(JSON.parse(row.launch_json!)).toEqual(launch());
    const key = added.connection.key;
    // 设置页给人看的是命令，不是内部的唯一键。
    expect(h.get(key).serverUrl).toBe("npx -y --package=@acme/fake-mcp@1.2.3 -- fake-mcp");

    const echo = await h.callTool(key, "echo", { text: "hello" }, { role: "lead" });
    expect(echo).toMatchObject({ text: "hello", isError: false });
    const env = JSON.parse((await h.callTool(key, "env", {}, { role: "lead" })).text) as { pid: number; cwd: string };
    expect(env.cwd).toBe(realpathSync(join(dir, "mcp", String(row.id))));
    expect(processAlive(env.pid)).toBe(true);

    await h.disconnect(key);
    expect(getConnection(db, row.id)!.status).toBe("disconnected");
    await vi.waitFor(() => expect(processAlive(env.pid)).toBe(false), { timeout: 5_000 });
    // 自定义的连接断开以后不再列出。
    expect(h.list().some((item) => item.key === key)).toBe(false);
  });

  it("gives the process an allowlisted environment without the daemon's secrets", async () => {
    process.env.PLC_FAKE_SECRET = "s3cr3t-value";
    const h = hub();
    const { connection } = await h.addLocal(launch(), { actor: "lead", reason: "x" });
    const env = JSON.parse((await h.callTool(connection.key, "env", {}, { role: "lead" })).text) as Record<string, unknown>;
    expect(env.hasSecret).toBe(false);
    expect(env.ignoreScripts).toBe("true");
    const built = localMcpEnv("/usr/local/bin/npx", { PATH: "/usr/bin", HOME: "/Users/alice", PLC_FAKE_SECRET: "x", OPENAI_API_KEY: "y" });
    expect(Object.keys(built).sort()).toEqual(["HOME", "NO_UPDATE_NOTIFIER", "PATH", "UV_NO_PROGRESS", "npm_config_audit", "npm_config_fund", "npm_config_ignore_scripts"]);
  });

  it("restarts the process after it was stopped for being idle", async () => {
    const h = hub({ localIdleMs: 50 });
    const { connection } = await h.addLocal(launch(), { actor: "lead", reason: "x" });
    const first = JSON.parse((await h.callTool(connection.key, "env", {}, { role: "lead" })).text) as { pid: number };
    await vi.waitFor(() => expect(processAlive(first.pid)).toBe(false), { timeout: 5_000 });
    const second = JSON.parse((await h.callTool(connection.key, "env", {}, { role: "lead" })).text) as { pid: number };
    expect(second.pid).not.toBe(first.pid);
  });

  it("leaves no row when the server does not start, and says why", async () => {
    const h = hub();
    const failing = launch(["--crash"]);
    await expect(h.addLocal(failing, { actor: "lead", reason: "x" })).rejects.toMatchObject({ code: "temporarily_unavailable" });
    await expect(h.addLocal(failing, { actor: "lead", reason: "x" })).rejects.toThrow(/missing configuration/);
    expect(getConnectionByServer(db, localServerUrl(failing))).toBeNull();
  });

  it("leaves no row when the server has no tools", async () => {
    const h = hub();
    const empty = launch(["--no-tools"]);
    await expect(h.addLocal(empty, { actor: "lead", reason: "x" })).rejects.toMatchObject({ code: "invalid_request" });
    expect(getConnectionByServer(db, localServerUrl(empty))).toBeNull();
    expect(existsSync(join(dir, "mcp"))).toBe(true);
  });

  it("keys a local server by package, version, bin and arguments", () => {
    expect(localServerUrl(launch())).toMatch(/^stdio:npm:@acme\/fake-mcp@1\.2\.3#[0-9a-f]{10}$/);
    expect(localServerUrl({ ...launch(), bin: "@acme/fake-mcp" })).toBe("stdio:npm:@acme/fake-mcp@1.2.3");
    expect(localServerUrl(launch(["--a"]))).not.toBe(localServerUrl(launch(["--b"])));
  });
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
