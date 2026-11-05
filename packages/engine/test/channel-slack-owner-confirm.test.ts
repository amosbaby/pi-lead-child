// 用户自己 Slack 私信里的确认消息（工单 #72）：走真实的 hub、Slack 适配器和 SQLite，Slack 是假的。
//   - 发到用户自己私信里的确认消息带「确认这一次」「不改」两个按钮，写清标题、原因和参数（命令整条显示）；同一个键只发一次；
//   - 用户本人在自己私信里点的交给 daemon（ownerConfirm），那条消息换成结果、不再带按钮；
//   - 别人点的、不在用户自己私信里的、签名不对的一律拒绝：不交给 daemon，记一条事件，消息不动；
//   - 浏览器会话方式没有应用收点击：不发按钮。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { CHANNEL_EVENT_KINDS } from "@pi-lead-child/protocol";
import { listEvents, openDb, type Db } from "@pi-lead-child/store";
import {
  ChannelHub, ChannelRegistry, createSlackChannelAdapter, SLACK_CONFIRM_ACTION, SLACK_DECLINE_ACTION,
  type ChannelOwnerConfirmRequest, type OwnerConfirmCardContent,
} from "../src/index.js";
import { FakeSlack } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let clock: Date;
let logs: string[];

beforeEach(() => {
  db = openDb(join(tempDir("plc-slack-owner-confirm-"), "plc.db"));
  clock = new Date("2026-11-05T10:00:00.000Z");
  slack = new FakeSlack({ now: () => clock });
  logs = [];
});

afterEach(() => {
  db.close();
});

const SELF_DM = "D0SELF";
const TARGET = "rule_change:rcc_abcdefgh1234";
const COMMAND = "git -C /Users/alice/src/acme push origin plc/item-9 && echo 'done <ok>'";

function content(state: "pending" | "done" | "declined" | "expired"): OwnerConfirmCardContent {
  const words = { pending: "等你确认", done: "已执行", declined: "没有改", expired: "已过期" } as const;
  return {
    target: TARGET, title: "Red Bull 要在你的 Mac 上跑一条命令",
    facts: [{ label: "原因", value: "推送分支要你的 git 凭据" }, { label: "被拦", value: "沙箱里没有 git 凭据" }],
    params: [{ name: "command", value: COMMAND }, { name: "cwd", value: "/Users/alice" }],
    pending: state === "pending", confirmLabel: "确认这一次", declineLabel: "不改", separator: "：",
    stateLabel: words[state], result: state === "done" ? "exit 0" : state === "declined" ? "你点了「不改」，规则照旧。" : null,
  };
}

function setup(options: { ownerConfirm?: (click: ChannelOwnerConfirmRequest) => Promise<OwnerConfirmCardContent | null>; connection?: "app" | "session" } = {}) {
  const adapter = createSlackChannelAdapter({
    api: slack.api, now: () => clock, connection: options.connection ?? "app", sessionWrites: () => true,
  });
  return new ChannelHub({
    db, registry: new ChannelRegistry([adapter]), // 和真的 resolveCredential 一样带上 auth.test 给的工作区（假 Slack 缺省的工作区是 T0HOME）。
    credentials: { credential: async () => ({ ...slack.credential, team: { id: "T0HOME", name: "Acme" } }) }, now: () => clock,
    log: (line) => logs.push(line), assistantName: () => "Red Bull",
    ...(options.ownerConfirm ? { ownerConfirm: options.ownerConfirm } : {}),
  });
}

const inDm = (channel = SELF_DM) => slack.messages.filter((message) => message.channel === channel);
const buttonsOf = (message: { blocks?: Array<Record<string, unknown>> }) => (message.blocks ?? [])
  .filter((block) => block.type === "actions").flatMap((block) => block.elements as Array<{ action_id: string; value: string; text: { text: string } }>);
const clicks = () => listEvents(db, { kind: CHANNEL_EVENT_KINDS.ownerConfirmClicked, limit: 100 }).map((event) => event.payload as Record<string, unknown>);

describe("a confirmation in the user's own Slack DM", () => {
  it("posts the title, reason and the whole command with the two buttons, once per key", async () => {
    const hub = setup();
    expect(await hub.sendOwnerConfirmation(`slack:${SELF_DM}:main`, content("pending"), "k1")).toEqual({ status: "sent" });
    const [message] = inDm();
    expect(message).toBeDefined();
    const texts = JSON.stringify(message!.blocks);
    expect(texts).toContain("Red Bull 要在你的 Mac 上跑一条命令");
    expect(texts).toContain("推送分支要你的 git 凭据");
    // 命令整条在代码块里（& < > 按 Slack 的规则转义）。
    expect(texts).toContain("git -C /Users/alice/src/acme push origin plc/item-9 &amp;&amp; echo 'done &lt;ok&gt;'");
    expect(buttonsOf(message!)).toEqual([
      expect.objectContaining({ action_id: SLACK_CONFIRM_ACTION, value: TARGET, text: expect.objectContaining({ text: "确认这一次" }) }),
      expect.objectContaining({ action_id: SLACK_DECLINE_ACTION, value: TARGET, text: expect.objectContaining({ text: "不改" }) }),
    ]);
    expect(message!.text).toContain("等你确认");
    // 同一个键再发：不发第二条。
    expect(await hub.sendOwnerConfirmation(`slack:${SELF_DM}:main`, content("pending"), "k1")).toEqual({ status: "already_sent" });
    expect(inDm()).toHaveLength(1);
  });

  it("does not post buttons over a browser session: no app would receive the click", async () => {
    const hub = setup({ connection: "session" });
    expect(await hub.sendOwnerConfirmation(`slack:${SELF_DM}:main`, content("pending"), "k1")).toBeNull();
    expect(inDm()).toHaveLength(0);
  });

  it("hands the user's own click to the daemon and replaces the buttons with the result", async () => {
    const asked: ChannelOwnerConfirmRequest[] = [];
    const hub = setup({ ownerConfirm: async (click) => { asked.push(click); return content("done"); } });
    await hub.sendOwnerConfirmation(`slack:${SELF_DM}:main`, content("pending"), "k1");
    const result = await hub.receiveFromTransport("slack", slack.click(inDm()[0]!, SLACK_CONFIRM_ACTION));
    expect(result).toEqual({ accepted: true, items: [] });
    expect(asked).toEqual([{ source: "slack", account: slack.self.id, target: TARGET, decision: "confirm" }]);
    const [message] = inDm();
    expect(buttonsOf(message!)).toEqual([]);
    expect(JSON.stringify(message!.blocks)).toContain("已执行");
    expect(JSON.stringify(message!.blocks)).toContain("exit 0");
    expect(clicks()).toEqual([expect.objectContaining({
      channel: "slack", target: TARGET, decision: "confirm", by: slack.self.id, accepted: true, refusal: null, state: "已执行",
    })]);
    // 没有记成通道的消息事件，也没开卡。
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE source = 'slack'").get()).toEqual({ n: 0 });
  });

  it("passes 不改 through as decline", async () => {
    const asked: ChannelOwnerConfirmRequest[] = [];
    const hub = setup({ ownerConfirm: async (click) => { asked.push(click); return content("declined"); } });
    await hub.sendOwnerConfirmation(`slack:${SELF_DM}:main`, content("pending"), "k1");
    await hub.receiveFromTransport("slack", slack.click(inDm()[0]!, SLACK_DECLINE_ACTION));
    expect(asked.map((click) => click.decision)).toEqual(["decline"]);
    expect(buttonsOf(inDm()[0]!)).toEqual([]);
    expect(JSON.stringify(inDm()[0]!.blocks)).toContain("没有改");
  });

  it("refuses and records a click by someone else, without asking the daemon or touching the message", async () => {
    const asked: ChannelOwnerConfirmRequest[] = [];
    const hub = setup({ ownerConfirm: async (click) => { asked.push(click); return content("done"); } });
    await hub.sendOwnerConfirmation(`slack:${SELF_DM}:main`, content("pending"), "k1");
    const before = JSON.stringify(inDm()[0]!.blocks);
    await hub.receiveFromTransport("slack", slack.click(inDm()[0]!, SLACK_CONFIRM_ACTION, { user: "U0MALLORY" }));
    // 同一个编号、另一个工作区的人也不算本人。
    await hub.receiveFromTransport("slack", slack.click(inDm()[0]!, SLACK_CONFIRM_ACTION, { team: "T0OTHER" }));
    expect(asked).toEqual([]);
    expect(JSON.stringify(inDm()[0]!.blocks)).toBe(before);
    expect(clicks()).toEqual([
      expect.objectContaining({ by: "U0MALLORY", accepted: false, refusal: "not_owner", state: null, target: TARGET }),
      expect.objectContaining({ by: slack.self.id, accepted: false, refusal: "not_owner" }),
    ]);
    expect(logs.some((line) => line.includes("refused a button click") && line.includes("U0MALLORY"))).toBe(true);
  });

  it("refuses a click on a confirmation that is not in the user's own DM", async () => {
    const asked: ChannelOwnerConfirmRequest[] = [];
    const hub = setup({ ownerConfirm: async (click) => { asked.push(click); return content("done"); } });
    // 发到和别人的私信里（系统不会这样发，这里模拟被转贴的按钮）。
    await hub.sendOwnerConfirmation("slack:D0ZHANG:main", content("pending"), "k2");
    await hub.receiveFromTransport("slack", slack.click(inDm("D0ZHANG")[0]!, SLACK_CONFIRM_ACTION));
    expect(asked).toEqual([]);
    expect(clicks()).toEqual([expect.objectContaining({ accepted: false, refusal: "not_own_conversation" })]);
  });

  it("checks Slack's signature on a click pushed over HTTP", async () => {
    const asked: ChannelOwnerConfirmRequest[] = [];
    const hub = setup({ ownerConfirm: async (click) => { asked.push(click); return content("done"); } });
    await hub.sendOwnerConfirmation(`slack:${SELF_DM}:main`, content("pending"), "k1");
    const signed = slack.click(inDm()[0]!, SLACK_CONFIRM_ACTION, { form: true });
    const forged = { headers: { ...signed.headers, "x-slack-signature": `v0=${"0".repeat(64)}` }, body: signed.body };
    expect(await hub.receive("slack", forged)).toMatchObject({ accepted: false, rejection: "unauthenticated" });
    expect(asked).toEqual([]);
    expect(await hub.receive("slack", signed)).toEqual({ accepted: true, items: [] });
    expect(asked.map((click) => click.decision)).toEqual(["confirm"]);
  });

  it("shows the current state when the confirmation was already handled or expired, without running anything", async () => {
    let calls = 0;
    const hub = setup({ ownerConfirm: async () => { calls += 1; return content("expired"); } });
    await hub.sendOwnerConfirmation(`slack:${SELF_DM}:main`, content("pending"), "k1");
    const message = inDm()[0]!;
    const click = slack.click(message, SLACK_CONFIRM_ACTION);
    await hub.receiveFromTransport("slack", click);
    expect(JSON.stringify(inDm()[0]!.blocks)).toContain("已过期");
    expect(buttonsOf(inDm()[0]!)).toEqual([]);
    // 再点一次（例如旧客户端还显示着按钮）：daemon 只回状态，同一个状态不再改写消息。
    const edits = inDm()[0]!.edits;
    await hub.receiveFromTransport("slack", click);
    expect(calls).toBe(2);
    expect(inDm()[0]!.edits).toBe(edits);
  });

  it("records an unknown confirmation as refused", async () => {
    const hub = setup({ ownerConfirm: async () => null });
    await hub.sendOwnerConfirmation(`slack:${SELF_DM}:main`, content("pending"), "k1");
    await hub.receiveFromTransport("slack", slack.click(inDm()[0]!, SLACK_CONFIRM_ACTION));
    expect(clicks()).toEqual([expect.objectContaining({ accepted: false, refusal: "unknown_target" })]);
    expect(buttonsOf(inDm()[0]!)).toHaveLength(2);
  });
});
