// 断线、daemon 重启期间的 Slack 消息（2026-11-03 的故障：断了 14 分钟，没有开着卡的会话里的消息永远收不到）。
// 重连以后的补拉以前只看有没结束的卡的道；现在还补「断线这段时间里别人发给用户的私信、提到用户的消息」：
//   - 水位（到这个时刻为止都收到了）记在库里，daemon 重启以后还在；连着时每分钟往前推，断了就不推；
//   - 从来没记过水位（第一次启动）时不补：以前的消息不能一下子开出一堆卡；
//   - 补到的消息照常经 hub 的进程内入口，按投递编号去重；频道里只要提到用户的；
//   - 有上限（时间窗、条数），超过时记日志，并且告诉 Lead 可能没补全；
//   - Slack 应用方式（Socket Mode）和浏览器会话方式都这样（会话方式的用例在 channel-slack-session.test.ts）。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { getChannelCatchUpMark, getChannelLane, listEvents, openDb, setChannelCatchUpMark, type Db } from "@pi-lead-child/store";
import { ChannelHub, ChannelRegistry, createSlackChannelAdapter, slackCatchUpWindow, type ChannelAdapter } from "../src/index.js";
import { FAKE_SLACK_USER_SCOPES, FakeSlack } from "../testing/index.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// 假的 Slack 的消息 ts 从 1760000001 起按秒往后排，和时钟无关：时钟也从这里起。
const START = new Date(1_760_000_000_000);

let dir: string;
let db: Db;
let slack: FakeSlack;
let logs: string[];
let clock: Date;
let adapter: ChannelAdapter;
let hub: ChannelHub;

function setup(limits?: { windowMs?: number; messages?: number }): void {
  adapter = createSlackChannelAdapter({
    api: slack.api, now: () => clock, socket: { createClient: slack.createSocketClient, retryBaseMs: 5, retryMaxMs: 40, catchUpSpacingMs: 0 },
    ...(limits ? { catchUp: limits } : {}),
  });
  hub = new ChannelHub({
    db, registry: new ChannelRegistry([adapter]), credentials: { credential: async () => slack.credential }, log: (line) => logs.push(line),
  });
}

function start(): void {
  adapter.transport!.start(hub.transportContext("slack"), (delivery) => hub.receiveFromTransport("slack", delivery));
}

// daemon 重启：停下传输，关掉库，再用同一个库文件建新的 hub 和适配器。
async function restart(limits?: { windowMs?: number; messages?: number }): Promise<void> {
  await adapter.transport!.stop();
  await hub.idle();
  db.close();
  db = openDb(join(dir, "plc.db"));
  setup(limits);
}

const slackEvents = () => listEvents(db, {}).filter((event) => event.source === "slack");
const texts = (kind: string) => listEvents(db, { kind }).map((event) => event.payload.text);
const marked = () => vi.waitFor(() => expect(getChannelCatchUpMark(db, "slack")).not.toBeNull());
const incomplete = () => listEvents(db, { kind: "channel.catch_up.incomplete" });

beforeEach(() => {
  dir = tempDir("plc-slack-gap-");
  db = openDb(join(dir, "plc.db"));
  clock = START;
  slack = new FakeSlack({ scopes: [...FAKE_SLACK_USER_SCOPES, "search:read"], now: () => clock });
  logs = [];
  setup();
});

afterEach(async () => {
  await adapter.transport?.stop();
  await hub.idle();
  db.close();
});

describe("catching up the gap after a reconnect", () => {
  it("brings in direct messages and mentions from conversations without an open card", async () => {
    start();
    await marked();
    expect(slackEvents()).toEqual([]);

    // 断线期间：李四第一次私信用户（没有道），张三在频道的 thread 里接连提到用户两次（搜索只给一条），李四在频道里闲聊（没有提到用户）。
    slack.dropConnection();
    slack.dm("U0LI", "断线时李四发的私信");
    const root = slack.chatter("U0ZHANG", "发布计划讨论");
    const thread = slack.messageOf(root).ts;
    slack.mention("U0ZHANG", "这里需要你确认", { thread });
    slack.mention("U0ZHANG", "还有回滚步骤", { thread });
    slack.chatter("U0LI", "午饭吃什么");
    await vi.waitFor(() => expect(slack.connections).toBe(2));

    await vi.waitFor(() => expect(slackEvents()).toHaveLength(3));
    expect(texts("slack.dm.received")).toEqual(["断线时李四发的私信"]);
    expect(texts("slack.mention.received")).toEqual([expect.stringContaining("这里需要你确认"), expect.stringContaining("还有回滚步骤")]);
    // 频道里没有提到用户的消息不补。
    expect(slackEvents().map((event) => event.payload.text)).not.toContain("午饭吃什么");
    expect(slackEvents().map((event) => event.payload.text)).not.toContain("发布计划讨论");
    // 李四的私信开了道（和实时收到的一样）。
    expect(getChannelLane(db, "slack:D0LI:main")).toBeDefined();
    expect(logs.join("\n")).toContain("caught up 3 message(s) from the gap");
    expect(incomplete()).toEqual([]);

    // 再断一次、再补一次：都不重复记。
    slack.dropConnection();
    await vi.waitFor(() => expect(slack.connections).toBe(3));
    await vi.waitFor(() => expect(slack.calls.filter((call) => call.method === "search.messages")).toHaveLength(2));
    await adapter.transport!.stop();
    await hub.idle();
    expect(slackEvents()).toHaveLength(3);
  });

  it("picks up where it left off after the daemon restarts", async () => {
    start();
    await marked();
    // daemon 停着的时候来了一条私信，Slack 不会再送。
    await adapter.transport!.stop();
    slack.dm("U0LI", "重启期间的私信");
    clock = new Date(START.getTime() + 10 * MINUTE);
    await restart();
    start();
    await vi.waitFor(() => expect(texts("slack.dm.received")).toEqual(["重启期间的私信"]));

    // 再重启一次，中间没有新消息：不重复记。
    await vi.waitFor(() => expect(logs.join("\n")).toContain("caught up 1 message(s) from the gap"));
    await restart();
    start();
    await vi.waitFor(() => expect(slack.calls.filter((call) => call.method === "search.messages")).toHaveLength(2));
    await adapter.transport!.stop();
    await hub.idle();
    expect(slackEvents()).toHaveLength(1);
  });

  it("does not pull old messages on the very first start", async () => {
    slack.dm("U0LI", "上线以前的私信");
    slack.mention("U0ZHANG", "上线以前提到你");
    start();
    await marked();
    await adapter.transport!.stop();
    await hub.idle();
    expect(slackEvents()).toEqual([]);
    expect(slack.calls.map((call) => call.method)).not.toContain("search.messages");
    expect(logs.join("\n")).toContain("no catch-up mark yet");
  });

  it("keeps the mark still while disconnected, so a long outage is caught up from where it began", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      start();
      await marked();
      const before = getChannelCatchUpMark(db, "slack")!;
      // 连着时每分钟往前推（留两分钟的余量）。
      clock = new Date(START.getTime() + 5 * MINUTE);
      vi.advanceTimersByTime(MINUTE);
      const moved = getChannelCatchUpMark(db, "slack")!;
      expect(moved.getTime()).toBe(clock.getTime() - 2 * MINUTE);
      expect(moved.getTime()).toBeGreaterThan(before.getTime());
      // 断了以后不再推（重连停在半路）：断线期间的时间不能算「收到了」。
      const release = slack.holdSocketStart();
      slack.dropConnection();
      clock = new Date(START.getTime() + 30 * MINUTE);
      vi.advanceTimersByTime(5 * MINUTE);
      expect(getChannelCatchUpMark(db, "slack")).toEqual(moved);
      // 重新连上、补完以后才接着推。
      release();
      await vi.waitFor(() => expect(getChannelCatchUpMark(db, "slack")!.getTime()).toBe(clock.getTime() - 2 * MINUTE));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the limits of the catch-up", () => {
  it("catches up only the last window of a long outage and tells Lead the rest may be missing", async () => {
    start();
    await marked();
    await adapter.transport!.stop();
    // 停了五天（时间窗缺省三天）。
    setChannelCatchUpMark(db, "slack", new Date(START.getTime() - 5 * DAY));
    slack.dm("U0LI", "五天里的私信");
    await restart();
    start();
    await vi.waitFor(() => expect(incomplete()).toHaveLength(1));
    expect(texts("slack.dm.received")).toEqual(["五天里的私信"]);
    const [notice] = incomplete();
    expect(notice).toMatchObject({ source: "system", level: "tell" });
    expect(String(notice!.payload.summary)).toContain("3 天");
    expect(logs.join("\n")).toMatch(/catch-up of the gap .* is incomplete/);
  });

  it("delivers at most the cap and tells Lead that older messages were left out", async () => {
    await restart({ messages: 3 });
    start();
    await marked();
    slack.dropConnection();
    for (const text of ["一", "二", "三", "四", "五"]) slack.dm("U0LI", text);
    await vi.waitFor(() => expect(incomplete()).toHaveLength(1));
    // 留下最新的几条。
    expect(texts("slack.dm.received")).toEqual(["三", "四", "五"]);
    expect(String(incomplete()[0]!.payload.summary)).toContain("3 条");
  });

  it("still catches up direct messages without the search scope, and says mentions were not checked", async () => {
    slack.scopes = slack.scopes.filter((scope) => scope !== "search:read");
    start();
    await marked();
    slack.dropConnection();
    slack.dm("U0LI", "没有搜索权限时的私信");
    slack.mention("U0ZHANG", "没有搜索权限时提到你", { thread: slack.messageOf(slack.chatter("U0ZHANG", "根消息")).ts });
    await vi.waitFor(() => expect(incomplete()).toHaveLength(1));
    expect(texts("slack.dm.received")).toEqual(["没有搜索权限时的私信"]);
    expect(String(incomplete()[0]!.payload.summary)).toContain("search:read");
  });
});

describe("the catch-up window", () => {
  it("starts at the mark, but no earlier than the window", () => {
    const now = new Date(START.getTime() + 10 * DAY);
    expect(slackCatchUpWindow(null, now, 3 * DAY)).toBeNull();
    expect(slackCatchUpWindow(new Date(now.getTime() - MINUTE), now, 3 * DAY)).toEqual({ from: new Date(now.getTime() - MINUTE), clipped: false });
    expect(slackCatchUpWindow(new Date(now.getTime() - 5 * DAY), now, 3 * DAY)).toEqual({ from: new Date(now.getTime() - 3 * DAY), clipped: true });
  });
});
