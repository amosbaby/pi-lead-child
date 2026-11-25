// Slack 的文档（2026-11-20：用户要 Lead 能写 Slack 的 canvas 和可以编辑的 Markdown 文件）。
// Lead 经 hub 的 createDocument、readDocument、editDocument 建、读、改；Slack 适配器用 canvases.* 和两步上传的 files.*。
// Slack 不能原地改文件，所以改 Markdown 文件是上传一份新的、分享回原来的地方、删掉旧的。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "@pi-lead-child/store";
import { ChannelActionError, ChannelHub, ChannelRegistry, createSlackChannelAdapter, type ChannelAdapter } from "../src/index.js";
import { slackDocumentId } from "../src/channels/sources/slack-documents.js";
import { FAKE_SLACK_USER_SCOPES, FakeSlack } from "../testing/index.js";

const DOCUMENT_SCOPES = [...FAKE_SLACK_USER_SCOPES, "files:read", "files:write", "canvases:read", "canvases:write"];

let db: Db;
let slack: FakeSlack;
let hub: ChannelHub;

function setup(scopes: string[] = DOCUMENT_SCOPES): void {
  slack = new FakeSlack({ users: { U0NINA: { name: "nina" } }, scopes });
  hub = new ChannelHub({
    db, registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api })]),
    credentials: { credential: async () => slack.credential }, log: () => {},
  });
}

beforeEach(() => {
  db = openDb(join(tempDir("plc-slack-documents-"), "plc.db"));
  setup();
});

afterEach(async () => {
  await hub.idle();
  db.close();
});

const PLAN = "# 发布计划\n\n## 本周\n\n- [ ] 定运费\n\n## 下周\n\n- [ ] 上线";

describe("Slack canvases", () => {
  it("creates a canvas only the user can see, and reads back its Markdown", async () => {
    const created = await hub.createDocument({ kind: "canvas", title: "发布计划", markdown: PLAN });
    expect(created).toMatchObject({ kind: "canvas", title: "发布计划" });
    expect(created.document).toBe(`slack:${created.ref}`);
    expect(created.url).toContain(created.ref);
    expect(slack.canvases.get(created.ref)).toMatchObject({ title: "发布计划", channel: null });

    const read = await hub.readDocument(created.document, 1_000_000);
    expect(read).toMatchObject({ kind: "canvas", title: "发布计划", markdown: `${PLAN}\n` });
  });

  it("tabs a canvas into the channel of the conversation it is created in", async () => {
    const created = await hub.createDocument({ kind: "canvas", title: "纪要", markdown: "会议纪要", conversation: "slack:C0PROJ:main" });
    expect(slack.canvases.get(created.ref)).toMatchObject({ channel: "C0PROJ" });
  });

  it("edits one section found by its text, and refuses text that matches several sections", async () => {
    const { document } = await hub.createDocument({ kind: "canvas", title: "发布计划", markdown: PLAN });
    await hub.editDocument(document, { operation: "replace", markdown: "- [x] 定运费", section: { containsText: "定运费" } });
    await hub.editDocument(document, { operation: "insert_after", markdown: "- [ ] 写公告", section: { containsText: "上线" } });
    await hub.editDocument(document, { operation: "rename", title: "发布计划 v2" });
    expect(slack.canvasMarkdown(document.slice("slack:".length)))
      .toBe("# 发布计划\n\n## 本周\n\n- [x] 定运费\n\n## 下周\n\n- [ ] 上线\n\n- [ ] 写公告\n");
    expect(slack.canvases.get(document.slice("slack:".length))!.title).toBe("发布计划 v2");

    const ambiguous = hub.editDocument(document, { operation: "delete", section: { containsText: "周" } });
    await expect(ambiguous).rejects.toThrow(/有 2 段都包含「周」/);
    // 限定段的种类就能对上一段。
    await hub.editDocument(document, { operation: "delete", section: { containsText: "下周", types: ["h2"] } });
    expect(slack.canvasMarkdown(document.slice("slack:".length))).not.toContain("## 下周");
  });

  it("finds a canvas from its link", async () => {
    const { ref } = await hub.createDocument({ kind: "canvas", title: "发布计划", markdown: PLAN });
    const read = await hub.readDocument(`slack:https://acme.slack.com/docs/T0HOME/${ref}`, 1_000_000);
    expect(read.ref).toBe(ref);
    expect(slackDocumentId(`https://acme.slack.com/docs/T0HOME/${ref}?focus=1`)).toBe(ref);
  });

  it("says which scope to add when the token has no canvas scopes", async () => {
    setup([...FAKE_SLACK_USER_SCOPES, "files:read"]);
    const created = hub.createDocument({ kind: "canvas", title: "发布计划", markdown: PLAN });
    await expect(created).rejects.toThrow(/缺 canvases:write 权限/);
  });
});

describe("Slack Markdown files", () => {
  it("uploads a Markdown file into a thread, and takes Slack's echo of the share as the system's own", async () => {
    const root = slack.chatter("U0NINA", "能整理一份发布清单吗？", "C0PROJ");
    const threadTs = (JSON.parse(root.body) as { event: { ts: string } }).event.ts;
    const created = await hub.createDocument({
      kind: "markdown", title: "发布清单", markdown: PLAN, conversation: `slack:C0PROJ:${threadTs}`,
    });
    expect(created).toMatchObject({ kind: "markdown", title: "发布清单" });
    const file = slack.files.get(created.ref)!;
    expect(file).toMatchObject({ name: "发布清单.md", filetype: "markdown", owner: "U0SELF" });
    expect(new TextDecoder().decode(file.data)).toBe(PLAN);
    const share = slack.messages.find((message) => message.files?.some((candidate) => candidate.id === created.ref))!;
    expect(share).toMatchObject({ channel: "C0PROJ", thread_ts: threadTs, user: "U0SELF" });

    const echo = (await hub.receive("slack", slack.echoOf(share))).items[0]!;
    expect(echo).toMatchObject({ kind: "slack.self.reply", role: "echo" });

    expect((await hub.readDocument(created.document, 1_000_000)).markdown).toBe(PLAN);
  });

  it("replaces a Markdown file with a new one in the same thread and deletes the old one", async () => {
    const created = await hub.createDocument({ kind: "markdown", title: "发布清单", markdown: "- [ ] 定运费", conversation: "slack:C0PROJ:main" });
    const edited = await hub.editDocument(created.document, { operation: "insert_at_end", markdown: "- [ ] 上线" });
    expect(edited.replacedDocument).toBe(created.document);
    expect(edited.document).not.toBe(created.document);
    expect(edited.oldKept).toBeUndefined();
    expect(slack.files.has(created.ref)).toBe(false);
    expect(new TextDecoder().decode(slack.files.get(edited.ref)!.data)).toBe("- [ ] 定运费\n- [ ] 上线");
    expect(slack.files.get(edited.ref)!.shares).toEqual([expect.objectContaining({ channel: "C0PROJ", threadTs: null })]);
  });

  it("keeps someone else's file and says so", async () => {
    const theirs = slack.addFile("plan.md", "text/plain", new TextEncoder().encode("# plan"));
    Object.assign(theirs, { owner: "U0NINA", filetype: "markdown" });
    const edited = await hub.editDocument(`slack:${theirs.id}`, { operation: "replace", markdown: "# plan v2" });
    expect(edited.oldKept).toContain("别人的");
    expect(slack.files.has(theirs.id)).toBe(true);
  });

  it("refuses section edits on a Markdown file", async () => {
    const created = await hub.createDocument({ kind: "markdown", title: "清单", markdown: PLAN });
    const edit = hub.editDocument(created.document, { operation: "delete", section: { containsText: "定运费" } });
    await expect(edit).rejects.toThrow(/Markdown 文件不能按段改/);
  });

  it("does not treat a picture as a document", async () => {
    const shot = slack.addFile("screenshot.png", "image/png", new Uint8Array([1, 2, 3]));
    await expect(hub.readDocument(`slack:${shot.id}`, 1_000_000)).rejects.toThrow(/用 read_channel_file/);
  });
});

describe("documents in the hub", () => {
  it("refuses a kind the source does not have", async () => {
    const created = hub.createDocument({ kind: "spreadsheet", title: "表", markdown: "x" });
    await expect(created).rejects.toMatchObject({ code: "invalid_action" });
  });

  it("does not write when the source blocks writes", async () => {
    const slackAdapter = createSlackChannelAdapter({ api: slack.api });
    const blocked: ChannelAdapter = Object.create(slackAdapter, { writesBlocked: { value: () => "「允许 Lead 代你发消息」关着" } });
    hub = new ChannelHub({ db, registry: new ChannelRegistry([blocked]), credentials: { credential: async () => slack.credential }, log: () => {} });
    const created = hub.createDocument({ kind: "canvas", title: "发布计划", markdown: PLAN });
    await expect(created).rejects.toBeInstanceOf(ChannelActionError);
    await expect(created).rejects.toMatchObject({ code: "unavailable" });
    expect(slack.canvases.size).toBe(0);
  });
});
