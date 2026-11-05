// Slack 的浏览器会话方式（2026-11-02，.scratch/slack-session 工单 03、04）。走真实的 hub、SQLite 和 gabriel-slack，Slack 是假的
// （网页版协议的替身：sessionFetch、createSessionSocket）。共享合约（channel-adapter-contract.test.ts 的 slack-session）
// 已经覆盖了推来的投递、回复的幂等和凭据不外泄；这里测会话方式自己的事：
//   - 凭据：用会话 cookie 换出用户本人和工作区；cookie 没变时接着用同一个会话，换了 cookie 就关掉旧的；
//   - Web API：改消息、回表情、读历史、下载文件都经过会话；
//   - 设置页的检查：格式、能登录、WebSocket 能连上；
//   - 传输：网页版的消息帧（没有 channel_type）进来和 Events API 一样；断线以后补拉，同一条消息只记一次；
//     断线这段时间里没有道的私信和提到用户的消息也补（私信用网页版的 client.counts 找，2026-11-03）；
//     重连地址不是 Slack 的主机时不连；会话失效时报错，不再重试。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLACK_SESSION_COOKIE_ENV } from "@pi-lead-child/core";
import { tempDir } from "@pi-lead-child/core/testing";
import { getChannelCatchUpMark, getChannelLane, listEvents, openDb, type Db } from "@pi-lead-child/store";
import {
  builtinChannelAdapters, ChannelHub, ChannelRegistry, createSlackChannelAdapter, liveBuiltinChannels, SLACK_SESSION_ENDED, slackConnectionOf,
  signInToSlack,
  type ChannelAdapter, type ChannelAdapterContext, type ChannelCredential, type ChannelTransportStatus, type SlackSignInBrowser,
} from "../src/index.js";
import {
  FAKE_SLACK_SESSION_COOKIE, FAKE_SLACK_SESSION_TOKEN, FAKE_SLACK_TOKEN, FAKE_SLACK_USER_SCOPES, FakeSlack,
} from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let logs: string[];
let statuses: ChannelTransportStatus[];
let adapter: ChannelAdapter;
let hub: ChannelHub;

const secrets = (cookie = FAKE_SLACK_SESSION_COOKIE) => ({ [SLACK_SESSION_COOKIE_ENV]: cookie });

// 「允许 Lead 代你发消息」：缺省打开（这里大多测发消息），测开关的用例把它关掉。
let writes: boolean;

// now：适配器的时钟（断线补拉的水位用它）。
function setup(now?: () => Date): void {
  adapter = createSlackChannelAdapter({
    api: slack.api, connection: "session", sessionWrites: () => writes, ...(now ? { now } : {}),
    session: { network: { fetch: slack.sessionFetch, createWebSocket: slack.createSessionSocket, maxHttpRetries: 0 }, retryBaseMs: 5, retryMaxMs: 40 },
  });
  // 和 daemon 的凭据缓存一样：换不成时用上一次换好的。
  let cached: ChannelCredential | null = null;
  hub = new ChannelHub({
    db, registry: new ChannelRegistry([adapter]), log: (line) => logs.push(line),
    credentials: {
      credential: async () => {
        const fresh = await adapter.resolveCredential!(secrets(), (line) => logs.push(line));
        if (fresh) cached = fresh;
        return cached;
      },
    },
  });
}

async function context(): Promise<ChannelAdapterContext> {
  const credential = await adapter.resolveCredential!(secrets(), (line) => logs.push(line));
  return { credential: credential!, log: (line) => logs.push(line) };
}

function start(): void {
  adapter.transport!.start({ ...hub.transportContext("slack"), status: (update) => statuses.push(update) }, (delivery) => hub.receiveFromTransport("slack", delivery));
}

const connected = () => vi.waitFor(() => expect(statuses.at(-1)).toEqual({ state: "connected" }));
const slackEvents = () => listEvents(db, {}).filter((event) => event.source === "slack");

beforeEach(() => {
  db = openDb(join(tempDir("plc-slack-session-"), "plc.db"));
  slack = new FakeSlack({ scopes: [...FAKE_SLACK_USER_SCOPES, "files:read"] });
  logs = [];
  statuses = [];
  writes = true;
  setup();
});

afterEach(async () => {
  await adapter.transport?.stop();
  await hub.idle();
  db.close();
});

describe("choosing the connection in config.json", () => {
  it("asks for the session cookie only when channels.slack.connection is session", () => {
    const live = liveBuiltinChannels(() => null, { config: { slack: { connection: "session" } } });
    expect(live.missing).toEqual([{ source: "slack", names: [SLACK_SESSION_COOKIE_ENV] }]);
    const [session] = builtinChannelAdapters(live.sources, { slack: { connection: "session" } });
    expect(session!.auth.secrets).toEqual([SLACK_SESSION_COOKIE_ENV]);
    expect(session!.settings!.secrets.map((secret) => secret.name)).toEqual([SLACK_SESSION_COOKIE_ENV]);
    // 缺省和不认识的值都是 Slack 应用。
    expect(slackConnectionOf({})).toBe("app");
    expect(slackConnectionOf({ slack: { connection: "cookie" as never } })).toBe("app");
    const [app] = builtinChannelAdapters(liveBuiltinChannels(() => null).sources, {});
    expect(app!.auth.secrets).toEqual(["PLC_SLACK_APP_TOKEN", "PLC_SLACK_USER_TOKEN"]);
  });
});

describe("the session credential", () => {
  it("turns the session cookie into the user and the workspace, and keeps the cookie as the credential", async () => {
    const credential = await adapter.resolveCredential!(secrets(), (line) => logs.push(line));
    expect(credential).toEqual({
      token: FAKE_SLACK_SESSION_COOKIE, account: slack.self.id, accountName: slack.self.name,
      team: { id: slack.teamId, name: "Home" }, secrets: secrets(),
    });
    expect(adapter.auth.secrets).toEqual([SLACK_SESSION_COOKIE_ENV]);
  });

  it("refuses a value that is not a session cookie, and one that no longer signs in", async () => {
    expect(await adapter.resolveCredential!(secrets("xoxp-not-a-cookie"), (line) => logs.push(line))).toBeNull();
    expect(logs.join("\n")).toContain("is not a Slack session cookie");
    slack.endSession();
    expect(await adapter.resolveCredential!(secrets(), (line) => logs.push(line))).toBeNull();
    expect(logs.join("\n")).toContain("the Slack session could not start");
    expect(logs.join("\n")).not.toContain(FAKE_SLACK_SESSION_COOKIE);
  });

  it("keeps one session while the cookie stays the same", async () => {
    await adapter.resolveCredential!(secrets(), () => {});
    await adapter.resolveCredential!(secrets(), () => {});
    await adapter.resolveCredential!(secrets(), () => {});
    // 用 cookie 换会话只有一次：后两次接着用同一个会话（传输的连接不会因为凭据定期重新换而断开）。
    expect(slack.sessionSignIns).toBe(1);
  });

  it("closes the old session when the session ends, and signs in again with the cookie", async () => {
    start();
    await connected();
    slack.endSession();
    await vi.waitFor(() => expect(statuses.at(-1)).toEqual({ state: "error", error: SLACK_SESSION_ENDED, reason: "signed_out" }));
    // 用户重新登录（假的 Slack 里会话又活了），daemon 换凭据：旧的会话已经失效，建一个新的。
    slack.sessionLive = true;
    expect(await adapter.resolveCredential!(secrets(), () => {})).not.toBeNull();
    expect(slack.sessionSignIns).toBeGreaterThanOrEqual(2);
  });
});

describe("the Web API through the session", () => {
  it("edits, reacts, reads the history and downloads a file without the app's tokens", async () => {
    const ctx = await context();
    const sent = await adapter.send(
      { action: "reply", objectKey: "slack:D0ZHANG:main", target: { channel: "D0ZHANG" }, text: "收到" }, { idempotencyKey: "k1" }, ctx,
    );
    expect(slack.sent("D0ZHANG").map((message) => message.text)).toContain("收到");
    await adapter.send(
      { action: "edit", objectKey: "slack:D0ZHANG:main", target: { channel: "D0ZHANG", ts: sent.remoteRef!.ts! }, text: "收到，马上看" },
      { idempotencyKey: "k2" }, ctx,
    );
    expect(slack.sent("D0ZHANG").map((message) => message.text)).toContain("收到，马上看");
    const dm = slack.dm("U0ZHANG", "周五评审的材料收到了吗？");
    await adapter.send(
      { action: "react", objectKey: "slack:D0ZHANG:main", target: { channel: "D0ZHANG", ts: slack.messageOf(dm).ts }, emoji: "eyes" },
      { idempotencyKey: "k3" }, ctx,
    );
    const history = await adapter.history!({ objectKey: "slack:D0ZHANG:main", limit: 10 }, ctx);
    expect(history.map((message) => message.text)).toContain("周五评审的材料收到了吗？");
    const file = slack.addFile("shot.png", "image/png", new Uint8Array([1, 2, 3]));
    const read = await adapter.readFile!(file.id, { maxBytes: 1_000 }, ctx);
    expect(Array.from(read.data)).toEqual([1, 2, 3]);
    expect(slack.sessionCalls).toEqual(expect.arrayContaining(["chat.postMessage", "chat.update", "reactions.add", "conversations.history", "files.info"]));
    // 用户令牌没有出现在任何请求里：所有调用都是会话方式的。
    expect(slack.sessionCalls.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain(FAKE_SLACK_TOKEN);
  });
});

describe("the settings check for a session", () => {
  it("passes for a live session and names the account", async () => {
    const result = await adapter.settings!.test(secrets(), { log: (line) => logs.push(line) });
    expect(result.checks.map((check) => [check.id, check.pass])).toEqual([
      ["session_cookie_kind", true], ["session_sign_in", true], ["session_socket", true],
    ]);
    expect(result).toMatchObject({ ok: true, account: { userId: slack.self.id, teamId: slack.teamId, teamName: "Home" } });
    expect(JSON.stringify(result)).not.toContain(FAKE_SLACK_SESSION_COOKIE);
    expect(adapter.settings!.secrets.map((secret) => secret.name)).toEqual([SLACK_SESSION_COOKIE_ENV]);
  });

  it("says when the cookie is missing, malformed or no longer signs in", async () => {
    const missing = await adapter.settings!.test({}, { log: () => {} });
    expect(missing.checks[0]).toMatchObject({ id: "session_cookie_kind", pass: false, detail: "缺 Slack 会话：还没有登录。" });
    const wrong = await adapter.settings!.test(secrets("xoxc-a-token-not-a-cookie"), { log: () => {} });
    expect(wrong).toMatchObject({ ok: false });
    expect(JSON.stringify(wrong)).not.toContain("xoxc-a-token-not-a-cookie");
    slack.endSession();
    const ended = await adapter.settings!.test(secrets(), { log: () => {} });
    expect(ended.checks.find((check) => check.id === "session_sign_in")).toMatchObject({ pass: false });
    expect(ended.checks.find((check) => check.id === "session_sign_in")!.detail).toContain("会话已失效");
  });
});

describe("the session transport", () => {
  it("records web client frames like Events API deliveries, in the order they arrive", async () => {
    start();
    await connected();
    slack.sessionPush(slack.dm("U0ZHANG", "周五评审的材料收到了吗？"));
    const mention = slack.mention("U0LI", "这个接口的超时是多少？");
    slack.sessionPush(mention);
    slack.sessionPush(slack.chatter("U0LI", "补充：生产环境", "C0PROJ", { thread: slack.messageOf(mention).ts }));
    await vi.waitFor(() => expect(slackEvents().map((event) => event.kind))
      .toEqual(["slack.dm.received", "slack.mention.received", "slack.thread.message"]));
    expect(slackEvents().map((event) => event.payload.channelType)).toEqual(["im", "channel", "channel"]);
    expect(slack.sessionSocket()!.headers.Cookie).toBe(`d=${FAKE_SLACK_SESSION_COOKIE}`);
  });

  it("catches up after a reconnect and records each message once", async () => {
    start();
    await connected();
    const first = slack.dm("U0ZHANG", "第一条");
    slack.sessionPush(first);
    await vi.waitFor(() => expect(slackEvents()).toHaveLength(1));
    slack.dropSession();
    // 断线期间对方又发了一条（没有推过来）。
    slack.dm("U0ZHANG", "断线时发的");
    await vi.waitFor(() => expect(slack.sessionConnections).toBe(2));
    await vi.waitFor(() => expect(slackEvents().map((event) => event.payload.text)).toEqual(["第一条", "断线时发的"]));
    expect(getChannelLane(db, "slack:D0ZHANG:main")!.context.map((message) => message.text)).toEqual(["第一条", "断线时发的"]);
    // 这条又推了一次（例如重连前后的重复）：只记一次。
    slack.sessionPush(first);
    await hub.idle();
    expect(slackEvents()).toHaveLength(2);
  });

  it("catches up direct messages and mentions from the gap in conversations without a lane, found through the web client's counts", async () => {
    // 假的 Slack 的消息 ts 从 1760000001 起按秒往后排：时钟也从这里起。
    setup(() => new Date(1_760_000_000_000));
    start();
    await connected();
    await vi.waitFor(() => expect(getChannelCatchUpMark(db, "slack")).not.toBeNull());
    slack.dropSession();
    // 断线期间：李四第一次私信用户，张三在频道的 thread 里提到用户，李四在频道里说了一句没有提到用户的话。
    slack.dm("U0LI", "断线时李四的私信");
    slack.mention("U0ZHANG", "断线时提到你", { thread: slack.messageOf(slack.chatter("U0ZHANG", "根消息")).ts });
    slack.chatter("U0LI", "没有提到你");
    await vi.waitFor(() => expect(slack.sessionConnections).toBe(2));
    await vi.waitFor(() => expect(slackEvents().map((event) => event.kind)).toEqual(["slack.dm.received", "slack.mention.received"]));
    expect(getChannelLane(db, "slack:D0LI:main")).toBeDefined();
    // 私信是 client.counts 找到的：没有消息的私信对话不读，也不用列出全部私信。
    expect(slack.sessionCalls).toEqual(expect.arrayContaining(["client.counts", "search.messages"]));
    expect(slack.sessionCalls).not.toContain("users.conversations");
    expect(slack.calls.filter((call) => call.method === "conversations.history").map((call) => call.args.channel)).not.toContain("D0ZHANG");
  });

  it("does not follow a reconnect address that is not a Slack host", async () => {
    start();
    await connected();
    slack.sessionReconnectUrl("wss://attacker.example.com/link");
    slack.dropSession();
    // gabriel 先试快速重连（被拒），再按退避（最多约 2 秒）用正常的地址重连。
    await vi.waitFor(() => expect(slack.sessionConnections).toBe(2), { timeout: 5_000 });
    expect(slack.sessionSockets.map((socket) => new URL(socket.url).hostname)).toEqual(["wss-primary.slack.com", "wss-primary.slack.com"]);
    expect(logs.join("\n")).toContain("refusing to send the Slack session cookie to attacker.example.com");
  });

  it("reports an ended session and stops trying", async () => {
    start();
    await connected();
    slack.endSession();
    await vi.waitFor(() => expect(statuses.at(-1)).toEqual({ state: "error", error: SLACK_SESSION_ENDED, reason: "signed_out" }));
    const sockets = slack.sessionSockets.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(slack.sessionSockets.length).toBe(sockets);
    const text = logs.join("\n");
    expect(text).not.toContain(FAKE_SLACK_SESSION_COOKIE);
    expect(text).not.toContain(FAKE_SLACK_SESSION_TOKEN);
  });
});

// 工单 09（规格 5.8）：浏览器会话方式下「允许 Lead 代你发消息」缺省关。关着时不往 Slack 写任何东西，读照常。
describe("the switch for sending on the user's behalf", () => {
  it("turns off every write in session mode while it is off, and says why", async () => {
    writes = false;
    expect(adapter.capabilities).toEqual({ reply: false, retract: false, edit: false, react: false, history: true, confirm: false });
    expect(adapter.writesBlocked!()).toContain("「允许 Lead 代你发消息」关着");
    expect(hub.canSendMessage("slack")).toBe(false);
    expect(hub.writesBlocked("slack")).toContain("设置 → 消息通道 → Slack");
    // 读照常：收到私信照样开卡（只是卡上不能回复）。
    const dm = slack.dm("U0ZHANG", "周五评审的材料收到了吗？");
    expect((await hub.receiveFromTransport("slack", { headers: {}, body: dm.body, transport: "socket" })).items[0])
      .toMatchObject({ kind: "slack.dm.received" });
    await hub.idle();
    expect(slack.sessionCalls.filter((method) => method.startsWith("chat.") || method.startsWith("reactions."))).toEqual([]);
    writes = true;
    expect(adapter.capabilities.reply).toBe(true);
    // 确认消息的按钮（工单 #72）只有应用方式有：会话方式没有应用收点击。
    expect(adapter.capabilities.confirm).toBe(false);
    expect(adapter.writesBlocked!()).toBeNull();
    expect(hub.canSendMessage("slack")).toBe(true);
  });

  it("is off by default, and does not touch the Slack app mode", () => {
    const session = createSlackChannelAdapter({ api: slack.api, connection: "session" });
    expect(session.capabilities.reply).toBe(false);
    const app = createSlackChannelAdapter({ api: slack.api, connection: "app", sessionWrites: () => false });
    expect(app.capabilities).toEqual({ reply: true, retract: true, edit: true, react: true, history: true, confirm: true });
    expect(app.writesBlocked!()).toBeNull();
  });
});

// 工单 05：连接方式由 daemon 给的设置决定，每次用时现读；换了方式，密钥名、设置页的检查跟着变。
describe("a connection mode that changes at run time", () => {
  it("follows the current mode for the secrets, the settings and the connection control", () => {
    let current: "app" | "session" = "app";
    const changing = createSlackChannelAdapter({ api: slack.api, connection: () => current });
    expect(changing.auth.secrets).toEqual(["PLC_SLACK_APP_TOKEN", "PLC_SLACK_USER_TOKEN"]);
    expect(changing.settings!.secrets.map((secret) => secret.name)).toEqual(["PLC_SLACK_APP_TOKEN", "PLC_SLACK_USER_TOKEN"]);
    current = "session";
    expect(changing.auth.secrets).toEqual([SLACK_SESSION_COOKIE_ENV]);
    expect(changing.settings!.secrets.map((secret) => secret.name)).toEqual([SLACK_SESSION_COOKIE_ENV]);
    const control = changing.connection!;
    expect(control.mode()).toBe("session");
    expect(control.modes.map((mode) => [mode, control.needsSignIn(mode), control.writesSwitch(mode)]))
      .toEqual([["app", false, false], ["session", true, true]]);
  });

  it("takes the mode saved in settings over config.json", () => {
    let saved: string | null = "session";
    const [slackAdapter] = builtinChannelAdapters({ slack: { api: slack.api } }, { slack: { connection: "app" } }, {
      connectionSettings: () => ({ mode: saved, writes: false }),
    });
    expect(slackAdapter!.connection!.mode()).toBe("session");
    saved = null;
    expect(slackAdapter!.connection!.mode()).toBe("app");
  });
});

// 工单 05：登录窗口。浏览器是假的：第几次看 cookie 时有了 d cookie。
describe("the sign-in window", () => {
  function fakeBrowser(input: { cookieAfter?: number; closeAfter?: number } = {}) {
    const opened: string[] = [];
    let closes = 0;
    const browser: SlackSignInBrowser = {
      async open(url) {
        opened.push(url);
        let polls = 0;
        let closeWindow!: () => void;
        const closed = new Promise<void>((resolve) => { closeWindow = resolve; });
        return {
          closed,
          async cookies() {
            polls += 1;
            if (input.closeAfter !== undefined && polls >= input.closeAfter) closeWindow();
            return input.cookieAfter !== undefined && polls >= input.cookieAfter
              ? [{ name: "b", domain: ".slack.com", value: "other" }, { name: "d", domain: ".slack.com", value: encodeURIComponent(FAKE_SLACK_SESSION_COOKIE) }]
              : [{ name: "b", domain: ".slack.com", value: "other" }];
          },
          async close() {
            closes += 1;
          },
        };
      },
    };
    return { browser, opened, closes: () => closes };
  }
  const network = () => ({ fetch: slack.sessionFetch, createWebSocket: slack.createSessionSocket, maxHttpRetries: 0 });

  it("returns the session cookie once it signs in, and closes the window", async () => {
    const fake = fakeBrowser({ cookieAfter: 3 });
    const cookie = await signInToSlack({ browser: fake.browser, network: network(), pollMs: 5 }, {
      log: (line) => logs.push(line), signal: new AbortController().signal,
    });
    expect(cookie).toBe(FAKE_SLACK_SESSION_COOKIE);
    expect(fake.opened).toEqual(["https://slack.com/signin"]);
    expect(fake.closes()).toBe(1);
    expect(logs.join("\n")).not.toContain(FAKE_SLACK_SESSION_COOKIE);
  });

  it("gives up when the user closes the window, when it times out and when it is cancelled", async () => {
    const closed = fakeBrowser({ closeAfter: 2 });
    await expect(signInToSlack({ browser: closed.browser, network: network(), pollMs: 5 }, { log: () => {}, signal: new AbortController().signal }))
      .rejects.toThrow("登录窗口关掉了");
    const slow = fakeBrowser();
    await expect(signInToSlack({ browser: slow.browser, network: network(), pollMs: 5, timeoutMs: 30 }, { log: () => {}, signal: new AbortController().signal }))
      .rejects.toThrow("还没有登录成功");
    expect(slow.closes()).toBe(1);
    const controller = new AbortController();
    const cancelled = signInToSlack({ browser: fakeBrowser().browser, network: network(), pollMs: 5 }, { log: () => {}, signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toThrow("登录取消了");
  });

  it("does not accept a d cookie that no longer signs in", async () => {
    slack.endSession();
    const fake = fakeBrowser({ cookieAfter: 1 });
    await expect(signInToSlack({ browser: fake.browser, network: network(), pollMs: 5, timeoutMs: 60 }, { log: () => {}, signal: new AbortController().signal }))
      .rejects.toThrow("还没有登录成功");
  });
});
