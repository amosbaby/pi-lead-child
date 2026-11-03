// Lead 自己装 MCP 和 skill，走完用户经过的每一跳（用户 2026-11-02，.scratch/lead-self-install/spec.md）：
//   - 远程 MCP：Lead 用 perform_action 加 → 结果里有授权卡，系统登记等待 → 用户在卡上点连接（/v1/connections/<key>/start，
//     浏览器回到 /oauth/callback）→ 等待了结，Lead 用得上它的工具 → 「Lead 动态」里一张卡带「撤销」→ 用户点了，连接没了，按钮没了。
//   - 本地 MCP：Lead 加 → 审查（假的 npm）→ 确认卡 → 用户点「确认这一次」（/v1/actions/rule_change/<编号>/resolve）→
//     真的起一个 stdio 进程，Lead 调得到它的工具 → 「撤销」以后进程停掉。
//   - skill：Lead 装（假的 GitHub）→ find_skill 马上找得到 → 「撤销」以后找不到。
// daemon、网关、连接中心、操作层和 Lead 的工具是真的；Lead 的会话、厂商和仓库是替身。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { LEAD_INSTALL_CHANGED_KIND, LEAD_WAIT_SATISFIED_KIND, LeadActivityViewSchema } from "@pi-lead-child/protocol";
import { FakeVendor, FAKE_STDIO_MCP } from "@pi-lead-child/connections/testing";
import { fakeFetch, githubRepo, npmPackage, SKILL_MD } from "@pi-lead-child/engine/testing";
import { createLoopbackBinding, listEvents, openDb, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadToolset, installedSkillInfos, type LeadDeps } from "@pi-lead-child/lead";
import { startDaemon } from "../src/server.js";
import { leadEventRoute } from "../src/lead-input.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-lead-installs-daemon-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
  vi.stubEnv("PLC_LEAD_ACTIVITY_SYNC_MS", "20");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

// Lead 的会话是替身，工具是真的（session.ts 注册的同一组，外面包着自动登记等待）。find_skill 读的用户 skill 和 session.ts 一样，
// 加上 PLC 自己的 skill 目录（现扫）。
function leadSessionFactory(capture: { tools: ReturnType<typeof createLeadToolset> }) {
  return async (args: LeadDeps & { installedSkillsDir?: string }) => {
    capture.tools = createLeadToolset({ ...args, userSkills: () => (args.installedSkillsDir ? installedSkillInfos(args.installedSkillsDir) : []) });
    return {
      modelName: "stub/lead",
      session: {
        sessionId: "lead-installs", subscribe: () => () => {},
        prompt: async () => {}, steer: async () => {}, followUp: async () => {}, dispose: () => {},
      },
    };
  };
}

async function boot() {
  const vendor = new FakeVendor(() => Date.now());
  const capture = { tools: [] as ReturnType<typeof createLeadToolset> };
  const registry = fakeFetch({ ...npmPackage(), ...githubRepo("acme/skills", "main", { "SKILL.md": SKILL_MD, "references/formats.md": "# Formats\n" }) });
  daemon = await startDaemon({
    dataDir: dir, dbPath, sessionFactory: leadSessionFactory(capture) as never, gatewayPort: 0, log: () => {},
    connections: { fetch: vendor.fetch, tickMs: 3_600_000 },
    installs: { fetch: registry, localCommand: (launch) => ({ executable: process.execPath, args: [FAKE_STDIO_MCP, ...launch.args] }) },
  });
  const owner = createLoopbackBinding(db, { name: "test-web" });
  const base = `http://127.0.0.1:${daemon.pairedPort}`;
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${owner.accessToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const run = async (name: string, params: unknown): Promise<any> => {
    const tool = capture.tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.execute("t", params as never, undefined, undefined, undefined as never);
  };
  const perform = (target_type: string, target_id: string, action: string, input: unknown, reason: string) =>
    run("perform_action", { target_type, target_id, action, input, reason });
  const card = async (entityKey: string) => {
    const activity = await call("GET", "/v1/lead/activity?include=events");
    expect(Value.Check(LeadActivityViewSchema, activity.body)).toBe(true);
    return activity.body.cards.find((candidate: any) => candidate.entityKey === entityKey);
  };
  return { vendor, base, call, run, perform, card, registry };
}

describe("Lead installs a remote MCP through the daemon", () => {
  it("adds it, sends the authorize card, wakes up after the user authorizes, uses its tools, and the user can undo it", async () => {
    const { vendor, base, call, run, perform, card } = await boot();
    const added = await perform("connections", "connections", "add_remote", { url: vendor.mcpUrl }, "用户要接这个 MCP");
    const view = JSON.parse(added.content[0].text);
    expect(view.result).toMatchObject({ result: "needs_authorization", connection: { key: "custom-1", state: "not_connected" } });
    // 系统按 details.userAction 登记了等待（用户授权完叫醒 Lead）。
    expect(added.details.userAction).toEqual(view.result.user_action);
    expect(added.content.at(-1).text).toMatch(/等待/);
    // 设置页和授权卡按 key 找得到它。
    expect((await call("GET", "/v1/connections")).body.items.find((item: any) => item.key === "custom-1")).toMatchObject({ state: "not_connected" });

    // 用户在授权卡上点连接：和设置页同一个流程，浏览器回到网关。
    const started = await call("POST", "/v1/connections/custom-1/start", {});
    expect(started.body.flow).toBe("browser");
    const page = await fetch(`${base}/oauth/callback?${new URLSearchParams(vendor.approve(started.body.authorizeUrl))}`);
    expect(page.status).toBe(200);
    await vi.waitFor(() => expect(listEvents(db, { kind: LEAD_WAIT_SATISFIED_KIND, limit: 10 }).map((event) => event.entityKey)).toContain("connection:custom-1"));
    const tools = await run("search_connection_tools", { connection: "custom-1" });
    expect(tools.content[0].text).toContain("custom-1");

    // Lead 动态：Lead 加的，带「撤销」。
    const undo = { target: { type: "connection", id: "custom-1" }, action: "disconnect", label: "撤销" };
    await vi.waitFor(async () => expect((await card("connection:custom-1"))?.action).toEqual(undo));
    expect((await card("connection:custom-1")).summary).toMatch(/^Paimon added the remote MCP .*It waits for you to authorize/);
    const removed = await call("POST", "/v1/actions/connection/custom-1/disconnect", { input: {} });
    expect(removed.status).toBe(200);
    expect((await call("GET", "/v1/connections")).body.items.some((item: any) => item.key === "custom-1")).toBe(false);
    await vi.waitFor(async () => expect((await card("connection:custom-1"))?.action).toBeUndefined());
    const [own, userUndo] = listEvents(db, { kind: LEAD_INSTALL_CHANGED_KIND, limit: 10 });
    expect(leadEventRoute(own!)).toBe("skip");
    expect(leadEventRoute(userUndo!)).toBe("situation");
  });
});

describe("Lead installs a local MCP through the daemon", () => {
  it("reviews it, installs it only after the user confirms the card, calls its tools, and undo stops the process", async () => {
    const { call, run, perform, card, registry } = await boot();
    const added = await perform("connections", "connections", "add_local", { registry: "npm", package: "@acme/fake-mcp" }, "用户要接本地的 fake-mcp");
    const result = JSON.parse(added.content[0].text).result;
    expect(result).toMatchObject({ result: "needs_confirmation", review: { version: "1.2.3", weeklyDownloads: 25_000 } });
    expect(registry.calls).toContain("https://registry.npmjs.org/@acme%2ffake-mcp");
    expect(added.details.userAction).toMatchObject({ kind: "confirm_rule_change", target: `rule_change:${result.confirmation}` });
    // 还没有装。
    expect((await call("GET", "/v1/connections")).body.items.filter((item: any) => item.key.startsWith("custom-"))).toEqual([]);

    const confirmed = await call("POST", `/v1/actions/rule_change/${result.confirmation}/resolve`, { input: { decision: "confirm" } });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.result.confirmation).toMatchObject({ state: "done" });
    const local = (await call("GET", "/v1/connections")).body.items.find((item: any) => item.key.startsWith("custom-"));
    expect(local).toMatchObject({ state: "connected", serverUrl: "npx -y --package=@acme/fake-mcp@1.2.3 -- fake-mcp", tools: { total: 2 } });
    const echo = await run("call_connection_tool", { connection: local.key, tool: "echo", arguments: { text: "你好" } });
    expect(echo.content[0].text).toContain("你好");
    const env = JSON.parse(/\{.*\}/s.exec((await run("call_connection_tool", { connection: local.key, tool: "env", arguments: {} })).content[0].text)![0]);

    const undo = { target: { type: "connection", id: local.key }, action: "disconnect", label: "撤销" };
    await vi.waitFor(async () => expect((await card(`connection:${local.key}`))?.action).toEqual(undo));
    expect((await call("POST", `/v1/actions/connection/${local.key}/disconnect`, { input: {} })).status).toBe(200);
    await vi.waitFor(() => expect(() => process.kill(env.pid, 0)).toThrow(), { timeout: 5_000 });
    await vi.waitFor(async () => expect((await card(`connection:${local.key}`))?.action).toBeUndefined());
  });
});

describe("Lead installs a skill through the daemon", () => {
  it("installs it from GitHub, find_skill finds it right away, and undo uninstalls it", async () => {
    const { call, run, perform, card } = await boot();
    expect((await run("find_skill", {})).content[0].text).toBe("没有用户装的 skill。");
    const installed = await perform("skills", "skills", "install", { repo: "acme/skills", ref: "main" }, "用户要装 pdf-tools");
    expect(JSON.parse(installed.content[0].text).result).toMatchObject({ result: "installed", skill: { name: "pdf-tools" } });
    expect((await run("find_skill", {})).content[0].text).toMatch(/- pdf-tools：Extract text and tables from PDF files\./);

    const undo = { target: { type: "skill", id: "pdf-tools" }, action: "uninstall", label: "撤销" };
    await vi.waitFor(async () => expect((await card("skill:pdf-tools"))?.action).toEqual(undo));
    expect((await call("POST", "/v1/actions/skill/pdf-tools/uninstall", { input: {} })).status).toBe(200);
    expect((await run("find_skill", {})).content[0].text).toBe("没有用户装的 skill。");
    await vi.waitFor(async () => expect((await card("skill:pdf-tools"))?.action).toBeUndefined());
  });
});
