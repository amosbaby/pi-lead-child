// Jira 最小拉取经连接中心调 Atlassian（ruling R23）：daemon 带的收窄清单 JIRA_INTAKE_GRANT 只放行只读工具。
// 用真的连接中心和假的 Atlassian MCP 服务器（只读的查单工具、写工具），核对：
//   - 查单（只读）能调通，拿到服务器的原文；
//   - 写工具（建单、改单、转状态、评论）在连接中心被清单拒绝（grant_denied），服务器一次也没收到；
//   - 连接设成 direct（daemon 建连接的缺省）、没有清单时，同样的写工具会被调通：这是清单存在的理由。
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { DEFAULT_JIRA_SEARCH_TOOL, JIRA_CONNECTION_KEY, JIRA_INTAKE_GRANT } from "@pi-lead-child/protocol";
import { openDb } from "@pi-lead-child/store";
import { ConnectionHub } from "../src/hub.js";
import { Vault } from "../src/vault.js";
import { FakeVendor } from "../testing/fake-vendor.js";

const WRITE_TOOLS = ["createJiraIssue", "editJiraIssue", "transitionJiraIssue", "addCommentToJiraIssue"];
const TOOLS = [
  { name: DEFAULT_JIRA_SEARCH_TOOL, description: "Search issues with JQL", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  ...WRITE_TOOLS.map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
];

let clock: number;
let vendor: FakeVendor;
let hub: ConnectionHub;

beforeEach(async () => {
  clock = Date.parse("2026-11-12T08:00:00.000Z");
  vendor = new FakeVendor(() => clock, {
    mcpUrl: "https://mcp.atlassian.com/v2/mcp", issuer: "https://mcp.atlassian.com", tools: TOOLS,
    callResult: (name) => JSON.stringify({ issues: [], tool: name }),
  });
  hub = new ConnectionHub({
    db: openDb(join(tempDir("plc-jira-grant-"), "plc.db")), vault: new Vault(randomBytes(32)), config: { clients: {} },
    redirectUri: () => "http://127.0.0.1:47130/oauth/callback", fetch: vendor.fetch, now: () => clock,
    gh: { token: async () => null }, ghInstalled: () => false,
  });
  const started = await hub.start("atlassian");
  if (started.flow !== "browser") throw new Error("expected a browser flow");
  await hub.completeCallback({ ...vendor.approve(started.authorizeUrl), error: null, errorDescription: null });
});

const called = () => vendor.calls.filter((call) => call.method === "tools/call").map((call) => call.tool);

describe("the Jira pull's call through the connection hub", () => {
  it("lets the search tool through and returns the server's text", async () => {
    const result = await hub.callTool(JIRA_CONNECTION_KEY, DEFAULT_JIRA_SEARCH_TOOL, { jql: "x" }, { role: "lead", grant: JIRA_INTAKE_GRANT });
    expect(result).toMatchObject({ isError: false });
    expect(JSON.parse(result.text)).toMatchObject({ tool: DEFAULT_JIRA_SEARCH_TOOL });
    expect(called()).toEqual([DEFAULT_JIRA_SEARCH_TOOL]);
  });

  it("refuses every write tool at the hub, and the server never receives the call", async () => {
    for (const tool of WRITE_TOOLS) {
      await expect(hub.callTool(JIRA_CONNECTION_KEY, tool, {}, { role: "lead", grant: JIRA_INTAKE_GRANT }))
        .rejects.toMatchObject({ code: "grant_denied" });
    }
    expect(called()).toEqual([]);
  });

  it("would have called the write tool without the grant once the connection is set to direct (the daemon's default)", async () => {
    hub.updateSettings(JIRA_CONNECTION_KEY, { writePolicy: "direct" });
    await expect(hub.callTool(JIRA_CONNECTION_KEY, "createJiraIssue", {}, { role: "lead" })).resolves.toMatchObject({ isError: false });
    expect(called()).toEqual(["createJiraIssue"]);
  });
});
