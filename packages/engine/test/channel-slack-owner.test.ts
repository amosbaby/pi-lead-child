// 用户发给自己的 Slack 私信（用户 2026-10-30：「直接交给 Lead，并且只要确认是我本人，就跟 companion 的权限保持一致，
// 只是 reply 要遵循 slack 的语法规范」）。走真实的 hub 和 SQLite，Slack 是假的：
//   - 只有用户本人发在「对方是自己」的私信里的话交给 daemon（ChannelHubOptions.owner），不记成通道的事件；
//   - 发给别人的私信、推回来的回复照旧；
//   - daemon 不收时照用户本人的话处理；
//   - 回复按 Slack 的 mrkdwn 发回那条私信，推回来时认成 echo，不会再交给 Lead；
//   - 回复包在带色条的 attachment 里，色条里第一行是 Lead 的名字，和用户自己的话分开（用户 2026-11-05）；太长时拆成几条，每条都带色条。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "@pi-lead-child/store";
import {
  ChannelHub, ChannelRegistry, createSlackChannelAdapter, SLACK_OWNER_REPLY_COLOR, slackMrkdwnFromMarkdown, type ChannelOwnerMessage,
} from "../src/index.js";
import { FakeSlack } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let clock: Date;
let logs: string[];
let leadName: string;

beforeEach(() => {
  leadName = "Fairy";
  db = openDb(join(tempDir("plc-slack-owner-"), "plc.db"));
  clock = new Date("2026-10-30T10:00:00.000Z");
  slack = new FakeSlack({ now: () => clock });
  logs = [];
});

afterEach(() => {
  db.close();
});

function setup(owner?: (message: ChannelOwnerMessage) => boolean): ChannelHub {
  const adapter = createSlackChannelAdapter({ api: slack.api, now: () => clock });
  return new ChannelHub({
    db, registry: new ChannelRegistry([adapter]), credentials: { credential: async () => slack.credential }, now: () => clock,
    log: (line) => logs.push(line), assistantName: () => leadName, ...(owner ? { owner } : {}),
  });
}

const SELF_DM = "D0SELF";

describe("the user's own Slack DM to themself", () => {
  it("hands the message to the daemon as the user's own words, and records no channel event", async () => {
    const handed: ChannelOwnerMessage[] = [];
    const hub = setup((message) => {
      handed.push(message);
      return true;
    });
    const result = await hub.receive("slack", slack.selfReply(SELF_DM, "帮我看下 <#C0PROJ> 今天的发布"));
    expect(result.items).toEqual([expect.objectContaining({ role: "owner", handedTo: "owner", seq: null, objectKey: `slack:${SELF_DM}:main` })]);
    expect(handed).toEqual([expect.objectContaining({
      source: "slack", account: slack.self.id, accountName: slack.self.name, conversation: `slack:${SELF_DM}:main`,
      text: "帮我看下 #proj-x 今天的发布",
    })]);
    expect(handed[0]!.deliveryId).toMatch(/^D0SELF:/u);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE source = 'slack'").get()).toEqual({ n: 0 });
  });

  it("keeps the old handling for the user's words to someone else, and when the daemon does not take it", async () => {
    const handed: ChannelOwnerMessage[] = [];
    const hub = setup((message) => {
      handed.push(message);
      return false;
    });
    // 发给张三的私信：用户本人的话，不是写给 Lead 的。
    const toZhang = await hub.receive("slack", slack.selfReply("D0ZHANG", "好的，我下午看"));
    expect(toZhang.items[0]).toMatchObject({ role: "self_reply", ignored: "no_lane" });
    // daemon 不收（例如用户撤销了这个入口）：照用户本人的话处理，和以前一样。
    const refused = await hub.receive("slack", slack.selfReply(SELF_DM, "备忘：周五续费"));
    expect(refused.items[0]).toMatchObject({ role: "self_reply", ignored: "no_lane" });
    expect(handed.map((message) => message.text)).toEqual(["备忘：周五续费"]);
    // 没有 daemon 的回调：也照旧。
    const plain = await setup().receive("slack", slack.selfReply(SELF_DM, "再记一条"));
    expect(plain.items[0]).toMatchObject({ role: "self_reply", ignored: "no_lane" });
  });

  it("replies in Slack mrkdwn with Lead's name, once per key, and does not hand the echo back to Lead", async () => {
    const handed: ChannelOwnerMessage[] = [];
    const hub = setup((message) => {
      handed.push(message);
      return true;
    });
    const sent = await hub.replyToOwner(`slack:${SELF_DM}:main`, "## 结论\n**今天不发布**，见 [日历](https://cal.test/x)。", "turn_1");
    expect(sent).toEqual({ objectKey: `slack:${SELF_DM}:main`, status: "sent" });
    const posted = slack.messages.filter((message) => message.channel === SELF_DM);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text).toBe(":robot_face: Fairy (Assistant)\n*结论*\n*今天不发布*，见 <https://cal.test/x|日历>。");
    expect(posted[0]!.attachments).toEqual([{
      color: SLACK_OWNER_REPLY_COLOR, fallback: posted[0]!.text,
      blocks: [
        { type: "context", elements: [{ type: "mrkdwn", text: ":robot_face: Fairy (Assistant)" }] },
        { type: "section", text: { type: "mrkdwn", text: "*结论*\n*今天不发布*，见 <https://cal.test/x|日历>。" } },
      ],
    }]);
    expect(posted[0]!.blocks).toBeUndefined();
    // 同一个键再发一次（例如 daemon 重试）：不发第二条。
    expect(await hub.replyToOwner(`slack:${SELF_DM}:main`, "别的", "turn_1")).toMatchObject({ status: "already_sent" });
    expect(slack.messages.filter((message) => message.channel === SELF_DM)).toHaveLength(1);
    // Slack 把这条回复推回来：是系统发的，不是用户写给 Lead 的话。
    const echo = await hub.receive("slack", slack.echoOf(posted[0]!));
    expect(echo.items[0]).toMatchObject({ role: "echo" });
    expect(handed).toHaveLength(0);
  });
});

describe("how Lead's reply to the user's own DM looks", () => {
  const ownerHub = () => setup(() => true);
  const inSelfDm = () => slack.messages.filter((message) => message.channel === SELF_DM);
  type Bar = { color: string; fallback: string; blocks: Array<{ type: string; text?: { text: string }; elements?: Array<{ text: string }> }> };
  const barOf = (message: { attachments?: unknown[] }) => (message.attachments as Bar[] | undefined)?.[0];

  it("splits a long reply at Slack's limit into several messages, each with the bar and the name", async () => {
    // 两段各 2000 个字：合起来超过一个 section 的 3000 个字。
    const first = "甲".repeat(2_000);
    const second = "乙".repeat(2_000);
    const sent = await ownerHub().replyToOwner(`slack:${SELF_DM}:main`, `${first}\n${second}`, "turn_long");
    expect(sent.status).toBe("sent");
    const posted = inSelfDm();
    expect(posted).toHaveLength(2);
    expect(posted.map((message) => message.text)).toEqual([`:robot_face: Fairy (Assistant)\n${first}`, `:robot_face: Fairy (Assistant)\n${second}`]);
    for (const message of posted) {
      const bar = barOf(message)!;
      expect(bar.color).toBe(SLACK_OWNER_REPLY_COLOR);
      expect(bar.fallback).toBe(message.text);
      expect(bar.blocks[0]).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: ":robot_face: Fairy (Assistant)" }] });
      expect(bar.blocks.slice(1).every((block) => block.type === "section" && block.text!.text.length <= 3_000)).toBe(true);
    }
    // 每一条都带自己的幂等键；重试时不会多发。
    expect(posted.map((message) => message.metadata?.event_payload.idempotency_key)).toEqual(["owner:turn_long", "owner:turn_long#2"]);
    expect(await ownerHub().replyToOwner(`slack:${SELF_DM}:main`, `${first}\n${second}`, "turn_long")).toMatchObject({ status: "already_sent" });
    expect(inSelfDm()).toHaveLength(2);
    // 推回来的每一条都认成 echo。
    const hub = ownerHub();
    for (const message of posted) expect((await hub.receive("slack", slack.echoOf(message))).items[0]).toMatchObject({ role: "echo" });
  });

  it("finishes the missing parts of a long reply when the first try broke off", async () => {
    const body = `${"甲".repeat(2_000)}\n${"乙".repeat(2_000)}`;
    slack.crashAfterNextPost();
    await expect(ownerHub().replyToOwner(`slack:${SELF_DM}:main`, body, "turn_crash")).rejects.toMatchObject({ code: "outbound_failed" });
    expect(inSelfDm()).toHaveLength(1);
    expect(await ownerHub().replyToOwner(`slack:${SELF_DM}:main`, body, "turn_crash")).toMatchObject({ status: "sent" });
    expect(inSelfDm().map((message) => message.metadata?.event_payload.idempotency_key)).toEqual(["owner:turn_crash", "owner:turn_crash#2"]);
  });

  it("reads Lead's name from the identity setting each time", async () => {
    const hub = ownerHub();
    leadName = "Red Bull";
    await hub.replyToOwner(`slack:${SELF_DM}:main`, "好的", "turn_a");
    leadName = "Nina";
    await hub.replyToOwner(`slack:${SELF_DM}:main`, "收到", "turn_b");
    expect(inSelfDm().map((message) => barOf(message)!.blocks[0])).toEqual([
      { type: "context", elements: [{ type: "mrkdwn", text: ":robot_face: Red Bull (Assistant)" }] },
      { type: "context", elements: [{ type: "mrkdwn", text: ":robot_face: Nina (Assistant)" }] },
    ]);
    expect(inSelfDm().map((message) => message.text)).toEqual([":robot_face: Red Bull (Assistant)\n好的", ":robot_face: Nina (Assistant)\n收到"]);
  });

  it("leaves messages to other people as they were: no bar on confirmed-by and auto-reply", async () => {
    const hub = ownerHub();
    const by = "lead for user via turn:turn-1";
    await hub.sendMessage("slack:D0ZHANG:main", { text: "Lead 写的话", words: "assistant", forUser: true, by });
    await hub.sendMessage("slack:D0ZHANG:main", { text: "自动回复", words: "assistant", forUser: false, by });
    await hub.sendMessage("slack:D0ZHANG:main", { text: "用户的原话", words: "user", forUser: true, by });
    const posted = slack.messages.filter((message) => message.channel === "D0ZHANG");
    expect(posted.map((message) => message.text.split("\n")[0])).toEqual([
      ":robot_face: Fairy (Assistant) · confirmed by 我", ":robot_face: Fairy (Assistant) · auto-reply for 我", "用户的原话",
    ]);
    expect(posted.map((message) => message.attachments)).toEqual([undefined, undefined, undefined]);
    expect(posted.map((message) => message.blocks?.[0]?.type)).toEqual(["context", "context", undefined]);
  });
});

describe("Markdown to Slack mrkdwn", () => {
  it("converts headings, emphasis, links, lists and tables, and leaves code alone", () => {
    const markdown = [
      "# 标题",
      "**粗体** 和 *斜体* 和 ~~删掉~~，见 [文档](https://doc.test/a)",
      "- 第一项 **重点**",
      "* 第二项",
      "",
      "| 名字 | 状态 |",
      "|---|---|",
      "| A | ok |",
      "",
      "```ts",
      "const a = **b** * c;",
      "```",
      "行内 `**不动**` 的代码",
    ].join("\n");
    expect(slackMrkdwnFromMarkdown(markdown)).toBe([
      "*标题*",
      "*粗体* 和 _斜体_ 和 ~删掉~，见 <https://doc.test/a|文档>",
      "• 第一项 *重点*",
      "• 第二项",
      "",
      "```",
      "| 名字 | 状态 |",
      "|---|---|",
      "| A | ok |",
      "```",
      "",
      "```",
      "const a = **b** * c;",
      "```",
      "行内 `**不动**` 的代码",
    ].join("\n"));
  });

  // App 里的对象链接（P14.7）在 Slack 里打不开：只留链接的文字，不变成一个坏掉的 <plc:…|…>。
  it("turns links to App objects into their words", () => {
    expect(slackMrkdwnFromMarkdown("回 [Ethan 的私信](plc:card/134) 的草稿放好了，见 [文档](https://doc.test/a)"))
      .toBe("回 Ethan 的私信 的草稿放好了，见 <https://doc.test/a|文档>");
  });
});
