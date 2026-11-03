// 来源的连接方式（2026-11-02，.scratch/slack-session 工单 05、09）：通道设置（channel-settings.ts）经过操作层（channel_connection）
// 做登录、换方式和「代你往来源里写」开关。来源是真的 Slack 插件，Slack 和登录窗口是假的，保险库和库是真的。
//   - 登录：用户本人才能做（Lead 得到 user_direct 拒绝，说明去哪里点）；等你登录 → 登录成功、检查通过 → cookie 存进保险库，
//     换到浏览器会话，重连；取消、窗口关掉时什么都不存；
//   - 换回 Slack 应用：Lead 可以做；重连；
//   - 开关：打开只有用户本人能做，关掉 Lead 可以做；马上生效，适配器的写能力跟着变。
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLACK_SESSION_COOKIE_ENV } from "@pi-lead-child/core";
import { tempDir } from "@pi-lead-child/core/testing";
import { Vault } from "@pi-lead-child/connections";
import { builtinChannelAdapters, runUiAction, type ChannelAdapter, type SlackSignInBrowser } from "@pi-lead-child/engine";
import { FAKE_SLACK_SESSION_COOKIE, FakeSlack } from "@pi-lead-child/engine/testing";
import { ChannelConnectionDtoSchema } from "@pi-lead-child/protocol";
import { getChannelConnection, openDb, type Db } from "@pi-lead-child/store";
import { Value } from "typebox/value";
import { ChannelSettings } from "../src/channel-settings.js";

let db: Db;
let slack: FakeSlack;
let logs: string[];
let reloads: string[];
let adapter: ChannelAdapter;
let settings: ChannelSettings;
// 假的登录窗口：signedIn 为 true 以后，下一次看 cookie 时就有了。
let signedIn: boolean;
let windowsClosed: number;

const target = { type: "channel_connection", id: "slack" } as const;
const user = { kind: "user" } as const;
const lead = { kind: "lead", turnId: null } as const;

const browser: SlackSignInBrowser = {
  async open() {
    return {
      closed: new Promise<void>(() => {}),
      cookies: async () => (signedIn ? [{ name: "d", domain: ".slack.com", value: FAKE_SLACK_SESSION_COOKIE }] : []),
      close: async () => { windowsClosed += 1; },
    };
  },
};

beforeEach(() => {
  db = openDb(join(tempDir("plc-channel-connections-"), "plc.db"));
  slack = new FakeSlack();
  logs = [];
  reloads = [];
  signedIn = false;
  windowsClosed = 0;
  [adapter] = builtinChannelAdapters({
    slack: {
      api: slack.api,
      session: {
        network: { fetch: slack.sessionFetch, createWebSocket: slack.createSessionSocket, maxHttpRetries: 0 },
        signIn: { browser, pollMs: 5 },
      },
    },
  }, {}, { connectionSettings: (source) => getChannelConnection(db, source) }) as [ChannelAdapter];
  settings = new ChannelSettings({
    db, vault: new Vault(randomBytes(32)), log: (line) => logs.push(line), env: () => null, keychain: () => null,
  });
  settings.attach({ adapters: () => [adapter], reload: async (source) => { reloads.push(source); } });
});

afterEach(() => {
  db.close();
});

const services = () => ({ channelConnections: settings });
const act = (action: string, caller: typeof user | typeof lead, input: Record<string, unknown> = {}) =>
  runUiAction(db, { target, action, input, reason: "测试", caller, services: services() });

describe("choosing how Slack connects", () => {
  it("starts on the Slack app, and lists the browser session as a mode that needs a sign-in", () => {
    expect(settings.state("slack")).toMatchObject({
      source: "slack", mode: "app", writes: null, writesBlocked: null, signIn: null,
      modes: [{ mode: "app", needsSignIn: false, writesSwitch: false }, { mode: "session", needsSignIn: true, writesSwitch: true }],
    });
  });

  it("refuses the sign-in to Lead and says where the user clicks", async () => {
    await expect(act("sign_in", lead, { mode: "session" }))
      .rejects.toMatchObject({ code: "user_direct", refusal: { where: "设置 → 消息通道 → 连接方式" } });
    expect(settings.state("slack")!.signIn).toBeNull();
  });

  it("signs in, checks, saves the cookie, switches to the session and reconnects", async () => {
    const started = await act("sign_in", user, { mode: "session" });
    expect(started.result).toMatchObject({ mode: "app", signIn: { mode: "session", state: "waiting", error: null } });
    // 等着时不能再开一个窗口。
    await expect(act("sign_in", user, { mode: "session" })).rejects.toMatchObject({ code: "unavailable" });
    signedIn = true;
    await vi.waitFor(() => expect(settings.state("slack")!.signIn!.state).toBe("done"));
    expect(settings.secret(SLACK_SESSION_COOKIE_ENV)).toBe(FAKE_SLACK_SESSION_COOKIE);
    expect(getChannelConnection(db, "slack").mode).toBe("session");
    expect(reloads).toEqual(["slack"]);
    expect(adapter.auth.secrets).toEqual([SLACK_SESSION_COOKIE_ENV]);
    // 换过去以后「代你发消息」是关的：只读。
    expect(settings.state("slack")).toMatchObject({ mode: "session", writes: false });
    expect(settings.state("slack")!.writesBlocked).toContain("「允许 Lead 代你发消息」关着");
    expect(adapter.capabilities.reply).toBe(false);
    expect(windowsClosed).toBe(1);
    expect(logs.join("\n")).not.toContain(FAKE_SLACK_SESSION_COOKIE);
  });

  it("saves nothing when the sign-in is cancelled", async () => {
    await act("sign_in", user, { mode: "session" });
    // Lead 可以关掉正在等的窗口。
    await act("cancel_sign_in", lead);
    await vi.waitFor(() => expect(settings.state("slack")!.signIn!.state).toBe("cancelled"));
    expect(settings.secret(SLACK_SESSION_COOKIE_ENV)).toBeNull();
    expect(getChannelConnection(db, "slack").mode).toBeNull();
    expect(reloads).toEqual([]);
    // 设置页读的形状（GET …/connection）：带着原因的代码，不带给 Lead 和日志的原文，也没有不能写的原因。
    const dto = settings.connection("slack")!;
    expect(Value.Check(ChannelConnectionDtoSchema, dto)).toBe(true);
    expect(dto.signIn).toMatchObject({ mode: "session", state: "cancelled", code: "cancelled", expiresAt: null });
    expect(settings.connection("missing")).toBeNull();
  });

  it("writes an ended session in the user's language, not the source's own words", () => {
    settings.sourceStatus("slack", { state: "error", error: "会话已失效，请重新登录", reason: "signed_out" });
    expect(settings.list()[0]).toMatchObject({
      status: "error", lastError: "The session ended: SSO expired, or you signed out of all devices. Sign in again.",
    });
    settings.sourceStatus("slack", { state: "error", error: "连不上 Slack：timeout" });
    expect(settings.list()[0]!.lastError).toBe("连不上 Slack：timeout");
  });

  it("lets Lead switch back to the Slack app, and refuses a switch to a mode that needs a sign-in", async () => {
    await act("sign_in", user, { mode: "session" });
    signedIn = true;
    await vi.waitFor(() => expect(settings.state("slack")!.mode).toBe("session"));
    await expect(act("use_mode", lead, { mode: "session" })).rejects.toMatchObject({ code: "invalid_input" });
    const back = await act("use_mode", lead, { mode: "app" });
    expect(back.result).toMatchObject({ mode: "app", writes: null });
    expect(reloads).toEqual(["slack", "slack"]);
    expect(adapter.auth.secrets).toEqual(["PLC_SLACK_APP_TOKEN", "PLC_SLACK_USER_TOKEN"]);
  });
});

describe("the switch for sending on the user's behalf", () => {
  beforeEach(async () => {
    await act("sign_in", user, { mode: "session" });
    signedIn = true;
    await vi.waitFor(() => expect(settings.state("slack")!.mode).toBe("session"));
  });

  it("only the user can turn it on; Lead can turn it off; it takes effect at once", async () => {
    await expect(act("allow_writes", lead)).rejects.toMatchObject({ code: "user_direct" });
    expect(adapter.capabilities.reply).toBe(false);
    await act("allow_writes", user);
    expect(settings.state("slack")).toMatchObject({ writes: true, writesBlocked: null });
    expect(adapter.capabilities).toMatchObject({ reply: true, edit: true, react: true, retract: true });
    await act("block_writes", lead);
    expect(settings.state("slack")!.writes).toBe(false);
    expect(adapter.capabilities.reply).toBe(false);
    // 开关不重连：只是读一个值。
    expect(reloads).toEqual(["slack"]);
  });
});
