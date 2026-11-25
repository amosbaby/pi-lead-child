// Topics on the wire (topics.ts): which connections get a topic's events, the turn origins, and the title from a quote.
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";

import {
  gatewayEventOptIn, isSystemTurnOrigin, isTopicTurnOrigin, OpenTopicRequestSchema, TOPIC_OPENING_ORIGIN, TOPICS_OPT_IN,
  TOPIC_TITLE_MAX_LENGTH, topicTitleFromQuote,
} from "../src/index.js";

describe("topic events", () => {
  it("go only to connections that declared include=topics", () => {
    // A turn of a topic uses the frozen lead.* types with topicId in the payload.
    for (const type of ["lead.turn.started", "lead.message.delta", "lead.message.completed", "lead.tool.started", "lead.tool.completed"] as const) {
      expect(gatewayEventOptIn({ type, payload: { topicId: 3 } })).toBe(TOPICS_OPT_IN);
    }
    expect(gatewayEventOptIn({ type: "snapshot.required", payload: { resource: "topics" } })).toBe(TOPICS_OPT_IN);
    // A topic's tool event with a surface is still a topic event first: a client without topics never gets it.
    expect(gatewayEventOptIn({ type: "lead.tool.updated", payload: { topicId: 3, surface: {} } })).toBe(TOPICS_OPT_IN);
  });

  it("leaves the events of the main conversation as they were", () => {
    expect(gatewayEventOptIn({ type: "lead.message.delta", payload: { messageId: "m", delta: "x" } })).toBeNull();
    expect(gatewayEventOptIn({ type: "lead.tool.updated", payload: { surface: {} } })).toBe("ui_surfaces");
    expect(gatewayEventOptIn({ type: "snapshot.required", payload: { resource: "tickets" } })).toBeNull();
    // topicId on another kind of event means nothing.
    expect(gatewayEventOptIn({ type: "ticket.updated", payload: { topicId: 3 } })).toBeNull();
  });
});

describe("topic turns", () => {
  it("have their own origins: the opening is a system turn, a message ends with :topic", () => {
    expect(isTopicTurnOrigin(TOPIC_OPENING_ORIGIN)).toBe(true);
    expect(isSystemTurnOrigin(TOPIC_OPENING_ORIGIN)).toBe(true);
    expect(isTopicTurnOrigin("paired:companion:topic")).toBe(true);
    expect(isTopicTurnOrigin("paired:companion")).toBe(false);
    expect(isTopicTurnOrigin("paired:companion:ticket-agent")).toBe(false);
  });
});

describe("opening a topic", () => {
  it("takes a title and an opening, or a selected text of a turn", () => {
    expect(Value.Check(OpenTopicRequestSchema, { title: "工单协同优化", opening: "已经定了什么。" })).toBe(true);
    expect(Value.Check(OpenTopicRequestSchema, {
      quote: { source: { kind: "turn", turnId: "turn_1", role: "assistant" }, text: "先对话，后判决" },
    })).toBe(true);
    expect(Value.Check(OpenTopicRequestSchema, { title: "" })).toBe(false);
    expect(Value.Check(OpenTopicRequestSchema, { title: "字".repeat(TOPIC_TITLE_MAX_LENGTH + 1) })).toBe(false);
    expect(Value.Check(OpenTopicRequestSchema, { title: "x", other: 1 })).toBe(false);
  });

  it("makes a one-line title from the selected text, without the punctuation at its ends", () => {
    expect(topicTitleFromQuote("核查者先把问题发给执行者，")).toBe("核查者先把问题发给执行者");
    expect(topicTitleFromQuote("  先对话，\n后判决。 ")).toBe("先对话， 后判决");
    expect(topicTitleFromQuote("一".repeat(40))).toBe(`${"一".repeat(24)}…`);
    // Only punctuation was selected: the title is the text as it is, not an empty string.
    expect(topicTitleFromQuote("……")).toBe("……");
  });
});
