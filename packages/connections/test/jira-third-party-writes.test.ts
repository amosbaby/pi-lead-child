// 第三方触发的 Jira 写入要用户确认（用户 2026-11-12：「jira票的写入如果是第三方则需要我确认在创建或更改」）。
// 连接中心这一层：Atlassian 连接的写工具在调用方说明「第三方触发」（thirdParty）时，即使写入策略是 direct，也按「先问我」处理：
//   - needsConfirmation 为 true，直接调用被拒（confirmation_required），服务器一次也没收到；
//   - requestWrite 存下这一次调用，用户允许后执行一次，不要时作废；
//   - 只读工具、不是第三方触发的调用、别的连接照旧。
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { DEFAULT_INTENT_GRANT_BOUNDS, JIRA_CONNECTION_KEY, type RunGrant } from "@pi-lead-child/protocol";
import { createItem, createRun, insertRunGrant, openDb, type Db } from "@pi-lead-child/store";
import { ConnectionHub } from "../src/hub.js";
import { Vault } from "../src/vault.js";
import { FakeVendor } from "../testing/fake-vendor.js";

const TOOLS = [
  { name: "getJiraIssue", description: "Read an issue", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "createJiraIssue", description: "Create an issue", inputSchema: { type: "object" } },
];

let clock: number;

async function connect(mcpUrl: string, provider: "atlassian" | "custom") {
  const vendor = new FakeVendor(() => clock, {
    mcpUrl, issuer: new URL(mcpUrl).origin, tools: TOOLS, callResult: (name) => JSON.stringify({ tool: name, key: "PROJ-123" }),
  });
  const db = openDb(join(tempDir("plc-jira-3p-"), "plc.db"));
  const hub = new ConnectionHub({
    db, vault: new Vault(randomBytes(32)), config: { clients: {} },
    redirectUri: () => "http://127.0.0.1:47130/oauth/callback", fetch: vendor.fetch, now: () => clock,
    gh: { token: async () => null }, ghInstalled: () => false, newConnectionWritePolicy: "direct",
  });
  const started = provider === "atlassian" ? await hub.start("atlassian") : await hub.addCustom(mcpUrl);
  if (started.flow !== "browser") throw new Error("expected a browser flow");
  await hub.completeCallback({ ...vendor.approve(started.authorizeUrl), error: null, errorDescription: null });
  const key = provider === "atlassian" ? JIRA_CONNECTION_KEY : hub.list().find((item) => item.provider === "custom")!.key;
  const called = () => vendor.calls.filter((call) => call.method === "tools/call").map((call) => call.tool);
  return { hub, key, called, db };
}

beforeEach(() => {
  clock = Date.parse("2026-11-12T08:00:00.000Z");
});

describe("a third-party-triggered write on the Atlassian connection", () => {
  it("needs the user's confirmation even though the connection writes directly, and never reaches the server", async () => {
    const { hub, key, called } = await connect("https://mcp.atlassian.com/v2/mcp", "atlassian");
    expect(hub.list().find((item) => item.key === key)?.writePolicy).toBe("direct");
    expect(hub.needsConfirmation(key, "createJiraIssue", { thirdParty: true })).toBe(true);
    await expect(hub.callTool(key, "createJiraIssue", { summary: "x" }, { role: "lead", thirdParty: true }))
      .rejects.toMatchObject({ code: "confirmation_required" });
    expect(called()).toEqual([]);
  });

  it("runs the stored call once when the user allows it", async () => {
    const { hub, key, called } = await connect("https://mcp.atlassian.com/v2/mcp", "atlassian");
    const pending = hub.requestWrite(key, "createJiraIssue", { summary: "x" }, "建一张 Jira 单", { thirdParty: true });
    expect(pending).toMatchObject({ state: "pending", tool: "createJiraIssue" });
    expect(called()).toEqual([]);
    const done = await hub.resolveConfirmation(pending.id, true, "user via test");
    expect(done).toMatchObject({ state: "done", resolvedBy: "user via test" });
    // 再点一次不会再写一次。
    await hub.resolveConfirmation(pending.id, true, "user via test");
    expect(called()).toEqual(["createJiraIssue"]);
  });

  it("discards the stored call when the user declines", async () => {
    const { hub, key, called } = await connect("https://mcp.atlassian.com/v2/mcp", "atlassian");
    const pending = hub.requestWrite(key, "createJiraIssue", { summary: "x" }, "建一张 Jira 单", { thirdParty: true });
    expect(await hub.resolveConfirmation(pending.id, false, "user via test")).toMatchObject({ state: "rejected" });
    expect(called()).toEqual([]);
  });

  it("leaves read-only tools and the user's own writes direct", async () => {
    const { hub, key, called } = await connect("https://mcp.atlassian.com/v2/mcp", "atlassian");
    expect(hub.needsConfirmation(key, "getJiraIssue", { thirdParty: true })).toBe(false);
    await hub.callTool(key, "getJiraIssue", {}, { role: "lead", thirdParty: true });
    expect(hub.needsConfirmation(key, "createJiraIssue")).toBe(false);
    await hub.callTool(key, "createJiraIssue", {}, { role: "lead" });
    expect(called()).toEqual(["getJiraIssue", "createJiraIssue"]);
    // 不是第三方触发、连接又是 direct 时不存确认（照旧：直接调用即可）。
    expect(() => hub.requestWrite(key, "createJiraIssue", {}, "x")).toThrow(/不需要确认/);
  });
});

describe("a third-party-triggered write on another connection", () => {
  it("stays direct", async () => {
    const { hub, key, called } = await connect("https://mcp.fake.test/mcp", "custom");
    expect(hub.needsConfirmation(key, "createJiraIssue", { thirdParty: true })).toBe(false);
    await hub.callTool(key, "createJiraIssue", {}, { role: "lead", thirdParty: true });
    expect(called()).toEqual(["createJiraIssue"]);
  });
});

// ruling R25：执行外部来源工单（external_origin=1）的 Run 不能直接写 Jira。子 agent 的调用带着 runId、角色 executor，
// 没有 thirdParty；连接是 direct 时以前照样写得进去。现在连接中心拒绝，原因里告诉它用 hand_back 交回要写的内容。
describe("an executor Run writing Jira", () => {
  function runFor(db: Db, externalOrigin: boolean): number {
    const itemId = createItem(db, { title: "PROJ-123 的单", brief: "b", createdBy: "system", externalOrigin });
    return createRun(db, { itemId });
  }
  const jiraWriteGrant: RunGrant = {
    version: 1, intent: "knowledge", localRepos: [],
    rules: [{ id: "jira-write", connection: "atlassian", tools: ["createJiraIssue", "getJiraIssue"], label: "写 Jira" }],
  };

  it("is refused for a ticket that came from outside, and the server never receives the call", async () => {
    const { hub, key, called, db } = await connect("https://mcp.atlassian.com/v2/mcp", "atlassian");
    const runId = runFor(db, true);
    const refusal = await hub.callTool(key, "createJiraIssue", { summary: "x" }, { role: "executor", runId }).catch((error) => error);
    expect(refusal).toMatchObject({ code: "forbidden" });
    expect(refusal.message).toContain("hand_back");
    // 只读工具照旧。
    await hub.callTool(key, "getJiraIssue", {}, { role: "executor", runId });
    expect(called()).toEqual(["getJiraIssue"]);
  });

  it("is refused for a ticket that came from outside even when the Run's grant allows the write", async () => {
    const { hub, key, called, db } = await connect("https://mcp.atlassian.com/v2/mcp", "atlassian");
    const runId = runFor(db, true);
    const itemId = (db.prepare("SELECT item_id FROM runs WHERE id = ?").get(runId) as { item_id: number }).item_id;
    insertRunGrant(db, { itemId, runId, grant: jiraWriteGrant, bound: DEFAULT_INTENT_GRANT_BOUNDS.knowledge, scope: {} });
    const refusal = await hub.callTool(key, "createJiraIssue", {}, { role: "executor", runId }).catch((error) => error);
    expect(refusal.message).toContain("hand_back");
    await hub.callTool(key, "getJiraIssue", {}, { role: "executor", runId });
    expect(called()).toEqual(["getJiraIssue"]);
  });

  it("still writes for the user's own ticket", async () => {
    const { hub, key, called, db } = await connect("https://mcp.atlassian.com/v2/mcp", "atlassian");
    const runId = runFor(db, false);
    await hub.callTool(key, "createJiraIssue", {}, { role: "executor", runId });
    expect(called()).toEqual(["createJiraIssue"]);
  });

  it("leaves another connection's writes alone", async () => {
    const { hub, key, called, db } = await connect("https://mcp.fake.test/mcp", "custom");
    await hub.callTool(key, "createJiraIssue", {}, { role: "executor", runId: runFor(db, true) });
    expect(called()).toEqual(["createJiraIssue"]);
  });
});
