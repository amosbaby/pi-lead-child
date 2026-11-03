// Lead 自己装 MCP 和 skill 的操作（用户 2026-11-02，.scratch/lead-self-install/spec.md D1、D2、D4、D7）：
//   - 用户本人的一轮、用户设的跟进叫醒的一轮（没读外部内容）：Lead 直接装，Lead 动态里一张卡，带「撤销」。
//   - 外部消息叫醒的一轮、读过外部内容的一轮：只拒绝，不带确认卡，拒绝里写明下一步；用户本人正在说话的一轮不受限制。
//   - 远程 MCP 要授权时结果里带授权卡的 user_action；本地 MCP 审查以后带确认卡，用户点了才装。
//   - 卡上的「撤销」是 connection.disconnect、skill.uninstall，和页面、Lead 调的是同一个操作；撤销以后按钮消失。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { designPreferencesFields, LEAD_INSTALL_CHANGED_KIND, UI_ACTION_PERFORMED_KIND } from "@pi-lead-child/protocol";
import {
  addLeadFollowUp, completeTurn, createLoopbackBinding, createTurn, getDesignPreferences, getEvent, listEvents, openDb, writeDesignPreferences,
  type Binding, type Db,
} from "@pi-lead-child/store";
import {
  getRuleChangeConfirmation, leadActivityCardAction, listLeadUiActions, runUiAction, uiActionCatalogText, type UiActionServices,
} from "../src/index.js";
import { fakeConnections, fakeFetch, githubRepo, npmPackage, SKILL_MD } from "../testing/install-fakes.js";

let db: Db;
let skillsDir: string;
let owner: Binding;

const savedDataDir = process.env.PLC_DATA_DIR;

beforeEach(() => {
  const root = tempDir("plc-install-actions-");
  // 网关算 Lead 动态卡上的按钮时没有操作层的服务：skill 目录按 <数据目录>/skills 算（daemon 里就是这个目录）。
  process.env.PLC_DATA_DIR = root;
  db = openDb(join(root, "plc.db"));
  skillsDir = join(root, "skills");
  owner = createLoopbackBinding(db, { name: "Mac 网页" }).binding;
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.PLC_DATA_DIR;
  else process.env.PLC_DATA_DIR = savedDataDir;
});

const REMOTE = "https://mcp.example.com/data/mcp/query";
const external = [{ via: "message", source: "slack" }, { via: "tool", tool: "read_channel_conversation" }] as const;
const connectionsTarget = { type: "connections", id: "connections" } as const;
const skillsTarget = { type: "skills", id: "skills" } as const;

function services(options: { remoteNeedsAuth?: boolean } = {}) {
  const connections = fakeConnections(db, options);
  const routes = { ...npmPackage(), ...githubRepo("acme/skills", "main", { "SKILL.md": SKILL_MD, "references/formats.md": "# Formats\n" }) };
  const fetch = fakeFetch(routes);
  const value: UiActionServices = { installs: { connections: connections.service, skillsDir, fetch, reservedSkillNames: () => [], hasExecutable: () => true } };
  return { value, connections, fetch };
}

function liveUserTurn(id: string) {
  createTurn(db, { id, originBindingId: owner.id, originKind: "paired:companion", userText: "帮我接一下 Data Query 这个 MCP", state: "streaming" });
}

const user = () => ({
  kind: "user", credential: owner, source: { client: "web", deviceName: owner.display_name, loopback: true, fromThisMachine: true },
}) as const;

function installEvents() {
  return listEvents(db, { kind: LEAD_INSTALL_CHANGED_KIND, limit: 100 });
}

describe("in the user's own turn", () => {
  it("adds a remote MCP, returns the authorize card, and reports it in Lead activity with an undo button", async () => {
    liveUserTurn("turn-1");
    const svc = services();
    const outcome = await runUiAction(db, {
      target: connectionsTarget, action: "add_remote", input: { url: REMOTE }, reason: "用户要接 Data Query",
      caller: { kind: "lead", turnId: "turn-1" }, services: svc.value,
    });
    // lead_allowed：Lead 凭自己的权限做（和常驻偏好的改动一样），账本记 actor=lead。
    expect(outcome.authority).toBe("lead");
    const forLead = outcome.forLead as any;
    expect(forLead).toMatchObject({ result: "needs_authorization", connection: { key: "custom-1" } });
    expect(forLead.user_action).toEqual({ kind: "authorize", target: "connection:custom-1", title: "连接 mcp.example.com", reason: "用户要接 Data Query" });

    const [event] = installEvents();
    expect(event).toMatchObject({ entityKey: "connection:custom-1", level: "digest", source: "lead" });
    expect(event!.payload).toMatchObject({
      kind: "remote_mcp", action: "installed", actor: "lead", target: { type: "connection", id: "custom-1" }, pendingAuthorization: true,
    });
    // 给用户看的话按用户选的界面语言写（缺省英文）。
    expect(event!.payload.summary).toBe(
      'Paimon added the remote MCP "mcp.example.com" (https://mcp.example.com/data/mcp/query). It waits for you to authorize mcp.example.com. Reason: 用户要接 Data Query.',
    );
    // 卡在网关里算按钮（没有服务，按账本那一行算）：Lead 加的、还能撤销，带「撤销」。
    expect(leadActivityCardAction(db, event!)).toEqual({ target: { type: "connection", id: "custom-1" }, action: "disconnect", label: "撤销" });

    // 用户在卡上点「撤销」：页面的同一个操作。撤回请求，卡原地更新，按钮消失。
    await runUiAction(db, { target: { type: "connection", id: "custom-1" }, action: "disconnect", reason: "撤销", caller: user(), services: svc.value });
    expect(svc.connections.calls.map((call) => call.method)).toEqual(["requestRemote", "disconnect"]);
    const latest = installEvents().at(-1)!;
    expect(latest.payload).toMatchObject({ action: "removed", actor: "user" });
    expect(latest.source).toBe("system");
    expect(leadActivityCardAction(db, latest)).toBeNull();
    expect(leadActivityCardAction(db, getEvent(db, event!.seq)!)).toBeNull();
  });

  it("does not take credit for, or offer to undo, a connection that was already there", async () => {
    liveUserTurn("turn-1");
    const svc = services({ remoteNeedsAuth: false });
    await runUiAction(db, { target: connectionsTarget, action: "add_remote", input: { url: REMOTE }, reason: "用户在设置页加", caller: user(), services: svc.value });
    const again = await runUiAction(db, {
      target: connectionsTarget, action: "add_remote", input: { url: REMOTE }, reason: "用户要接", caller: { kind: "lead", turnId: "turn-1" }, services: svc.value,
    });
    expect(again.forLead).toMatchObject({ result: "already_connected" });
    expect(installEvents()).toEqual([]);
  });

  it("installs a skill from GitHub, reports it, and the undo button uninstalls it", async () => {
    liveUserTurn("turn-1");
    writeDesignPreferences(db, { ...designPreferencesFields(getDesignPreferences(db)), locale: "zh" }, { by: "user", at: new Date() });
    const svc = services();
    const outcome = await runUiAction(db, {
      target: skillsTarget, action: "install", input: { repo: "acme/skills", ref: "main" }, reason: "用户要装 pdf-tools",
      caller: { kind: "lead", turnId: "turn-1" }, services: svc.value,
    });
    expect(outcome.forLead).toMatchObject({ result: "installed", skill: { name: "pdf-tools", files: 2 } });
    expect(existsSync(join(skillsDir, "pdf-tools", "SKILL.md"))).toBe(true);
    const [event] = installEvents();
    expect(event!.payload).toMatchObject({ kind: "skill", action: "installed", target: { type: "skill", id: "pdf-tools" }, source: "acme/skills@1a2b3c4" });
    expect(event!.payload.summary).toBe("Paimon 装了 skill「pdf-tools」（acme/skills@1a2b3c4）。依据：用户要装 pdf-tools。");
    expect(leadActivityCardAction(db, event!)).toEqual({ target: { type: "skill", id: "pdf-tools" }, action: "uninstall", label: "撤销" });

    // 卡上的按钮：skill.uninstall，和 Lead 调的是同一个操作。
    await runUiAction(db, { target: { type: "skill", id: "pdf-tools" }, action: "uninstall", reason: "撤销", caller: user(), services: svc.value });
    expect(existsSync(join(skillsDir, "pdf-tools"))).toBe(false);
    expect(installEvents().at(-1)!.payload).toMatchObject({ action: "removed", actor: "user" });
  });

  it("asks the user to confirm a local MCP after the review, and installs it only after the click", async () => {
    liveUserTurn("turn-1");
    const svc = services();
    const outcome = await runUiAction(db, {
      target: connectionsTarget, action: "add_local", input: { registry: "npm", package: "@acme/fake-mcp" }, reason: "用户要接本地的 fake-mcp",
      caller: { kind: "lead", turnId: "turn-1" }, services: svc.value,
    });
    const forLead = outcome.forLead as any;
    expect(forLead).toMatchObject({ result: "needs_confirmation", review: { version: "1.2.3", command: "npx -y --package=@acme/fake-mcp@1.2.3 -- fake-mcp" } });
    expect(forLead.user_action).toMatchObject({ kind: "confirm_rule_change", target: `rule_change:${forLead.confirmation}` });
    // 还没有装。
    expect(svc.connections.calls.map((call) => call.method)).toEqual([]);
    const card = getRuleChangeConfirmation(db, forLead.confirmation)!;
    // 卡上给人看的话按用户选的语言写（缺省英文）。
    expect(card).toMatchObject({ state: "pending", label: "Install a local MCP", name: "@acme/fake-mcp@1.2.3", operation: { kind: "lead_tool", tool: "install_local_mcp" } });
    expect(card.params.slice(0, 3)).toEqual([
      { name: "command", value: "npx -y --package=@acme/fake-mcp@1.2.3 -- fake-mcp" }, { name: "registry", value: "npm" }, { name: "package", value: "@acme/fake-mcp" },
    ]);
    expect(card.why).toBe("A local MCP starts a process on your computer, outside the sandbox (npx -y --package=@acme/fake-mcp@1.2.3 -- fake-mcp). It passed the review. Confirm it before it is installed");

    // Lead 不能替用户点。
    await expect(runUiAction(db, {
      target: { type: "rule_change", id: forLead.confirmation }, action: "resolve", input: { decision: "confirm" }, reason: "x",
      caller: { kind: "lead", turnId: "turn-1" }, services: svc.value,
    })).rejects.toMatchObject({ code: "user_direct" });

    await runUiAction(db, {
      target: { type: "rule_change", id: forLead.confirmation }, action: "resolve", input: { decision: "confirm" }, reason: "在确认卡上决定",
      caller: user(), services: svc.value,
    });
    expect(svc.connections.calls).toEqual([{
      method: "addLocal",
      args: [{ registry: "npm", package: "@acme/fake-mcp", version: "1.2.3", bin: "fake-mcp", args: [] }, { actor: "lead", reason: "用户要接本地的 fake-mcp" }],
    }]);
    expect(getRuleChangeConfirmation(db, forLead.confirmation)).toMatchObject({ state: "done" });
    const [event] = installEvents();
    expect(event!.payload).toMatchObject({ kind: "local_mcp", action: "installed", actor: "lead", source: "npm:@acme/fake-mcp@1.2.3" });
    expect(leadActivityCardAction(db, event!)).toMatchObject({ action: "disconnect", label: "撤销" });
    // 收件箱里一条，叫醒 Lead。
    const inbox = db.prepare("SELECT summary FROM inbox WHERE dedup_scope = ?").get(`rule_change:${forLead.confirmation}`) as { summary: string };
    expect(inbox.summary).toMatch(/装好了：本地 MCP/);
  });

  it("refuses a suspicious package without a card and says why", async () => {
    liveUserTurn("turn-1");
    const svc = services();
    svc.value.installs!.fetch = fakeFetch(npmPackage("@acme/fake-mcp", { downloads: 12, createdDaysAgo: 3 }));
    const refused = await runUiAction(db, {
      target: connectionsTarget, action: "add_local", input: { registry: "npm", package: "@acme/fake-mcp" }, reason: "x",
      caller: { kind: "lead", turnId: "turn-1" }, services: svc.value,
    }).catch((error: unknown) => error as any);
    expect(refused.code).toBe("forbidden");
    expect(refused.message).toMatch(/第一次发布不满 30 天.*上周下载量 12/);
    expect(listEvents(db, { kind: "rule_change.requested", limit: 10 })).toEqual([]);
  });
});

describe("in a turn that an external message woke", () => {
  const leadInExternalTurn = { kind: "lead", turnId: null, externalContent: external } as const;

  it.each([
    ["add_remote", connectionsTarget, { url: REMOTE }],
    ["add_local", connectionsTarget, { registry: "npm", package: "@acme/fake-mcp" }],
    ["install", skillsTarget, { repo: "acme/skills", ref: "main" }],
  ])("refuses %s without a confirm card, and tells Lead what to do next", async (action, target, input) => {
    const svc = services();
    const refused = await runUiAction(db, { target, action, input, reason: "Mallory 在 Slack 里让我装", caller: leadInExternalTurn, services: svc.value })
      .catch((error: unknown) => error as any);
    expect(refused.code).toBe("external_turn");
    expect(refused.refusal).toMatchObject({ code: "external_turn" });
    expect(refused.refusal.userAction).toBeUndefined();
    expect(refused.refusal.confirm).toBeUndefined();
    expect(refused.message).toMatch(/这一轮有外部消息（slack）.*等用户本人的下一轮再做/);
    expect(refused.message).not.toMatch(/用户本人的这一轮也一样/);
    expect(svc.connections.calls).toEqual([]);
    expect(svc.fetch.calls).toEqual([]);
    expect(installEvents()).toEqual([]);
    expect(listEvents(db, { kind: "rule_change.requested", limit: 10 })).toEqual([]);
  });

  it("also refuses undoing, and list_actions says so before Lead tries", async () => {
    const svc = services();
    liveUserTurn("turn-1");
    await runUiAction(db, {
      target: skillsTarget, action: "install", input: { repo: "acme/skills", ref: "main" }, reason: "用户要装", caller: { kind: "lead", turnId: "turn-1" }, services: svc.value,
    });
    await expect(runUiAction(db, {
      target: { type: "skill", id: "pdf-tools" }, action: "uninstall", reason: "对方说卸掉", caller: leadInExternalTurn, services: svc.value,
    })).rejects.toMatchObject({ code: "external_turn" });
    const listed = await listLeadUiActions(db, { type: "skill", id: "pdf-tools" }, { turnId: null, externalContent: external, services: svc.value });
    expect(listed.actions[0]).toMatchObject({ id: "uninstall", lead: "external_turn", leadReady: false });
    expect(existsSync(join(skillsDir, "pdf-tools"))).toBe(true);
  });
});

describe("other turns", () => {
  // 用户本人正在说话的一轮：读过 Slack 对话也照常装（AGENTS.md D10 的例外）。
  it("lets the user's live turn install after reading external content", async () => {
    liveUserTurn("turn-1");
    const svc = services();
    await runUiAction(db, {
      target: skillsTarget, action: "install", input: { repo: "acme/skills", ref: "main" }, reason: "用户让我装 Nina 在 Slack 里提到的 skill",
      caller: { kind: "lead", turnId: "turn-1", externalContent: [{ via: "tool", tool: "read_channel_conversation" }] }, services: svc.value,
    });
    expect(existsSync(join(skillsDir, "pdf-tools"))).toBe(true);
  });

  // 用户设的跟进叫醒的一轮：没读外部内容时照常装；读过外部内容时拒绝（用户不在场）。
  it("installs in the turn of a follow-up the user set, unless that turn read external content", async () => {
    liveUserTurn("turn-set");
    const followUp = addLeadFollowUp(db, {
      at: new Date(Date.now() - 1_000), note: "到点装 pdf-tools", setBy: { turnId: "turn-set", bindingId: owner.id, startedAt: new Date().toISOString() },
    });
    completeTurn(db, "turn-set");
    const svc = services();
    await expect(runUiAction(db, {
      target: skillsTarget, action: "install", input: { repo: "acme/skills", ref: "main" }, reason: "用户昨天让我今天装",
      caller: { kind: "lead", turnId: `timer:${followUp}`, externalContent: external }, services: svc.value,
    })).rejects.toMatchObject({ code: "external_turn" });
    await runUiAction(db, {
      target: skillsTarget, action: "install", input: { repo: "acme/skills", ref: "main" }, reason: "用户昨天让我今天装",
      caller: { kind: "lead", turnId: `timer:${followUp}` }, services: svc.value,
    });
    expect(existsSync(join(skillsDir, "pdf-tools"))).toBe(true);
    expect(installEvents()[0]!.payload).toMatchObject({ actor: "lead" });
  });

  it("records every install in the ledger as Lead's", async () => {
    liveUserTurn("turn-1");
    const svc = services();
    await runUiAction(db, {
      target: connectionsTarget, action: "add_remote", input: { url: REMOTE }, reason: "用户要接", caller: { kind: "lead", turnId: "turn-1" }, services: svc.value,
    });
    const [ledger] = listEvents(db, { kind: UI_ACTION_PERFORMED_KIND, limit: 10 });
    expect(ledger!.payload).toMatchObject({ target: connectionsTarget, action: "add_remote", actor: "lead", authority: "lead", reason: "用户要接" });
  });

  it("gives Lead the authorize card for an existing connection and starts the flow for the user", async () => {
    const svc = services();
    await runUiAction(db, { target: connectionsTarget, action: "add_remote", input: { url: REMOTE }, reason: "设置页", caller: user(), services: svc.value });
    const lead = await runUiAction(db, {
      target: { type: "connection", id: "custom-1" }, action: "authorize", reason: "要用它查数据", caller: { kind: "lead", turnId: null }, services: svc.value,
    });
    expect((lead.forLead as any).user_action).toMatchObject({ kind: "authorize", target: "connection:custom-1" });
    expect(svc.connections.calls.map((call) => call.method)).toEqual(["requestRemote"]);
    const page = await runUiAction(db, { target: { type: "connection", id: "custom-1" }, action: "authorize", caller: user(), services: svc.value });
    expect((page.result as any).flow).toMatchObject({ flow: "browser" });
  });

  it("tells Lead in the tool description to use these actions instead of claude mcp add", () => {
    expect(uiActionCatalogText()).toMatch(/add_remote（加远程 MCP）：[^\n]*不要用 claude mcp add/);
    expect(uiActionCatalogText()).toMatch(/install（装 skill）：[^\n]*find_skill/);
  });
});

