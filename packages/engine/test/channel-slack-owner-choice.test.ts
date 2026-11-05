// 用户自己 Slack 私信里的决定请求消息（工单 #81）：走真实的 hub、Slack 适配器和 SQLite，Slack 是假的。
//   - 问题是标题；每个选项一块（粗体选项名、说明、旁边的按钮），推荐的有标记、按钮是 primary，下面写推荐理由（工单 #82）；
//   - 选项超过 10 个或整条消息超过 50 个 block 时收起来：说明以文字列出，下面一排按钮（不超过 5 个、标签短）或下拉框；
//     按钮和下拉框都守 Slack 的数量和长度上限；要自己写回答的提示去 App 里答；
//   - 用户本人在自己私信里选的交给 daemon（ownerChoose，带对话和选项的序号），那条消息换成 daemon 给的样子；
//   - 别人选的、不在用户自己私信里的一律拒绝：不交给 daemon，记一条事件，消息不动；
//   - 同样的状态只改写一次（点击以后 hub 改、App 里答了以后 daemon 改，键一样）。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { CHANNEL_EVENT_KINDS } from "@pi-lead-child/protocol";
import { listEvents, openDb, type Db } from "@pi-lead-child/store";
import {
  ChannelHub, ChannelRegistry, createSlackChannelAdapter, ownerChoiceEditKey, SLACK_CHOOSE_ACTION, SLACK_MESSAGE_BLOCKS_MAX, SLACK_TEXT_OBJECT_MAX,
  slackChoiceBlocks, slackConfirmAction,
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
    lines: ["• 周二：赶上月初的活动"],
    options: [{ label: "周二", description: "赶上月初的活动", recommended: true }, { label: "周四", description: null, recommended: false }],
    recommendation: "推荐：周二。周四有冻结", recommendedTag: "推荐", chooseLabel: "选这个",
    pending: true, note: null, placeholder: "选一个", stateLabel: "等你决定", result: null, separator: "：",
    ...overrides,
  };
}

function content(...decisions: ChannelOwnerChoice[]): OwnerChoiceCardContent {
  return { title: "#9 发布清单：要你决定", decisions: decisions.length ? decisions : [choice()] };
}

const decided = (overrides: Partial<ChannelOwnerChoice> = {}) =>
  choice({ pending: false, lines: [], recommendation: null, stateLabel: "已决定", result: "选了「周二」", ...overrides });

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
const elementsOf = (message: { blocks?: Array<Record<string, unknown>> }) => controls(message.blocks ?? []);
// 能点的：actions 里的按钮、下拉框，和 section 旁边的按钮。
const controls = (blocks: Array<Record<string, unknown>>) => blocks.flatMap((block) => (block.type === "actions" ? block.elements as Element[]
  : block.type === "section" && block.accessory ? [block.accessory as Element] : []));
const unlabeled = (count: number) => Array.from({ length: count }, (_, index) => ({ label: `方案 ${index + 1}`, description: null, recommended: false }));
const clicks = () => listEvents(db, { kind: CHANNEL_EVENT_KINDS.ownerConfirmClicked, limit: 100 }).map((event) => event.payload as Record<string, unknown>);

describe("the blocks of a decision message", () => {
  it("puts the prompt on top as the title, under the byline and the message title", () => {
    const blocks = slackChoiceBlocks({ byline: "Red Bull", ...content() });
    expect(blocks[0]).toMatchObject({ type: "context", elements: [{ text: "Red Bull" }, { text: "*#9 发布清单：要你决定*" }] });
    expect(blocks[1]).toEqual({ type: "header", text: { type: "plain_text", text: "发布窗口选哪天？" } });
    // 太长放不进 header 的问题用粗体的 section，字不丢。
    const long = "发布窗口选哪天？".repeat(30);
    expect(slackChoiceBlocks({ byline: "Red Bull", ...content(choice({ prompt: long })) })[1])
      .toEqual({ type: "section", text: { type: "mrkdwn", text: `*${long}*` } });
  });

  it("shows each option as its own block: bold name, its consequence and a button beside it", () => {
    const blocks = slackChoiceBlocks({ byline: "Red Bull", ...content(choice({ recommendation: null, options: [
      { label: "周二", description: "赶上月初的活动", recommended: false }, { label: "周四", description: "避开冻结", recommended: false },
    ] })) });
    expect(blocks.filter((block) => block.type === "section" && block.accessory)).toEqual([
      {
        type: "section", block_id: "decision:12:option:0", text: { type: "mrkdwn", text: "*周二*\n赶上月初的活动" },
        accessory: { type: "button", action_id: `${SLACK_CHOOSE_ACTION}:0`, value: "decision:12#0", text: { type: "plain_text", text: "选这个" } },
      },
      {
        type: "section", block_id: "decision:12:option:1", text: { type: "mrkdwn", text: "*周四*\n避开冻结" },
        accessory: { type: "button", action_id: `${SLACK_CHOOSE_ACTION}:1`, value: "decision:12#1", text: { type: "plain_text", text: "选这个" } },
      },
    ]);
    expect(blocks.filter((block) => block.type === "actions")).toEqual([]);
  });

  it("shows only the name and the button for an option without a consequence", () => {
    const blocks = slackChoiceBlocks({ byline: "Red Bull", ...content(choice({ recommendation: null, lines: [], options: unlabeled(2) })) });
    expect(blocks.filter((block) => block.type === "section").map((block) => (block.text as { text: string }).text)).toEqual(["*方案 1*", "*方案 2*"]);
    expect(controls(blocks).map((button) => button.value)).toEqual(["decision:12#0", "decision:12#1"]);
  });

  it("marks the recommended option, makes its button primary and writes the reason", () => {
    const blocks = slackChoiceBlocks({ byline: "Red Bull", ...content() });
    const [tuesday, thursday] = blocks.filter((block) => block.type === "section" && block.accessory);
    expect((tuesday!.text as { text: string }).text).toBe("*周二*  ·  _推荐_\n赶上月初的活动");
    expect((tuesday!.accessory as Element).style).toBe("primary");
    expect((thursday!.text as { text: string }).text).toBe("*周四*");
    expect((thursday!.accessory as Element).style).toBeUndefined();
    expect(blocks.at(-1)).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "推荐：周二。周四有冻结" }] });
  });

  it("folds a decision with more than ten options into a dropdown with the consequences listed as text", () => {
    const many = Array.from({ length: 130 }, (_, index) => ({ label: `选项 ${index + 1}`, description: `说明 ${index + 1}`, recommended: false }));
    const blocks = slackChoiceBlocks({ byline: "Red Bull", ...content(choice({ options: many, lines: many.map((option) => `• ${option.label}：${option.description}`) })) });
    expect(controls(blocks)).toHaveLength(1);
    const [select] = controls(blocks);
    expect(select).toMatchObject({ type: "static_select", action_id: SLACK_CHOOSE_ACTION, placeholder: { text: "选一个" } });
    // 下拉框最多 100 个选项。
    expect(select!.options).toHaveLength(100);
    expect(select!.options![99]).toEqual({ text: { type: "plain_text", text: "选项 100" }, value: "decision:12#99" });
    const listed = blocks.filter((block) => block.type === "section").map((block) => (block.text as { text: string }).text);
    expect(listed.join("\n")).toContain("• 选项 1：说明 1");
    expect(listed.join("\n")).toContain("• 选项 130：说明 130");
    expect(listed.join("\n")).toContain("推荐：周二。周四有冻结");
    expect(listed.every((text) => text.length <= SLACK_TEXT_OBJECT_MAX)).toBe(true);
  });

  it("folds decisions until the message fits in 50 blocks, keeping every option choosable and every consequence listed", () => {
    const decisions = Array.from({ length: 8 }, (_, index) => choice({
      target: `decision:${index + 1}`, prompt: `问题 ${index + 1}`,
      options: Array.from({ length: 6 }, (__, option) => ({ label: `方案 ${option + 1}`, description: `后果 ${index + 1}-${option + 1}`, recommended: false })),
      lines: Array.from({ length: 6 }, (__, option) => `• 方案 ${option + 1}：后果 ${index + 1}-${option + 1}`),
    }));
    const blocks = slackChoiceBlocks({ byline: "Red Bull", ...content(...decisions) });
    expect(blocks.length).toBeLessThanOrEqual(SLACK_MESSAGE_BLOCKS_MAX);
    const text = JSON.stringify(blocks);
    // 每一个选项都还能选：一块一个按钮，或者下拉框里有它。
    const values = controls(blocks).flatMap((control) => control.options?.map((item) => item.value) ?? [control.value]);
    for (let index = 1; index <= 8; index += 1) {
      for (let option = 1; option <= 6; option += 1) expect(text).toContain(`后果 ${index}-${option}`);
      for (let option = 0; option < 6; option += 1) expect(values).toContain(`decision:${index}#${option}`);
    }
    // 放得下的仍然每个选项一块。
    expect(blocks.some((block) => block.type === "section" && block.accessory)).toBe(true);
    expect(blocks.some((block) => block.type === "actions")).toBe(true);
  });

  it("uses buttons in a row for up to five short options once folded, within Slack's limits", () => {
    const decisions = Array.from({ length: 8 }, (_, index) => choice({
      target: `decision:${index + 1}`,
      options: Array.from({ length: 5 }, (__, option) => ({ label: `${option}`.repeat(30), description: "说明", recommended: option === 0 })),
    }));
    const blocks = slackChoiceBlocks({ byline: "Red Bull", ...content(...decisions) });
    expect(blocks.length).toBeLessThanOrEqual(SLACK_MESSAGE_BLOCKS_MAX);
    const row = blocks.find((block) => block.type === "actions")!.elements as Element[];
    expect(row).toHaveLength(5);
    expect(row.every((button) => button.type === "button" && [...button.text!.text].length <= 75)).toBe(true);
    expect(row[0]!.style).toBe("primary");
  });

  it("keeps a long label whole in the text and the button within Slack's limits", () => {
    const long = "把发布推迟到下一个冻结窗口结束以后再做，先把回滚脚本补齐并且演练两次，然后通知所有相关的人".repeat(2);
    const blocks = slackChoiceBlocks({ byline: "Red Bull", ...content(choice({ options: [{ label: long, description: null, recommended: false }, ...unlabeled(1)] })) });
    expect(JSON.stringify(blocks)).toContain(long);
    expect(controls(blocks).every((button) => button.value!.length <= 150 && [...button.text!.text].length <= 75)).toBe(true);
  });

  it("tells the user to answer in the App when the decision needs a written answer", () => {
    const blocks = slackChoiceBlocks({ byline: "Red Bull", ...content(choice({ options: [], lines: [], recommendation: null, note: "这条要你写回答，去 App 里回答。" })) });
    expect(controls(blocks)).toEqual([]);
    expect(JSON.stringify(blocks)).toContain("这条要你写回答，去 App 里回答。");
  });

  it("shows the result instead of options once decided", () => {
    const blocks = slackChoiceBlocks({ byline: "Red Bull", ...content(decided()) });
    expect(controls(blocks)).toEqual([]);
    expect(JSON.stringify(blocks)).toContain("已决定");
    expect(JSON.stringify(blocks)).toContain("选了「周二」");
    expect(JSON.stringify(blocks)).not.toContain("赶上月初的活动");
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
    const options = unlabeled(11);
    await hub.sendOwnerChoices(CONVERSATION, content(choice({ options })), "push:12");
    expect(elementsOf(inDm()[0]!)[0]!.type).toBe("static_select");
    await hub.receiveFromTransport("slack", slack.select(inDm()[0]!, { index: 10 }));
    expect(asked.map((click) => click.option)).toEqual([10]);
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
