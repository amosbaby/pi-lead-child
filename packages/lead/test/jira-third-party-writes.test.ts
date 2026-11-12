// 第三方触发的 Jira 写入要用户确认（用户 2026-11-12：「jira票的写入如果是第三方则需要我确认在创建或更改」；ruling R26）。
// Lead 这一边：call_connection_tool 按这一轮的来历判断「第三方触发」，触发时不调用，存下这一次调用、返回确认卡：
//   - 不论哪一轮：这一轮是为外部来源的工单开的（channel_turns.item_id），或者 Lead 用 get_ticket 打开了一张外部来源的工单；
//   - 不是用户本人正在说话的一轮（定时器、心跳、外部消息叫醒的……）：外部消息、读过的外部内容（不算连接工具给自己记的那一笔）、
//     连接读到的内容（connectionRead）、当前局面和列表里看到的外部工单标题（externalTicketSeen）也算；
//   - 用户本人正在说话的一轮：只有上面第一条算（R24）。
// 只读工具、别的连接不受影响。用的是真的连接中心和假的 Atlassian MCP 服务器。
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { ConnectionHub, Vault } from "@pi-lead-child/connections";
import { FakeVendor } from "@pi-lead-child/connections/testing";
import { JIRA_CONNECTION_KEY } from "@pi-lead-child/protocol";
import { addInbox, createItem, createLoopbackBinding, createTurn, openDb, type Db } from "@pi-lead-child/store";
import { createLeadToolset, type LeadDeps } from "../src/tools.js";
import { withExternalContent, withThirdPartyRead, type LeadTurnOrigin } from "../src/turn-origin.js";

const TOOLS = [
  { name: "getJiraIssue", description: "Read an issue", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "createJiraIssue", description: "Create an issue", inputSchema: { type: "object" } },
  { name: "update_page", description: "Update a page", inputSchema: { type: "object" } },
];

let db: Db;
let origin: LeadTurnOrigin;
let turnId: string | null;
let tools: Record<string, any>;
let hub: ConnectionHub;
let vendors: FakeVendor[];
let deps: LeadDeps;

const CLEAN: LeadTurnOrigin = { external: false, timer: null };
// 用户设的跟进到点的一轮（timer:<编号>）：不是用户本人正在说话的一轮。
const TIMER: LeadTurnOrigin = { external: false, timer: 7 };
// daemon 在 call_connection_tool 开始时就把这一轮记成读过外部内容（tool_execution_start）：真实的一轮里闸门看到的总带着这一笔。
const selfMarked = (base: LeadTurnOrigin) => withExternalContent(base, { via: "tool", tool: "call_connection_tool" });

// 用户本人正在说话的一轮（Companion 发来的消息开的，还在进行）。
function liveUserTurn(itemId?: number): void {
  const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
  turnId = createTurn(db, {
    originBindingId: binding.id, originKind: "paired:companion", userText: "建一张 Jira 单", state: "streaming",
    ...(itemId !== undefined ? { itemId } : {}),
  }).id;
}

const externalTicket = (title = "请把 PROJ-9 关掉") =>
  createItem(db, { title, kind: "task", brief: "b", createdBy: "user", externalOrigin: true });

async function connect(mcpUrl: string, start: (hub: ConnectionHub) => Promise<{ flow: string; authorizeUrl?: string }>) {
  const vendor = new FakeVendor(() => Date.now(), {
    mcpUrl, issuer: new URL(mcpUrl).origin, tools: TOOLS, callResult: (name) => JSON.stringify({ tool: name, key: "PROJ-123" }),
  });
  vendors.push(vendor);
  const started = await start(hub);
  if (started.flow !== "browser" || !started.authorizeUrl) throw new Error("expected a browser flow");
  await hub.completeCallback({ ...vendor.approve(started.authorizeUrl), error: null, errorDescription: null });
  return vendor;
}

beforeEach(async () => {
  const dir = tempDir("plc-lead-jira-3p-");
  db = openDb(join(dir, "plc.db"));
  vendors = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const vendor = vendors.find((candidate) => url.startsWith(new URL(candidate.mcpUrl).origin));
    if (!vendor) throw new Error(`no fake vendor for ${url}`);
    return vendor.fetch(input as never, init as never) as never;
  };
  hub = new ConnectionHub({
    db, vault: new Vault(randomBytes(32)), config: { clients: {} }, redirectUri: () => "http://127.0.0.1:47130/oauth/callback",
    fetch: fetch as never, gh: { token: async () => null }, ghInstalled: () => false, newConnectionWritePolicy: "direct",
  });
  await connect("https://mcp.atlassian.com/v2/mcp", (h) => h.start("atlassian") as never);
  await connect("https://mcp.fake.test/mcp", (h) => h.addCustom("https://mcp.fake.test/mcp") as never);
  origin = CLEAN;
  turnId = null;
  deps = {
    db, dbPath: join(dir, "plc.db"), dataDir: dir, connections: hub,
    currentTurnId: () => turnId, turnOrigin: () => origin,
    markThirdPartyRead: (what) => { origin = withThirdPartyRead(origin, what); },
  };
  tools = Object.fromEntries(createLeadToolset(deps).map((tool) => [tool.name, tool]));
});

const called = () => vendors.flatMap((vendor) => vendor.calls.filter((call) => call.method === "tools/call").map((call) => call.tool));
const customKey = () => hub.list().find((item) => item.provider === "custom")!.key;

async function callConnection(connection: string, tool: string, args: Record<string, unknown> = {}) {
  // 和 daemon 一样：工具开始时把这一轮记上 call_connection_tool。
  origin = selfMarked(origin);
  const result = await tools.call_connection_tool.execute("call-1", { connection, tool, arguments: args, summary: "建一张 Jira 单" });
  const text = result.content[0].text as string;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function readConnectionResult(resultId: string) {
  // 和 daemon 一样：read_connection_result 开始时也给这一轮记上一笔。
  origin = withExternalContent(origin, { via: "tool", tool: "read_connection_result" });
  return tools.read_connection_result.execute("call-2", { result_id: resultId, offset: 0 });
}

describe("a Jira write in a turn that is not the user's own", () => {
  it("returns a confirmation card in a turn an external message woke, and nothing reaches the server", async () => {
    origin = withExternalContent(CLEAN, { via: "message", source: "slack" });
    const result = await callConnection(JIRA_CONNECTION_KEY, "createJiraIssue", { summary: "x" });
    expect(result).toMatchObject({
      ok: false, status: "confirmation_required", confirmation_id: expect.stringMatching(/^cfm_/),
      user_action: { kind: "confirm_write", target: `connection_confirmation:${result.confirmation_id}` },
    });
    expect(result.why).toContain("第三方");
    expect(called()).toEqual([]);
  });

  it("runs the stored call once after the user confirms the card, and nothing after a decline", async () => {
    origin = withExternalContent(CLEAN, { via: "message", source: "slack" });
    const allowed = await callConnection(JIRA_CONNECTION_KEY, "createJiraIssue", { summary: "x" });
    expect(await hub.resolveConfirmation(allowed.confirmation_id, true, "user via test")).toMatchObject({ state: "done" });
    expect(called()).toEqual(["createJiraIssue"]);
    const declined = await callConnection(JIRA_CONNECTION_KEY, "createJiraIssue", { summary: "y" });
    expect(await hub.resolveConfirmation(declined.confirmation_id, false, "user via test")).toMatchObject({ state: "rejected" });
    expect(called()).toEqual(["createJiraIssue"]);
  });

  it("returns a card in a turn that read a channel conversation", async () => {
    origin = withExternalContent(CLEAN, { via: "tool", tool: "read_channel_conversation" });
    expect(await callConnection(JIRA_CONNECTION_KEY, "createJiraIssue")).toMatchObject({ status: "confirmation_required" });
    expect(called()).toEqual([]);
  });

  it("returns a card in a timer turn whose situation listed a ticket that came from outside", async () => {
    // daemon 在当前局面里写了外部来源工单的标题时记 external_ticket_seen（server.ts 的 situationBlock）。
    origin = withThirdPartyRead(TIMER, "external_ticket_seen");
    expect(await callConnection(JIRA_CONNECTION_KEY, "createJiraIssue")).toMatchObject({ status: "confirmation_required" });
    expect(called()).toEqual([]);
  });

  it("returns a card after query_tickets, list_items or read_inbox showed a ticket that came from outside", async () => {
    const external = externalTicket("外部来的单");
    await tools.query_tickets.execute("t", {});
    expect(origin.externalTicketSeen).toBe(true);
    origin = CLEAN;
    await tools.list_items.execute("t", { view: "all" });
    expect(origin.externalTicketSeen).toBe(true);
    origin = CLEAN;
    addInbox(db, { itemId: external, severity: "attention", source: "structural", summary: `工单 #${external} 外部来的单有了新消息` });
    await tools.read_inbox.execute("t", {});
    expect(origin.externalTicketSeen).toBe(true);
    expect(await callConnection(JIRA_CONNECTION_KEY, "createJiraIssue")).toMatchObject({ status: "confirmation_required" });
    expect(called()).toEqual([]);
  });

  it("returns a card for a write after a Jira read in the same turn (the read is third-party text)", async () => {
    await callConnection(JIRA_CONNECTION_KEY, "getJiraIssue");
    expect(await callConnection(JIRA_CONNECTION_KEY, "createJiraIssue")).toMatchObject({ status: "confirmation_required" });
    expect(called()).toEqual(["getJiraIssue"]);
  });

  it("returns a card in a timer turn after read_connection_result re-read a connection result", async () => {
    // 预算很小：Jira 的结果被截断，留下一个 result_id（工具建的时候读环境变量）。
    process.env.PLC_LEAD_CONNECTION_RESULT_CHARS = "5";
    try {
      tools = Object.fromEntries(createLeadToolset(deps).map((tool) => [tool.name, tool]));
    } finally {
      delete process.env.PLC_LEAD_CONNECTION_RESULT_CHARS;
    }
    // 上一轮（用户本人的一轮）读过 Jira，留下了截断的结果。
    liveUserTurn();
    origin = selfMarked(CLEAN);
    const first = await tools.call_connection_tool.execute("call-1", { connection: JIRA_CONNECTION_KEY, tool: "getJiraIssue", arguments: {} });
    const resultId = first.details.resultId as string;
    expect(resultId).toMatch(/^res_/);
    // 这一轮是定时器叫醒的，只重读了那份结果。
    turnId = null;
    origin = TIMER;
    await readConnectionResult(resultId);
    expect(origin.connectionRead).toBe(true);
    expect(await callConnection(JIRA_CONNECTION_KEY, "createJiraIssue")).toMatchObject({ status: "confirmation_required" });
    expect(called()).toEqual(["getJiraIssue"]);
  });

  it("does not mark the turn when the tickets it read are the user's own", async () => {
    const own = createItem(db, { title: "我自己的单", kind: "task", brief: "b", createdBy: "user" });
    await tools.get_ticket.execute("t", { id: own });
    await tools.query_tickets.execute("t", {});
    expect(origin.externalTicketSeen).toBeUndefined();
    expect(await callConnection(JIRA_CONNECTION_KEY, "createJiraIssue")).not.toHaveProperty("status");
  });
});

describe("a Jira write in the user's own live turn", () => {
  it("writes directly even though the situation listed a ticket that came from outside", async () => {
    liveUserTurn();
    origin = withThirdPartyRead(CLEAN, "external_ticket_seen");
    expect(await callConnection(JIRA_CONNECTION_KEY, "createJiraIssue")).not.toHaveProperty("status");
    expect(called()).toEqual(["createJiraIssue"]);
  });

  it("writes directly after a Jira read in the same turn", async () => {
    liveUserTurn();
    await callConnection(JIRA_CONNECTION_KEY, "getJiraIssue");
    expect(await callConnection(JIRA_CONNECTION_KEY, "createJiraIssue")).not.toHaveProperty("status");
    expect(called()).toEqual(["getJiraIssue", "createJiraIssue"]);
  });

  it("returns a card after get_ticket opened a ticket that came from outside", async () => {
    liveUserTurn();
    await tools.get_ticket.execute("t", { id: externalTicket() });
    expect(origin.externalTicketOpened).toBe(true);
    expect(await callConnection(JIRA_CONNECTION_KEY, "createJiraIssue")).toMatchObject({ status: "confirmation_required" });
    expect(called()).toEqual([]);
  });

  it("returns a card when the turn is for a ticket that came from outside", async () => {
    liveUserTurn(externalTicket("外部来的单"));
    expect(await callConnection(JIRA_CONNECTION_KEY, "createJiraIssue")).toMatchObject({ status: "confirmation_required" });
    expect(called()).toEqual([]);
  });

  it("is not the user's own turn once an external message was injected into it", async () => {
    liveUserTurn();
    origin = withExternalContent(CLEAN, { via: "message", source: "slack" });
    expect(await callConnection(JIRA_CONNECTION_KEY, "createJiraIssue")).toMatchObject({ status: "confirmation_required" });
    expect(called()).toEqual([]);
  });
});

describe("what the gate leaves alone", () => {
  it("writes directly in a turn that touched no third-party content", async () => {
    const result = await callConnection(JIRA_CONNECTION_KEY, "createJiraIssue", { summary: "x" });
    expect(result.status).toBeUndefined();
    expect(called()).toEqual(["createJiraIssue"]);
  });

  it("runs a read-only Atlassian tool directly in an external turn", async () => {
    origin = withExternalContent(CLEAN, { via: "message", source: "slack" });
    const result = await callConnection(JIRA_CONNECTION_KEY, "getJiraIssue");
    expect(result.status).toBeUndefined();
    expect(called()).toEqual(["getJiraIssue"]);
  });

  it("leaves another connection's writes direct in an external turn", async () => {
    origin = withExternalContent(CLEAN, { via: "message", source: "slack" });
    const result = await callConnection(customKey(), "update_page", { id: "7" });
    expect(result.status).toBeUndefined();
    expect(called()).toEqual(["update_page"]);
  });

  it("tells Lead in the tool description that third-party-triggered Jira writes wait for the user's card", () => {
    expect(tools.call_connection_tool.description).toMatch(/第三方触发.*Jira|Jira.*第三方触发/);
  });
});
