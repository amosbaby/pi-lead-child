// 用户自己 Slack 私信里的决定请求消息（工单 #81）：走真实的 hub、Slack 适配器和 SQLite，Slack 是假的。
//   - 选项不超过 5 个、标签短时是按钮（推荐的用 primary），否则是下拉框；按钮和下拉框都守 Slack 的数量和长度上限；
//     后果和推荐理由写进正文；要自己写回答的提示去 App 里答；
//   - 用户本人在自己私信里选的交给 daemon（ownerChoose，带对话和选项的序号），那条消息换成 daemon 给的样子；
//   - 别人选的、不在用户自己私信里的一律拒绝：不交给 daemon，记一条事件，消息不动；
//   - 同样的状态只改写一次（点击以后 hub 改、App 里答了以后 daemon 改，键一样）。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { CHANNEL_EVENT_KINDS } from "@pi-lead-child/protocol";
import { listEvents, openDb, type Db } from "@pi-lead-child/store";
import {
  ChannelHub, ChannelRegistry, createSlackChannelAdapter, ownerChoiceEditKey, SLACK_CHOOSE_ACTION, slackChoiceBlocks, slackConfirmAction,
  type ChannelOwnerChoice, type ChannelOwnerChooseRequest, type OwnerChoiceCardContent,
} from "../src/index.js";
import { FakeSlack } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let clock: Date;
let logs: string[];

beforeEach(() => {
  db = openDb(join(tempDir("plc-slack-owner-choice-"), "plc.db"));
  clock = new Date("2026-11-05T10:00:00.000Z");
  slack = new FakeSlack({ now: () => clock });
  logs = [];
});

afterEach(() => {
  db.close();
});

const SELF_DM = "D0SELF";
const CONVERSATION = `slack:${SELF_DM}:main`;

function choice(overrides: Partial<ChannelOwnerChoice> = {}): ChannelOwnerChoice {
  return {
    target: "decision:12", prompt: "发布窗口选哪天？",
    lines: ["• 周二：赶上月初的活动", "推荐：周二。周四有冻结"],
    options: [{ label: "周二", recommended: true }, { label: "周四", recommended: false }],
    pending: true, note: null, placeholder: "选一个", stateLabel: "等你决定", result: null, separator: "：",
    ...overrides,
  };
}

function content(...decisions: ChannelOwnerChoice[]): OwnerChoiceCardContent {
  return { title: "#9 发布清单：要你决定", decisions: decisions.length ? decisions : [choice()] };
}

const decided = (overrides: Partial<ChannelOwnerChoice> = {}) =>
  choice({ pending: false, lines: [], stateLabel: "已决定", result: "选了「周二」", ...overrides });

function setup(options: { ownerChoose?: (click: ChannelOwnerChooseRequest) => Promise<OwnerChoiceCardContent | null>; connection?: "app" | "session" } = {}) {
  const adapter = createSlackChannelAdapter({
    api: slack.api, now: () => clock, connection: options.connection ?? "app", sessionWrites: () => true,
  });
  return new ChannelHub({
    db, registry: new ChannelRegistry([adapter]),
    credentials: { credential: async () => ({ ...slack.credential, team: { id: "T0HOME", name: "Acme" } }) }, now: () => clock,
    log: (line) => logs.push(line), assistantName: () => "Red Bull",
    ...(options.ownerChoose ? { ownerChoose: options.ownerChoose } : {}),
  });
}

const inDm = (channel = SELF_DM) => slack.messages.filter((message) => message.channel === channel);
type Element = { type: string; action_id: string; value?: string; style?: string; text?: { text: string }; options?: Array<{ text: { text: string }; value: string }> };
const elementsOf = (message: { blocks?: Array<Record<string, unknown>> }) => (message.blocks ?? [])
  .filter((block) => block.type === "actions").flatMap((block) => block.elements as Element[]);
const clicks = () => listEvents(db, { kind: CHANNEL_EVENT_KINDS.ownerConfirmClicked, limit: 100 }).map((event) => event.payload as Record<string, unknown>);

describe("the blocks of a decision message", () => {
  it("uses buttons for up to five short options, with the recommended one primary and the reasons in the text", () => {
    const blocks = slackChoiceBlocks({ byline: "Red Bull", ...content() });
    const [actions] = blocks.filter((block) => block.type === "actions");
    expect(actions!.elements).toEqual([
      { type: "button", action_id: `${SLACK_CHOOSE_ACTION}:0`, value: "decision:12#0", text: { type: "plain_text", text: "周二" }, style: "primary" },
      { type: "button", action_id: `${SLACK_CHOOSE_ACTION}:1`, value: "decision:12#1", text: { type: "plain_text", text: "周四" } },
    ]);
    const text = JSON.stringify(blocks);
    expect(text).toContain("发布窗口选哪天？");
    expect(text).toContain("周二：赶上月初的活动");
    expect(text).toContain("推荐：周二。周四有冻结");
  });

  it("switches to a dropdown for more than five options or a long label, within Slack's limits", () => {
    const many = Array.from({ length: 130 }, (_, index) => ({ label: `选项 ${index + 1}`, recommended: false }));
    const [select] = slackChoiceBlocks({ byline: "Red Bull", ...content(choice({ options: many })) })
      .filter((block) => block.type === "actions").flatMap((block) => block.elements as Element[]);
    expect(select).toMatchObject({ type: "static_select", action_id: SLACK_CHOOSE_ACTION, placeholder: { text: "选一个" } });
    // 下拉框最多 100 个选项。
    expect(select!.options).toHaveLength(100);
    expect(select!.options![99]).toEqual({ text: { type: "plain_text", text: "选项 100" }, value: "decision:12#99" });

    const long = "把发布推迟到下一个冻结窗口结束以后再做，先把回滚脚本补齐并且演练两次，然后通知所有相关的人".repeat(2);
    const [dropdown] = slackChoiceBlocks({ byline: "Red Bull", ...content(choice({ options: [{ label: long, recommended: false }, { label: "现在发", recommended: true }] })) })
      .filter((block) => block.type === "actions").flatMap((block) => block.elements as Element[]);
    expect(dropdown!.type).toBe("static_select");
    // 选项的字最多 75 个，value 只放序号（远短于 150）。
    expect([...dropdown!.options![0]!.text.text].length).toBe(75);
    expect(dropdown!.options!.every((option) => option.value.length <= 150)).toBe(true);
  });

  it("keeps button labels within 75 characters and the number of buttons within 25 when buttons are used", () => {
    const blocks = slackChoiceBlocks({ byline: "Red Bull", ...content(choice({ options: Array.from({ length: 5 }, (_, index) => ({ label: `${index}`.repeat(30), recommended: false })) })) });
    const buttons = blocks.filter((block) => block.type === "actions").flatMap((block) => block.elements as Element[]);
    expect(buttons).toHaveLength(5);
    expect(buttons.every((button) => button.type === "button" && [...button.text!.text].length <= 75)).toBe(true);
  });

  it("tells the user to answer in the App when the decision needs a written answer", () => {
    const blocks = slackChoiceBlocks({ byline: "Red Bull", ...content(choice({ options: [], note: "这条要你写回答，去 App 里回答。" })) });
    expect(blocks.filter((block) => block.type === "actions")).toEqual([]);
    expect(JSON.stringify(blocks)).toContain("这条要你写回答，去 App 里回答。");
  });

  it("shows the result instead of options once decided", () => {
    const blocks = slackChoiceBlocks({ byline: "Red Bull", ...content(decided()) });
    expect(blocks.filter((block) => block.type === "actions")).toEqual([]);
    expect(JSON.stringify(blocks)).toContain("已决定");
    expect(JSON.stringify(blocks)).toContain("选了「周二」");
  });
});

describe("reading a choice from Slack's callback", () => {
  it("reads a button and a dropdown, and rejects a value that is not ours", () => {
    const base = { type: "block_actions", user: { id: "U1" }, container: { channel_id: SELF_DM, message_ts: "1.1" } };
    expect(slackConfirmAction(JSON.stringify({ ...base, actions: [{ action_id: `${SLACK_CHOOSE_ACTION}:1`, value: "decision:12#1" }] })))
      .toMatchObject({ target: "decision:12", decision: "choose", option: 1, channel: SELF_DM, ts: "1.1" });
    expect(slackConfirmAction(JSON.stringify({ ...base, actions: [{ action_id: SLACK_CHOOSE_ACTION, selected_option: { value: "decision:12#7" } }] })))
      .toMatchObject({ target: "decision:12", decision: "choose", option: 7 });
    expect(slackConfirmAction(JSON.stringify({ ...base, actions: [{ action_id: SLACK_CHOOSE_ACTION, selected_option: { value: "rule_change:x#1" } }] }))).toBeNull();
    expect(slackConfirmAction(JSON.stringify({ ...base, actions: [{ action_id: `${SLACK_CHOOSE_ACTION}:0`, value: "decision:12" }] }))).toBeNull();
  });
});

describe("a decision message in the user's own Slack DM", () => {
  it("posts once per key and hands the user's own button click to the daemon, then shows what the daemon returns", async () => {
    const asked: ChannelOwnerChooseRequest[] = [];
    const hub = setup({ ownerChoose: async (click) => { asked.push(click); return content(decided()); } });
    const sent = await hub.sendOwnerChoices(CONVERSATION, content(), "push:12");
    expect(sent).toEqual({ status: "sent", remoteRef: { channel: SELF_DM, ts: inDm()[0]!.ts } });
    expect(await hub.sendOwnerChoices(CONVERSATION, content(), "push:12")).toMatchObject({ status: "already_sent" });
    expect(inDm()).toHaveLength(1);

    const result = await hub.receiveFromTransport("slack", slack.click(inDm()[0]!, `${SLACK_CHOOSE_ACTION}:0`));
    expect(result).toEqual({ accepted: true, items: [] });
    expect(asked).toEqual([{ source: "slack", account: slack.self.id, conversation: CONVERSATION, target: "decision:12", option: 0 }]);
    expect(elementsOf(inDm()[0]!)).toEqual([]);
    expect(JSON.stringify(inDm()[0]!.blocks)).toContain("选了「周二」");
    expect(clicks()).toEqual([expect.objectContaining({
      channel: "slack", target: "decision:12", decision: "choose", option: 0, by: slack.self.id, accepted: true, refusal: null, state: "已决定",
    })]);
    // 没有记成通道的消息事件，也没开卡。
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE source = 'slack'").get()).toEqual({ n: 0 });
  });

  it("hands a dropdown choice over with the option's position", async () => {
    const asked: ChannelOwnerChooseRequest[] = [];
    const hub = setup({ ownerChoose: async (click) => { asked.push(click); return content(decided()); } });
    const options = Array.from({ length: 7 }, (_, index) => ({ label: `方案 ${index + 1}`, recommended: false }));
    await hub.sendOwnerChoices(CONVERSATION, content(choice({ options })), "push:12");
    expect(elementsOf(inDm()[0]!)[0]!.type).toBe("static_select");
    await hub.receiveFromTransport("slack", slack.select(inDm()[0]!, { index: 6 }));
    expect(asked.map((click) => click.option)).toEqual([6]);
  });

  it("refuses and records a choice by someone else or outside the user's own DM, without asking the daemon", async () => {
    const asked: ChannelOwnerChooseRequest[] = [];
    const hub = setup({ ownerChoose: async (click) => { asked.push(click); return content(decided()); } });
    await hub.sendOwnerChoices(CONVERSATION, content(), "push:12");
    await hub.sendOwnerChoices("slack:D0ZHANG:main", content(), "push:12-other");
    const before = JSON.stringify(inDm()[0]!.blocks);
    await hub.receiveFromTransport("slack", slack.click(inDm()[0]!, `${SLACK_CHOOSE_ACTION}:0`, { user: "U0MALLORY" }));
    await hub.receiveFromTransport("slack", slack.click(inDm()[0]!, `${SLACK_CHOOSE_ACTION}:1`, { team: "T0OTHER" }));
    await hub.receiveFromTransport("slack", slack.click(inDm("D0ZHANG")[0]!, `${SLACK_CHOOSE_ACTION}:1`));
    expect(asked).toEqual([]);
    expect(JSON.stringify(inDm()[0]!.blocks)).toBe(before);
    expect(clicks()).toEqual([
      expect.objectContaining({ by: "U0MALLORY", decision: "choose", option: 0, accepted: false, refusal: "not_owner", target: "decision:12" }),
      expect.objectContaining({ by: slack.self.id, accepted: false, refusal: "not_owner" }),
      expect.objectContaining({ accepted: false, refusal: "not_own_conversation", option: 1 }),
    ]);
    expect(logs.some((line) => line.includes("refused a button click") && line.includes("U0MALLORY"))).toBe(true);
  });

  it("records an unknown decision as refused and leaves the options", async () => {
    const hub = setup({ ownerChoose: async () => null });
    await hub.sendOwnerChoices(CONVERSATION, content(), "push:12");
    await hub.receiveFromTransport("slack", slack.click(inDm()[0]!, `${SLACK_CHOOSE_ACTION}:0`));
    expect(clicks()).toEqual([expect.objectContaining({ accepted: false, refusal: "unknown_target" })]);
    expect(elementsOf(inDm()[0]!)).toHaveLength(2);
  });

  it("rewrites a message once per state, whether the click or the App answered first", async () => {
    const hub = setup({ ownerChoose: async () => content(decided(), choice({ target: "decision:13" })) });
    const sent = await hub.sendOwnerChoices(CONVERSATION, content(choice(), choice({ target: "decision:13" })), "push:12");
    // 两条决定请求在同一条消息里，各有自己的选项。
    expect(elementsOf(inDm()[0]!).map((element) => element.value)).toEqual(["decision:12#0", "decision:12#1", "decision:13#0", "decision:13#1"]);
    await hub.receiveFromTransport("slack", slack.click(inDm()[0]!, `${SLACK_CHOOSE_ACTION}:0`));
    const edits = inDm()[0]!.edits ?? 0;
    // daemon 随后按同样的状态改写（例如这一拍看到了 App 里的变化）：同一个键，不再改。
    expect(await hub.editOwnerChoices(CONVERSATION, sent!.remoteRef, content(decided(), choice({ target: "decision:13" }))))
      .toEqual({ status: "already_sent" });
    expect(inDm()[0]!.edits).toBe(edits);
    // 第二条在 App 里答了：状态变了，再改一次。
    expect(await hub.editOwnerChoices(CONVERSATION, sent!.remoteRef, content(decided(), decided({ target: "decision:13", result: "选了「周四」" }))))
      .toEqual({ status: "sent" });
    expect(inDm()[0]!.edits).toBe(edits + 1);
    expect(elementsOf(inDm()[0]!)).toEqual([]);
    expect(ownerChoiceEditKey({ channel: "C", ts: "1" }, content(choice()))).not.toBe(ownerChoiceEditKey({ channel: "C", ts: "1" }, content(decided())));
  });

  it("does not post options over a browser session: no app would receive the click", async () => {
    const hub = setup({ connection: "session" });
    expect(await hub.sendOwnerChoices(CONVERSATION, content(), "push:12")).toBeNull();
    expect(inDm()).toHaveLength(0);
  });
});
