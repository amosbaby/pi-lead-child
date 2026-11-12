// 对外提问走完整的一圈（用户 2026-11-11、2026-11-12）：真的 hub、真的 Slack 来源插件，Slack 是假的。
// Lead 替工单在私信里问了人 → 那个人回了一句很短的话 → 等待了结，Lead 被叫醒，带着工单的备注、发信人和原话。
// 回复很短也不会被「要不要回」的判断挡掉：了结等待的是来信的事件本身，不是开出来的卡。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  createItem, createRun, getLeadWait, listEvents, listOpenLeadWaits, openDb, transition, updateRun, type Db,
} from "@pi-lead-child/store";
import {
  ChannelHub, ChannelRegistry, createCoordinator, createSlackChannelAdapter, runUiAction, type ChannelMessageService,
} from "../src/index.js";
import { FakeSlack } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let hub: ChannelHub;
let itemId: number;
let decisionId: number;

beforeEach(() => {
  db = openDb(join(tempDir("plc-question-flow-"), "plc.db"));
  slack = new FakeSlack({
    users: { U0NINA: { name: "nina", realName: "Nina Lin" }, U0ETHAN: { name: "ethan", realName: "Ethan Wu" } },
    channels: { C0PROJ: "proj-x" },
  });
  hub = new ChannelHub({
    db, registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api })]),
    credentials: { credential: async () => slack.credential }, log: () => {},
  });
  itemId = createItem(db, { title: "build the export page", brief: "If information is missing, Nina provides it.", createdBy: "lead" });
  transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
  const runId = createRun(db, { itemId, role: "executor" });
  updateRun(db, runId, { state: "running" });
  decisionId = createCoordinator({ db }).requestDecision({
    itemId, runId, kind: "question", audience: "lead_or_user", blocking: true,
    prompt: "Does the export keep deleted rows?",
    checkpoint: { title: "Deleted rows", summary: "The requirement and the code disagree." },
  }).requestId;
});

afterEach(async () => {
  await hub.idle();
  db.close();
});

// 操作层发消息用的服务：daemon 里也是 hub 的 sendMessage。
const channelMessages = (): ChannelMessageService => ({
  canSend: (source) => source === "slack",
  send: (conversationId, input) => hub.sendMessage(conversationId, input),
  react: async () => { throw new Error("not used"); },
  openCards: () => [],
});

async function ask() {
  await runUiAction(db, {
    target: { type: "channel_conversation", id: "slack:@U0NINA" }, action: "send_message",
    input: { text: "Hi Nina, does the export keep deleted rows?", words: "assistant", question: { ticketId: itemId, decisionId } },
    reason: "The ticket names Nina for missing information",
    caller: { kind: "lead", turnId: null }, services: { channelMessages: channelMessages() },
  });
}

const woke = () => listEvents(db, { kind: "lead.wait_satisfied", limit: 20 });

describe("an outbound question through the Slack source", () => {
  it("wakes Lead with the ticket note, the sender and the words when the person replies, however short the reply is", async () => {
    await ask();
    expect(slack.sent("D0NINA").map((message) => message.text.split("\n").at(-1))).toEqual(["Hi Nina, does the export keep deleted rows?"]);
    const [wait] = listOpenLeadWaits(db);
    expect(wait).toMatchObject({ entityKey: "slack:D0NINA:main" });

    await hub.receive("slack", slack.dm("U0NINA", "Keep them."));

    expect(getLeadWait(db, wait!.id)).toMatchObject({ state: "satisfied" });
    const [event] = woke();
    expect(event).toMatchObject({
      level: "tell", entityKey: "slack:D0NINA:main",
      payload: { external: true, source: "slack", origin: `question:ticket:${itemId}:decision:${decisionId}` },
    });
    expect(String(event!.payload.note)).toContain(`工单 #${itemId}`);
    expect(String((event!.payload.trigger as { summary: string }).summary)).toContain("Keep them.");
    expect(String(event!.payload.sender)).toMatch(/nina/i);
  });

  it("does not end on Lead's own message coming back, or on a message from someone else in another conversation", async () => {
    await ask();
    const [wait] = listOpenLeadWaits(db);
    // 发出去的那条被 Slack 推回来（回显）。
    await hub.receive("slack", slack.selfReply("D0NINA", "Hi Nina, does the export keep deleted rows?"));
    await hub.receive("slack", slack.dm("U0ETHAN", "Lunch?"));
    expect(getLeadWait(db, wait!.id)).toMatchObject({ state: "waiting" });
    expect(woke()).toEqual([]);
  });
});
