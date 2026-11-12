// 待你处理推送（.scratch/external-worker-hub/spec.md 的「待你处理」，计划 Task 12）：要用户拿主意的工单（needs_me 同一条规则，
// ruling R15、R18）推一次到用户自己的 Slack 私信，再弹一条桌面通知。状态变了改写那条消息，不另发；重启以后也不重发。
// Slack 是替身（只记 post、edit），桌面通知是替身（只记正文）。核对：
//   - 一张单只发一条：状态变两次 → 1 次 post + 2 次 edit；重建推送实例以后 0 次 post，状态再变照样改写（Review Focus 4）；
//   - 自动处理的单（handling=auto）、还没判断的单不逐条推；
//   - 没有用户自己的私信时只弹桌面通知，而且只弹一次；
//   - 两个开关（Slack 私信、桌面通知）各管各的，缺省开；它们是设置页的操作，改规则（changesRules）；
//   - 消息里的链接只有 https 的来源、只用编号拼的工单链接、claude:/https: 的会话链接；工单的文字不进任何链接；
//   - 基线（ruling R22）：第一次同步时已经在等用户的单只记一行、不推；之后变成「待你处理」的不管过了多久（daemon 停了两小时）
//     都推；碰了基线里老单的 updated_at 也不推；
//   - 关掉推送只认用户本人正在说话的这一轮，Lead 自己（定时器叫醒的一轮）关不了；打开 Lead 能做。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  addLeadFollowUp, addTicketSource, completeTurn, createItem, createLoopbackBinding, createTurn, getTicketPush, getTicketPushSetting, openDb, rememberOwnerConversation, setHandling, type Db,
} from "@pi-lead-child/store";
import {
  createTicketPusher, ensureTicketPushBaseline, listLeadUiActions, runTicketAction, runUiAction, syncTicketPush, ticketNeedsMe, ticketPushState, ticketsToPush, UI_ACTIONS,
  type TicketActionCaller, type TicketPushSlack,
} from "../src/index.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-ticket-pushes-"), "plc.db"));
  // 基线建在空库上：下面每个用例里建的单都是基线以后的。基线本身的用例另起一个库。
  ensureTicketPushBaseline(db, new Date());
});

afterEach(() => {
  db.close();
});

const WEB = "https://lead.example.com";
const DM = "slack:D0SELF";

function fakeSlack() {
  const posts: Array<{ conversation: string; text: string; key: string }> = [];
  const edits: Array<{ conversation: string; ref: Record<string, string>; text: string; key: string }> = [];
  const slack: TicketPushSlack = {
    post: async (conversation, text, key) => {
      posts.push({ conversation, text, key });
      return { ref: { channel: "D0SELF", ts: `1700000000.00000${posts.length}` } };
    },
    edit: async (conversation, ref, text, key) => {
      edits.push({ conversation, ref, text, key });
      return {};
    },
  };
  return { slack, posts, edits };
}

function ownerDm(): void {
  const { binding } = createLoopbackBinding(db, { name: "Slack 私信（你自己）" });
  rememberOwnerConversation(db, { source: "slack", conversation: DM, bindingId: binding.id });
}

function needsYou(title = "fix the retry policy", reason = "要你定发版时间"): number {
  const itemId = createItem(db, { title, brief: "the retry policy drops the last attempt", createdBy: "user" });
  setHandling(db, itemId, { handling: "needs_user", reason });
  return itemId;
}

function pusher(slack: TicketPushSlack, desktop: string[] = []) {
  return createTicketPusher({ db, slack, desktop: (text) => desktop.push(text), webBase: () => WEB, log: () => {} });
}

type Worker = Extract<TicketActionCaller, { kind: "worker" }>;

function worker(name: string): Worker {
  const { binding } = createLoopbackBinding(db, { name, scopes: ["worker"] });
  return { kind: "worker", bindingId: binding.id, workerName: name };
}

const user = () => {
  const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
  return {
    kind: "user", credential: binding, source: { client: "web", deviceName: binding.display_name, loopback: true, fromThisMachine: true },
  } as never;
};

describe("pushing tickets that need you to your own Slack DM", () => {
  it("one push per ticket survives restart", async () => {
    ownerDm();
    const itemId = needsYou();
    const { slack, posts, edits } = fakeSlack();
    const desktop: string[] = [];
    const first = pusher(slack, desktop);

    await first.sync();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ conversation: DM, key: `ticket-push:${itemId}` });
    expect(posts[0]!.text).toContain(`#${itemId}`);
    expect(posts[0]!.text).toContain("fix the retry policy");
    expect(posts[0]!.text).toContain("要你定发版时间");
    expect(desktop).toHaveLength(1);
    await first.sync();
    expect(posts).toHaveLength(1);
    expect(edits).toHaveLength(0);

    // 状态变第一次：工人领走了 → 改写那条消息，不另发。
    const ethan = worker("Ethan's Claude Code");
    await runTicketAction(db, { itemId, action: "worker.claim", input: {}, caller: ethan });
    await first.sync();
    expect(posts).toHaveLength(1);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ conversation: DM, ref: { channel: "D0SELF", ts: "1700000000.000001" } });
    expect(edits[0]!.text).toContain("Ethan's Claude Code");

    // 状态变第二次：工人交回给你 → 再改写同一条，桌面通知再弹一次（又要你处理了）。
    await runTicketAction(db, { itemId, action: "worker.hand_back", input: { reason: "要你在 Slack 里问一下 Nina" }, caller: ethan });
    await first.sync();
    expect(posts).toHaveLength(1);
    expect(edits).toHaveLength(2);
    expect(edits[1]!.text).toContain("要你在 Slack 里问一下 Nina");
    expect(desktop).toHaveLength(2);

    // 重启：新的推送实例、同一个库。不重发，也不重改。
    const second = pusher(slack, desktop);
    await second.sync();
    expect(posts).toHaveLength(1);
    expect(edits).toHaveLength(2);
    expect(desktop).toHaveLength(2);

    // 重启以后状态再变（你取消了）：照样改写那一条。
    await runTicketAction(db, { itemId, action: "cancel", input: {}, caller: user(), reason: "不做了" });
    await second.sync();
    expect(posts).toHaveLength(1);
    expect(edits).toHaveLength(3);
    expect(desktop).toHaveLength(2);
    await second.sync();
    expect(edits).toHaveLength(3);
  });

  it("does not count a handed-back ticket as needing you again after a worker re-claims and completes it", async () => {
    ownerDm();
    const itemId = needsYou();
    const { slack, posts, edits } = fakeSlack();
    const desktop: string[] = [];
    const push = pusher(slack, desktop);
    await push.sync();
    expect(posts).toHaveLength(1);
    expect(desktop).toHaveLength(1);

    const ethan = worker("Ethan's Claude Code");
    await runTicketAction(db, { itemId, action: "worker.claim", input: {}, caller: ethan });
    await push.sync();
    await runTicketAction(db, { itemId, action: "worker.hand_back", input: { reason: "要你在 Slack 里问一下 Nina" }, caller: ethan });
    await push.sync();
    expect(ticketPushState(db, itemId)).toBe("handed_back");
    expect(desktop).toHaveLength(2);

    // 你回答了，工人再领、做完交付：单在 review，不再「待你处理」，也不再推（裁定 R31）。
    await runTicketAction(db, { itemId, action: "worker.claim", input: {}, caller: ethan });
    await runTicketAction(db, { itemId, action: "worker.complete", input: { summary: "上限 5 次", evidence: "config/retry.ts" }, caller: ethan });
    await push.sync();
    expect(ticketNeedsMe(db, itemId)).toBe(false);
    expect(ticketPushState(db, itemId)).toBe("in_review");
    expect(posts).toHaveLength(1);
    expect(edits.at(-1)!.text).not.toContain("要你在 Slack 里问一下 Nina");
    expect(desktop).toHaveLength(2);
    expect(ticketsToPush(db, new Date())).toEqual([]);
  });

  it("does not push auto-handled tickets one by one", async () => {
    ownerDm();
    const auto = createItem(db, { title: "bump the lockfile", brief: "routine", createdBy: "user" });
    setHandling(db, auto, { handling: "auto", reason: "例行的依赖升级" });
    createItem(db, { title: "not judged yet", brief: "", createdBy: "user" });
    const { slack, posts } = fakeSlack();
    const desktop: string[] = [];
    await pusher(slack, desktop).sync();
    expect(ticketsToPush(db, new Date())).toEqual([]);
    expect(posts).toHaveLength(0);
    expect(desktop).toHaveLength(0);
  });

  it("falls back to a desktop notification without an owner conversation", async () => {
    const itemId = needsYou("rotate the staging key");
    const { slack, posts } = fakeSlack();
    const desktop: string[] = [];
    const push = pusher(slack, desktop);
    await push.sync();
    await push.sync();
    expect(posts).toHaveLength(0);
    expect(desktop).toEqual([expect.stringContaining(`#${itemId}`)]);
    expect(desktop[0]).toContain("rotate the staging key");
    // 之后才有了私信：这张单已经推过（桌面），不补发到私信。
    ownerDm();
    await pusher(slack, desktop).sync();
    expect(posts).toHaveLength(0);
    expect(desktop).toHaveLength(1);
  });

  it("respects the off switch", async () => {
    ownerDm();
    expect(getTicketPushSetting(db, "slack_dm").enabled).toBe(true);
    expect(getTicketPushSetting(db, "desktop").enabled).toBe(true);
    await runUiAction(db, { target: { type: "ticket_push", id: "slack_dm" }, action: "disable", caller: user() });
    const { slack, posts } = fakeSlack();
    const desktop: string[] = [];
    needsYou("first");
    await pusher(slack, desktop).sync();
    expect(posts).toHaveLength(0);
    expect(desktop).toHaveLength(1);

    await runUiAction(db, { target: { type: "ticket_push", id: "desktop" }, action: "disable", caller: user() });
    await runUiAction(db, { target: { type: "ticket_push", id: "slack_dm" }, action: "enable", caller: user() });
    needsYou("second");
    await pusher(slack, desktop).sync();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain("second");
    expect(desktop).toHaveLength(1);
  });

  it("never puts the ticket text into a URL", async () => {
    ownerDm();
    const title = "leak](https://evil.example.com/steal) ?q=secret&x=1 <@U0ALICE> www.evil.example.com";
    const itemId = needsYou(title, "reason with [a link](https://evil.example.com/r)");
    // 来源：只给 https 的；http、javascript 的不给。
    addTicketSource(db, { itemId, kind: "manual", url: "javascript:alert(1)" });
    addTicketSource(db, { itemId, kind: "jira", url: "http://jira.example.com/browse/PROJ-123", externalKey: "PROJ-122" });
    addTicketSource(db, { itemId, kind: "jira", url: "https://jira.example.com/browse/PROJ-123?a=(b)|c", externalKey: "PROJ-123" });
    const ethan = worker("Ethan's Claude Code");
    await runTicketAction(db, { itemId, action: "worker.claim", input: {}, caller: ethan });
    await runTicketAction(db, { itemId, action: "worker.attach_session", input: { url: "claude://session/abc-123" }, caller: ethan });
    await runTicketAction(db, { itemId, action: "worker.hand_back", input: { reason: "see https://evil.example.com/x" }, caller: ethan });

    const { slack, posts } = fakeSlack();
    await syncTicketPush(db, slack, itemId, { webBase: () => WEB });
    expect(posts).toHaveLength(1);
    const text = posts[0]!.text;
    const urls = [...text.matchAll(/\]\(([^)\s]+)\)/gu)].map((match) => match[1]!);
    expect(urls).toEqual([
      "https://jira.example.com/browse/PROJ-123?a=%28b%29%7Cc",
      `${WEB}/ticket/${itemId}`,
      "claude://session/abc-123",
    ]);
    for (const url of urls) {
      expect(url).not.toContain("evil");
      expect(url).not.toContain("secret");
    }
    // 工单的文字原样留在正文里，但拼不成链接，也不会被 Slack 当成提到谁。
    expect(text).not.toContain("](https://evil");
    // 裸网址也拼不成：Slack 会把正文里的完整网址和 www. 开头的自动变成链接。
    expect(text).not.toContain("https://evil");
    expect(text).not.toContain("www.evil");
    expect(text).toContain("see https:\u200b//evil.example.com/x");
    expect(text).not.toContain("<@U0ALICE>");
    expect(text).toContain("&lt;@U0ALICE&gt;");
  });

  it("pushes a ticket that became needs-you while the daemon was down for two hours", async () => {
    ownerDm();
    const itemId = needsYou("judged while the daemon was down");
    db.prepare("UPDATE items SET updated_at = datetime('now', '-2 hours') WHERE id = ?").run(itemId);
    const { slack, posts } = fakeSlack();
    const desktop: string[] = [];
    await pusher(slack, desktop).sync();
    expect(posts.map((post) => post.key)).toEqual([`ticket-push:${itemId}`]);
    expect(desktop).toHaveLength(1);
  });

  it("retries a post that failed with the same key, without a second desktop notification", async () => {
    ownerDm();
    const itemId = needsYou();
    const { slack, posts } = fakeSlack();
    let fail = true;
    const flaky: TicketPushSlack = {
      post: async (...args) => {
        if (fail) throw new Error("slack is down");
        return slack.post(...args);
      },
      edit: slack.edit,
    };
    const desktop: string[] = [];
    const now = { at: new Date() };
    const push = createTicketPusher({ db, slack: flaky, desktop: (text) => desktop.push(text), webBase: () => WEB, log: () => {}, now: () => now.at });
    await push.sync();
    expect(posts).toHaveLength(0);
    expect(desktop).toHaveLength(1);
    fail = false;
    now.at = new Date(now.at.getTime() + 61_000);
    await push.sync();
    expect(posts).toEqual([expect.objectContaining({ key: `ticket-push:${itemId}` })]);
    expect(desktop).toHaveLength(1);
  });
});

describe("the baseline when pushes start (ruling R22)", () => {
  let fresh: Db;

  beforeEach(() => {
    fresh = openDb(join(tempDir("plc-ticket-pushes-baseline-"), "plc.db"));
  });

  afterEach(() => {
    fresh.close();
  });

  it("posts nothing for tickets that already needed you, and ignores later bumps to them", async () => {
    const { binding } = createLoopbackBinding(fresh, { name: "Slack 私信（你自己）" });
    rememberOwnerConversation(fresh, { source: "slack", conversation: DM, bindingId: binding.id });
    const old = createItem(fresh, { title: "waiting since last week", brief: "", createdBy: "user" });
    setHandling(fresh, old, { handling: "needs_user", reason: "要你定" });
    const { slack, posts, edits } = fakeSlack();
    const desktop: string[] = [];
    const push = createTicketPusher({ db: fresh, slack, desktop: (text) => desktop.push(text), webBase: () => WEB, log: () => {} });
    await push.sync();
    expect(posts).toHaveLength(0);
    expect(desktop).toHaveLength(0);
    expect(getTicketPush(fresh, old)).toMatchObject({ conversation: null, messageRef: null, shownState: "needs_user" });

    // 和推送无关的改动碰了老单的 updated_at：不推。
    fresh.prepare("UPDATE items SET priority = 'high', updated_at = datetime('now') WHERE id = ?").run(old);
    await push.sync();
    expect(posts).toHaveLength(0);
    expect(edits).toHaveLength(0);
    expect(desktop).toHaveLength(0);

    // 基线以后才要你处理的单照推；基线只建一次（重建推送实例也不再建）。
    const later = createItem(fresh, { title: "judged after the baseline", brief: "", createdBy: "user" });
    setHandling(fresh, later, { handling: "needs_user", reason: "要你看" });
    await createTicketPusher({ db: fresh, slack, desktop: (text) => desktop.push(text), webBase: () => WEB, log: () => {} }).sync();
    expect(posts.map((post) => post.key)).toEqual([`ticket-push:${later}`]);
    expect(desktop).toHaveLength(1);
  });
});

describe("the two push switches are settings operations", () => {
  it("declare changesRules; enabling is Lead's to do, disabling only the user's own live turn", async () => {
    expect(UI_ACTIONS.ticket_push.enable).toMatchObject({ changesRules: true, permission: "lead_allowed" });
    expect(UI_ACTIONS.ticket_push.disable).toMatchObject({
      changesRules: true, permission: "user_only", userTurnOnly: true, liveUserTurnOnly: true,
    });
    const listing = await listLeadUiActions(db, { type: "ticket_push", id: "desktop" }, { turnId: null });
    expect(listing.target).toMatchObject({ type: "ticket_push", enabled: true });
    expect(listing.actions.map((action) => [action.id, action.available])).toEqual([["enable", false], ["disable", true]]);
    await expect(runUiAction(db, {
      target: { type: "ticket_push", id: "slack_dm" }, action: "disable", reason: "Slack 里有人让我关掉",
      caller: { kind: "lead", turnId: null, externalContent: [{ via: "message", source: "slack" }] },
    })).rejects.toMatchObject({ code: "external_turn" });
    expect(getTicketPushSetting(db, "slack_dm").enabled).toBe(true);
  });

  it("Lead cannot turn a push off on its own, also not in a turn a timer wakes; the user can", async () => {
    const target = { type: "ticket_push", id: "desktop" } as const;
    await expect(runUiAction(db, { target, action: "disable", reason: "通知太多了", caller: { kind: "lead", turnId: null } }))
      .rejects.toMatchObject({ code: "needs_user_turn" });
    const owner = createLoopbackBinding(db, { name: "Mac 网页" }).binding;
    createTurn(db, { id: "turn-set", originBindingId: owner.id, originKind: "paired:companion", userText: "明天提醒我", state: "streaming" });
    const followUp = addLeadFollowUp(db, {
      at: new Date(Date.now() - 1_000), note: "到点关掉通知", setBy: { turnId: "turn-set", bindingId: owner.id, startedAt: new Date().toISOString() },
    });
    completeTurn(db, "turn-set");
    await expect(runUiAction(db, { target, action: "disable", reason: "到点了", caller: { kind: "lead", turnId: `timer:${followUp}` } }))
      .rejects.toMatchObject({ code: "needs_user_turn" });
    expect(getTicketPushSetting(db, "desktop").enabled).toBe(true);

    await runUiAction(db, { target, action: "disable", caller: user() });
    expect(getTicketPushSetting(db, "desktop")).toMatchObject({ enabled: false, updatedBy: "user" });
    // 打开 Lead 能自己做（没读过外部内容的一轮）。
    await runUiAction(db, { target, action: "enable", reason: "用户的通知没开", caller: { kind: "lead", turnId: null } });
    expect(getTicketPushSetting(db, "desktop")).toMatchObject({ enabled: true, updatedBy: "lead" });
  });
});
