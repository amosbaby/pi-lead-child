// 对外提问（用户 2026-11-11、2026-11-12）：Lead 替一张工单在通道的对话里问人。发消息、登记等待、在工单上记一笔是同一步。
// 一个问题最多发 6 条，从第一次问起最长等 1 天（用户：「最多6条可以，最长一天」）。不开新表：等待用 lead_waits，
// 轮数从工单的活动里数。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  createItem, createRun, listActivities, listOpenLeadWaits, openDb, transition, updateRun, type Db,
} from "@pi-lead-child/store";
import {
  QUESTION_LIMITS, UiActionError, createCoordinator, runUiAction, type ChannelMessageService,
} from "../src/index.js";

let db: Db;
let itemId: number;
let runId: number;
let decisionId: number;
let outcome: "sent" | "auto_sent" | "drafted";
let sends: Array<[string, { text: string }]>;
let clock: Date;

const CONVERSATION = "slack:@U0NINA";
const OBJECT_KEY = "slack:D0NINA:main";

const channelMessages: ChannelMessageService = {
  canSend: (source) => source === "slack",
  send: async (conversationId, input) => {
    sends.push([conversationId, { text: input.text }]);
    return { conversation: conversationId, label: "Nina的私信", objectKey: OBJECT_KEY, text: input.text, card: null, outcome };
  },
  react: async () => { throw new Error("not used"); },
  openCards: () => [],
};

function ticketWithDecision(title = "build the export page") {
  const id = createItem(db, { title, brief: "If information is missing, Nina provides it.", createdBy: "lead" });
  transition(db, { itemId: id, to: "active", actor: "system", reason: "spawn" });
  const run = createRun(db, { itemId: id, role: "executor" });
  updateRun(db, run, { state: "running" });
  const decision = createCoordinator({ db }).requestDecision({
    itemId: id, runId: run, kind: "question", audience: "lead_or_user", blocking: true,
    prompt: "Does the export keep deleted rows?",
    checkpoint: { title: "Deleted rows", summary: "The requirement and the code disagree." },
  }).requestId;
  return { id, run, decision };
}

beforeEach(() => {
  db = openDb(join(tempDir("plc-outbound-question-"), "plc.db"));
  ({ id: itemId, run: runId, decision: decisionId } = ticketWithDecision());
  outcome = "auto_sent";
  sends = [];
  clock = new Date("2026-11-12T02:00:00.000Z");
});

// question 给 null 时是一条普通的消息。
function ask(text: string, question: { ticketId: number; decisionId?: number } | null = { ticketId: itemId, decisionId }) {
  return runUiAction(db, {
    target: { type: "channel_conversation", id: CONVERSATION }, action: "send_message",
    input: { text, words: "assistant", ...(question ? { question } : {}) },
    reason: "The ticket names Nina for missing information",
    caller: { kind: "lead", turnId: null }, services: { channelMessages }, now: clock,
  });
}

const questionMarks = (ticket = itemId) => listActivities(db, ticket)
  .map((activity) => JSON.parse(activity.payload) as Record<string, unknown>)
  .filter((payload) => payload.decision === "question_sent");

// 对方回复了：这个对话上的等待了结（store 的 settleLeadWaits 做的事，这里直接改状态）。
function replied() {
  db.prepare("UPDATE lead_waits SET state = 'satisfied', resolved_at = ? WHERE state = 'waiting'").run(clock.toISOString());
}

describe("asking a person for a ticket", () => {
  it("sends the message, registers a wait on the conversation the reply arrives in, and records it on the ticket", async () => {
    const result = await ask("Hi Nina, does the export keep deleted rows?");

    expect(sends).toEqual([[CONVERSATION, { text: "Hi Nina, does the export keep deleted rows?" }]]);
    const [wait] = listOpenLeadWaits(db);
    expect(wait).toMatchObject({ entityKey: OBJECT_KEY, origin: `question:ticket:${itemId}:decision:${decisionId}` });
    expect(wait!.note).toContain(`工单 #${itemId}`);
    expect(wait!.note).toContain(`决定请求 #${decisionId}`);
    expect(wait!.note).toContain("does the export keep deleted rows?");
    expect(Date.parse(wait!.expiresAt) - clock.getTime()).toBe(QUESTION_LIMITS.maxWaitMs);
    expect(questionMarks()).toEqual([expect.objectContaining({
      decisionRequestId: decisionId, conversation: CONVERSATION, objectKey: OBJECT_KEY, round: 1,
      text: "Hi Nina, does the export keep deleted rows?",
    })]);
    expect(result.forLead).toMatchObject({ question: { ticketId: itemId, decisionId, round: 1, maxMessages: 6 } });
  });

  it("counts a follow-up as the next round and keeps the deadline of the first ask", async () => {
    await ask("Does the export keep deleted rows?");
    const firstDeadline = listOpenLeadWaits(db)[0]!.expiresAt;
    replied();
    clock = new Date(clock.getTime() + 3 * 60 * 60_000);
    const result = await ask("The acceptance criteria say they are dropped. Which one wins?");

    expect(questionMarks().map((mark) => mark.round)).toEqual([1, 2]);
    expect(listOpenLeadWaits(db)[0]!.expiresAt).toBe(firstDeadline);
    expect(result.forLead).toMatchObject({ question: { round: 2 } });
  });

  it("refuses the seventh message and says what to do next, without sending", async () => {
    for (let round = 1; round <= 6; round++) {
      await ask(`question ${round}`);
      replied();
    }
    sends = [];
    await expect(ask("question 7")).rejects.toThrow(UiActionError);
    await expect(ask("question 7")).rejects.toThrow(/6 条/);
    await expect(ask("question 7")).rejects.toThrow(/交给用户/);
    expect(sends).toEqual([]);
    expect(questionMarks()).toHaveLength(6);
  });

  it("refuses a follow-up more than one day after the first ask", async () => {
    await ask("Does the export keep deleted rows?");
    replied();
    clock = new Date(clock.getTime() + QUESTION_LIMITS.maxWaitMs + 60_000);
    sends = [];
    await expect(ask("Still there?")).rejects.toThrow(/1 天/);
    expect(sends).toEqual([]);
  });

  it("refuses a question for a decision that is not pending on that ticket, without sending", async () => {
    const other = ticketWithDecision("check the design");
    await expect(ask("hello", { ticketId: itemId, decisionId: other.decision })).rejects.toThrow(/不是工单/);
    createCoordinator({ db }).resolveDecision({
      requestId: decisionId, decision: "respond", resolution: "keep", actor: { kind: "lead", resolvedBy: "lead" },
    });
    await expect(ask("hello")).rejects.toThrow(/已经有了结果/);
    expect(sends).toEqual([]);
  });

  it("keeps both questions in the note when two tickets ask in the same conversation", async () => {
    const other = ticketWithDecision("check the design");
    await ask("Does the export keep deleted rows?");
    await ask("Is the date picker in the library?", { ticketId: other.id, decisionId: other.decision });

    const waits = listOpenLeadWaits(db);
    expect(waits).toHaveLength(1);
    expect(waits[0]!.note).toContain(`工单 #${itemId}`);
    expect(waits[0]!.note).toContain(`工单 #${other.id}`);
    expect(questionMarks(other.id)).toHaveLength(1);
  });

  it("registers nothing when the message became a draft for the user instead of being sent", async () => {
    outcome = "drafted";
    await ask("Does the export keep deleted rows?");
    expect(listOpenLeadWaits(db)).toEqual([]);
    expect(questionMarks()).toEqual([]);
  });

  it("is an ordinary message without the question: no wait, no ticket record", async () => {
    await ask("See you at the stand-up.", null);
    expect(sends).toHaveLength(1);
    expect(listOpenLeadWaits(db)).toEqual([]);
    expect(questionMarks()).toEqual([]);
  });
});
