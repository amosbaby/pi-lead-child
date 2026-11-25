// Topics in the store (topics.ts): the rows, the limit of open topics, what a new topic carries over from the main
// conversation, and a topic's user turn as the user's own live turn (user-turn-authority.ts).
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  activePairedUserTurn, closeTopic, completeTopicTurn, completeTurn, createLoopbackBinding, createTopic, createTopicTurn, createTurn,
  listTopicDtos, listTurns, listUnfinishedLeadTurns, openDb, recentMainDialogue, reopenTopic, appendAssistantDelta, TopicLimitError,
  type Db,
} from "../src/index.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-topics-store-"), "plc.db"));
});
afterEach(() => db.close());

const at = (minute: number) => new Date(Date.UTC(2026, 10, 25, 3, minute));

describe("topics", () => {
  it("lists open topics first, counts turns, and keeps the conclusion when a topic is closed and opened again", () => {
    const first = createTopic(db, { title: "第一个", openedBy: "lead", originTurnId: "turn_a", now: at(0) });
    const second = createTopic(db, { title: "第二个", openedBy: "user", originQuote: "一段话", originRole: "assistant", now: at(1) });
    const turn = createTopicTurn(db, { topicId: first.id, originKind: "paired:companion:topic", userText: "问", now: at(2) });
    completeTopicTurn(db, turn.id, at(3));

    expect(listTopicDtos(db).map((topic) => [topic.id, topic.turnCount, topic.lastTurnId])).toEqual([
      [first.id, 1, turn.id], [second.id, 0, null],
    ]);
    closeTopic(db, first.id, "定了三件事。", at(4));
    expect(listTopicDtos(db).map((topic) => [topic.id, topic.state])).toEqual([[second.id, "open"], [first.id, "closed"]]);
    // A close without a conclusion keeps the earlier one. Opening again keeps it too.
    closeTopic(db, first.id, null, at(5));
    reopenTopic(db, first.id, at(6));
    expect(listTopicDtos(db).find((topic) => topic.id === first.id)).toMatchObject({ state: "open", conclusion: "定了三件事。" });
  });

  it("refuses one more open topic at the limit, and closed topics do not count", () => {
    const ids = Array.from({ length: 20 }, (_, index) => createTopic(db, { title: `话题 ${index}`, openedBy: "user" }).id);
    expect(() => createTopic(db, { title: "多的一个", openedBy: "user" })).toThrow(TopicLimitError);
    closeTopic(db, ids[0]!, null);
    expect(createTopic(db, { title: "现在可以了", openedBy: "user" }).state).toBe("open");
    expect(() => reopenTopic(db, ids[0]!)).toThrow(TopicLimitError);
  });

  it("keeps its turns out of the main conversation's tables", () => {
    const topic = createTopic(db, { title: "一个话题", openedBy: "user" });
    createTopicTurn(db, { topicId: topic.id, originKind: "paired:companion:topic", userText: "话题里的话" });
    expect(listTurns(db)).toEqual([]);
    expect(listUnfinishedLeadTurns(db, { since: new Date(0) })).toEqual([]);
  });
});

describe("what a new topic carries over", () => {
  it("is the last finished turns between the user and Lead, up to the turn the topic came from", () => {
    const said = (id: string, originKind: string, minute: number, done = true, itemId?: number) => {
      createTurn(db, { id, originKind, userText: `用户 ${id}`, now: at(minute), ...(itemId ? { itemId } : {}) });
      appendAssistantDelta(db, id, `回答 ${id}`);
      if (done) completeTurn(db, id);
    };
    said("turn_1", "paired:companion", 1);
    said("turn_2", "paired:companion", 2);
    // Not conversation between the two: a turn that an event started, a ticket chat, a turn that is still running.
    createTurn(db, { id: "turn_sys", originKind: "system:blocker", userText: "", now: at(3) });
    completeTurn(db, "turn_sys");
    said("turn_ticket", "paired:companion:ticket-agent", 4, true);
    said("turn_3", "paired:companion", 5);
    said("turn_4", "paired:companion", 6, false);
    said("turn_5", "paired:companion", 7);

    expect(recentMainDialogue(db).map((turn) => turn.id)).toEqual(["turn_1", "turn_2", "turn_3", "turn_5"]);
    expect(recentMainDialogue(db, { limit: 2 }).map((turn) => turn.id)).toEqual(["turn_3", "turn_5"]);
    // The topic came from turn_3: nothing later is carried.
    expect(recentMainDialogue(db, { upTo: "turn_3" }).map((turn) => [turn.id, turn.userText, turn.assistantText])).toEqual([
      ["turn_1", "用户 turn_1", "回答 turn_1"], ["turn_2", "用户 turn_2", "回答 turn_2"], ["turn_3", "用户 turn_3", "回答 turn_3"],
    ]);
  });
});

describe("a message in a topic as the user's own live turn", () => {
  it("counts while it is answered, from a credential with the scope; the opening never counts", () => {
    const { binding } = createLoopbackBinding(db, { name: "app", scopes: ["chat", "tickets:create"] });
    const topic = createTopic(db, { title: "一个话题", openedBy: "user" });
    const opening = createTopicTurn(db, { topicId: topic.id, originKind: "system:topic-opening" });
    const message = createTopicTurn(db, {
      topicId: topic.id, originKind: "paired:companion:topic", originBindingId: binding.id, userText: "把预算加到 20 万",
    });
    expect(activePairedUserTurn(db, message.id, "set_budget", "tickets:create")).toMatchObject({
      id: message.id, origin_binding_id: binding.id, origin_kind: "paired:companion:topic",
    });
    // A scope the credential does not have, the opening (no credential), and a turn that ended.
    expect(() => activePairedUserTurn(db, message.id, "approve", "approvals:respond")).toThrow(/does not carry it/u);
    expect(() => activePairedUserTurn(db, opening.id, "set_budget", "tickets:create")).toThrow(/authenticated paired user turn/u);
    completeTopicTurn(db, message.id);
    expect(() => activePairedUserTurn(db, message.id, "set_budget", "tickets:create")).toThrow(/no longer active/u);
  });
});
