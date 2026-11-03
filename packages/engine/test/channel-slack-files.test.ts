// Slack 消息附带的文件（2026-11-02：Nina 在私信里发了一张截图，Lead 只读到正文，说「看不到图片」）。
// 正文后面一个文件一行标记，写着文件编号；Lead 按编号经 hub.readFile 取文件的内容（要 files:read）。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { getEvent, openDb, type Db } from "@pi-lead-child/store";
import { ChannelHub, ChannelRegistry, createSlackChannelAdapter, createSlackWebApi, slackAttachmentsOnly, slackMessageText } from "../src/index.js";
import { FAKE_SLACK_USER_SCOPES, FakeSlack } from "../testing/index.js";

// 一个 1×1 的 PNG。
const PNG = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64",
));

let db: Db;
let slack: FakeSlack;
let hub: ChannelHub;

beforeEach(() => {
  db = openDb(join(tempDir("plc-slack-files-"), "plc.db"));
  slack = new FakeSlack({ users: { U0NINA: { name: "nina" } }, scopes: [...FAKE_SLACK_USER_SCOPES, "files:read"] });
  hub = new ChannelHub({
    db, registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api })]),
    credentials: { credential: async () => slack.credential }, log: () => {},
  });
});

afterEach(async () => {
  await hub.idle();
  db.close();
});

describe("a Slack message with a picture", () => {
  it("tells Lead that the picture is there and how to open it", async () => {
    const shot = slack.addFile("screenshot.png", "image/png", PNG);
    const received = (await hub.receive("slack", slack.dm("U0NINA", "这个表单要填部门吗", { files: [shot] }))).items[0]!;
    await hub.idle();
    expect(getEvent(db, received.seq!)!.payload.text).toBe(`这个表单要填部门吗\n[图片 screenshot.png，文件编号 slack:${shot.id}]`);
  });

  it("keeps a message that is only a picture, without text", async () => {
    const shot = slack.addFile("form.jpg", "image/jpeg", PNG);
    const received = (await hub.receive("slack", slack.dm("U0NINA", "", { files: [shot], subtype: "file_share" }))).items[0]!;
    await hub.idle();
    expect(getEvent(db, received.seq!)!.payload.text).toBe(`[图片 form.jpg，文件编号 slack:${shot.id}]`);
  });

  it("shows the picture in the conversation that Lead reads", async () => {
    const shot = slack.addFile("screenshot.png", "image/png", PNG);
    await hub.receive("slack", slack.dm("U0NINA", "看下这个", { files: [shot] }));
    await hub.idle();
    const read = await hub.readConversation("slack:@U0NINA", 10);
    expect(read.messages.map((message) => message.text)).toEqual([`看下这个\n[图片 screenshot.png，文件编号 slack:${shot.id}]`]);
  });

  it("gives Lead the file's content by its number", async () => {
    const shot = slack.addFile("screenshot.png", "image/png", PNG);
    const file = await hub.readFile(`slack:${shot.id}`, 1_000_000);
    expect(file).toMatchObject({ id: `slack:${shot.id}`, name: "screenshot.png", mimeType: "image/png", size: PNG.byteLength });
    expect(Buffer.from(file.data).equals(Buffer.from(PNG))).toBe(true);
  });

  it("says which scope is missing when the token cannot read files", async () => {
    slack.scopes = [...FAKE_SLACK_USER_SCOPES];
    const shot = slack.addFile("screenshot.png", "image/png", PNG);
    await expect(hub.readFile(`slack:${shot.id}`, 1_000_000)).rejects.toThrow(/files:read/);
    expect(slack.downloads).toEqual([]);
  });

  it("refuses unknown files, files that are too large, and download addresses outside Slack", async () => {
    await expect(hub.readFile("slack:F0NOPE", 1_000_000)).rejects.toMatchObject({ code: "not_found" });
    await expect(hub.readFile("slack:../../etc", 1_000_000)).rejects.toMatchObject({ code: "not_found" });
    await expect(hub.readFile("jira:F0001", 1_000_000)).rejects.toMatchObject({ code: "unavailable" });
    const big = slack.addFile("big.png", "image/png", new Uint8Array(2_000));
    await expect(hub.readFile(`slack:${big.id}`, 1_000)).rejects.toThrow(/1000/);
    // 令牌只发往 files.slack.com。
    const odd = slack.addFile("odd.png", "image/png", PNG, { url: "https://files.example.com/odd.png" });
    await expect(hub.readFile(`slack:${odd.id}`, 1_000_000)).rejects.toThrow(/files\.slack\.com/);
    expect(slack.downloads).toEqual([]);
  });
});

describe("the file markers in a Slack message", () => {
  it("names pictures and other files, and skips deleted ones", () => {
    expect(slackMessageText({
      text: "两个附件",
      files: [
        { id: "F01", name: "a.png", mimetype: "image/png" },
        { id: "F02", name: "spec.pdf", mimetype: "application/pdf" },
        { id: "F03", mode: "tombstone" },
        { id: "F04", mode: "hidden_by_limit" },
      ],
    })).toBe("两个附件\n[图片 a.png，文件编号 slack:F01]\n[文件 spec.pdf，application/pdf，文件编号 slack:F02]\n[文件 看不到：超出了工作区的存储上限]");
  });

  // 2026-11-02：只有截图的消息，收件判断只看得到文件的标记，被判成「要你的私人数据」。hub 按这个标记不让敏感分数进底线。
  it("tells a message that is only files (and mentions) from one with words", () => {
    const shot = { id: "F01", name: "a.png", mimetype: "image/png" };
    expect(slackAttachmentsOnly({ text: "", files: [shot] })).toBe(true);
    expect(slackAttachmentsOnly({ text: " <@U0DAVE>  ", files: [shot] })).toBe(true);
    expect(slackAttachmentsOnly({ text: "<@U0DAVE> 看下这个报错", files: [shot] })).toBe(false);
    expect(slackAttachmentsOnly({ text: "", files: [{ id: "F02", mode: "tombstone" }] })).toBe(false);
    expect(slackAttachmentsOnly({ text: "" })).toBe(false);
  });
});

describe("downloading a Slack file with the real Web API client", () => {
  it("sends the token only in the header and only to files.slack.com, and checks the answer", async () => {
    const web = createSlackWebApi({ fetch: slack.fetch });
    const shot = slack.addFile("screenshot.png", "image/png", PNG);
    const data = await web.download!(shot.url, slack.credential.token, 1_000_000);
    expect(Buffer.from(data).equals(Buffer.from(PNG))).toBe(true);
    // 令牌不对：Slack 回登录网页，不是文件。
    await expect(web.download!(shot.url, "xoxp-wrong", 1_000_000)).rejects.toThrow(/web page/);
    await expect(web.download!(shot.url, slack.credential.token, 10)).rejects.toThrow(/10 bytes/);
    const before = slack.downloads.length;
    await expect(web.download!("https://files.example.com/x.png", slack.credential.token, 1_000_000)).rejects.toThrow(/files\.slack\.com/);
    await expect(web.download!("http://files.slack.com/x.png", slack.credential.token, 1_000_000)).rejects.toThrow(/files\.slack\.com/);
    expect(slack.downloads).toHaveLength(before);
  });
});
