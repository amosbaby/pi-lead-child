// Topics (user 2026-11-25, design rules P18 and theme 11.26).
//
// A topic is a second Lead conversation with a clean context. The user opens one to discuss a large subject without
// the events that enter Lead's main conversation. A topic has the same Lead (identity, tools, skills, memory), its own
// session file and its own turns. The main conversation continues to handle events while a topic is open.
//
// Two entries open a topic, and both call the same operation (topics.open, engine's ui-actions/topics.ts):
//   - Lead's open_topic tool, when the user asks in the main conversation. Lead writes the opening itself.
//   - The page ("Side chat" on a text selection). The topic's own session writes the opening as its first turn.
//
// Wire contract:
//   - The event type table is frozen. The turns of a topic use the lead.turn.started, lead.message.delta,
//     lead.message.completed and lead.tool.* types with `topicId` in the payload. They go only to connections that
//     declared include=topics (gatewayEventOptIn): an old client would show them in the main conversation.
//   - A change to a topic (opened, renamed, closed, a turn failed) sends snapshot.required with resource "topics",
//     also only to include=topics connections.
//   - A turn of a topic has the shape of a conversation turn (ConversationTurnSchema, index.ts), so the client uses
//     the same message store and components. The detail response is defined in index.ts for that reason.
//   - Topic turns live in their own table (store's topics.ts), never in channel_turns: the main conversation snapshot
//     returns every row of channel_turns to every client.
// This file does not import index.ts (index.ts re-exports from here).
import { Type, type Static, type TProperties } from "typebox";
import { ChatFilesInputSchema } from "./chat-files.ts";
import { ChatImagesInputSchema } from "./chat-images.ts";
import { CHAT_QUOTE_TEXT_MAX_LENGTH, ChatQuoteSourceSchema } from "./chat-quotes.ts";
import { registerEventKind, type EventKindDefinition } from "./events.ts";
import { LeadModelChoiceSchema } from "./lead-models.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const LEAD_TOPICS_CAPABILITY = "lead.topics.v1";
export const TOPICS_RESOURCE = "topics";
// The include= value a connection declares to get topic events.
export const TOPICS_OPT_IN = "topics";

export const TOPIC_TITLE_MAX_LENGTH = 80;
export const TOPIC_OPENING_MAX_LENGTH = 6000;
export const TOPIC_CONCLUSION_MAX_LENGTH = 4000;
export const TOPIC_MESSAGE_MAX_LENGTH = 100_000;
// How many open topics can exist at a time. Each open topic can hold a live session in the daemon.
export const TOPIC_OPEN_LIMIT = 20;

// The origin kinds of a topic's turns. The opening is a system turn (no user text). A user turn ends with :topic, as a
// ticket-agent turn ends with :ticket-agent.
export const TOPIC_OPENING_ORIGIN = "system:topic-opening";
export const TOPIC_USER_ORIGIN_SUFFIX = ":topic";

// The fixed errors of a topic turn. The daemon stores the code; the client shows the words in the user's language.
// An error from the model is stored as the provider gave it (secrets removed), as in the main conversation.
export const TOPIC_TURN_ERRORS = {
  // The model ended the turn without any text.
  emptyReply: "topic.empty_reply",
  // The daemon stopped while the reply was being written.
  restarted: "topic.restarted",
  // The topic's session could not be built.
  sessionUnavailable: "topic.session_unavailable",
  // The session could not switch to the topic's model. The stored error is this code, ": " and the model.
  modelUnavailable: "topic.model_unavailable",
} as const;

export const TOPIC_STATES = ["open", "closed"] as const;
export type TopicState = typeof TOPIC_STATES[number];

// Who opened the topic: the user on the page, or Lead with its tool (in a turn of the main conversation).
export const TOPIC_OPENERS = ["user", "lead"] as const;
export type TopicOpener = typeof TOPIC_OPENERS[number];

export const TopicSchema = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  title: Type.String({ minLength: 1 }),
  state: Type.Union([Type.Literal("open"), Type.Literal("closed")]),
  openedBy: Type.Union([Type.Literal("user"), Type.Literal("lead")]),
  // The turn of the main conversation the topic came from: the Lead turn that called open_topic, or the turn that
  // holds the selected text. The main conversation draws its reference to the topic at this turn. null: none.
  originTurnId: Type.Union([Type.String(), Type.Null()]),
  // The selected text and who wrote it. null when the topic did not start from a selection.
  originQuote: Type.Union([Type.String(), Type.Null()]),
  originRole: Type.Union([Type.Literal("assistant"), Type.Literal("user"), Type.Null()]),
  // The model this topic uses, as provider/id with an optional effort suffix (leadModelSpec). null: the topic follows
  // the model of Lead's main conversation. Set with topic.set_model, from the model name on the topic's input.
  model: Type.Union([Type.String(), Type.Null()]),
  // What the topic decided, written when the topic is closed with a conclusion. The main conversation shows it.
  conclusion: Type.Union([Type.String(), Type.Null()]),
  concludedAt: Type.Union([Type.String(), Type.Null()]),
  turnCount: Type.Integer({ minimum: 0 }),
  // The last turn of the topic. A device compares it with the last turn it showed, to mark a new reply.
  lastTurnId: Type.Union([Type.String(), Type.Null()]),
  lastActivityAt: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type TopicDto = Static<typeof TopicSchema>;

// GET /v1/topics
export const TopicsResponseSchema = StrictObject({ topics: Type.Array(TopicSchema) });
export type TopicsResponse = Static<typeof TopicsResponseSchema>;

// topics.open (the page and Lead's open_topic).
//   title: optional on the page; the system makes one from the quote.
//   opening: Lead's own summary of what it brings (decided, open, related objects). It becomes the first message of
//     the topic as written. Without it, the topic's session writes the opening.
//   quote: the selected text and where it is. The daemon checks that the text is in that turn.
export const OpenTopicRequestSchema = StrictObject({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: TOPIC_TITLE_MAX_LENGTH })),
  opening: Type.Optional(Type.String({ minLength: 1, maxLength: TOPIC_OPENING_MAX_LENGTH })),
  quote: Type.Optional(StrictObject({
    source: ChatQuoteSourceSchema,
    text: Type.String({ minLength: 1, maxLength: CHAT_QUOTE_TEXT_MAX_LENGTH }),
  })),
});
export type OpenTopicRequest = Static<typeof OpenTopicRequestSchema>;

// topic.rename
export const RenameTopicRequestSchema = StrictObject({
  title: Type.String({ minLength: 1, maxLength: TOPIC_TITLE_MAX_LENGTH }),
});
export type RenameTopicRequest = Static<typeof RenameTopicRequestSchema>;

// topic.close. conclusion: what the topic decided, what stays open and the next steps. The main conversation gets it.
export const CloseTopicRequestSchema = StrictObject({
  conclusion: Type.Optional(Type.String({ minLength: 1, maxLength: TOPIC_CONCLUSION_MAX_LENGTH })),
});
export type CloseTopicRequest = Static<typeof CloseTopicRequestSchema>;

// topic.set_model. choice: the model and effort for this topic only. null: follow the main conversation's model again.
// The main conversation's model does not change. The next message in the topic uses the new model.
export const SetTopicModelRequestSchema = StrictObject({
  choice: Type.Union([LeadModelChoiceSchema, Type.Null()]),
});
export type SetTopicModelRequest = Static<typeof SetTopicModelRequestSchema>;

// topic.reopen
export const ReopenTopicRequestSchema = StrictObject({});
export type ReopenTopicRequest = Static<typeof ReopenTopicRequestSchema>;

// POST /v1/topics/:id/messages
// images and files have the shape and the limits of a message in the main conversation (chat-images.ts,
// chat-files.ts); the gateway checks and decodes them with the same code. A message with an image or a file can have
// no text. A daemon accepts them in a topic when it accepts them in the main conversation (its chat capabilities).
export const SendTopicMessageRequestSchema = StrictObject({
  text: Type.String({ maxLength: TOPIC_MESSAGE_MAX_LENGTH }),
  images: Type.Optional(ChatImagesInputSchema),
  files: Type.Optional(ChatFilesInputSchema),
});
export type SendTopicMessageRequest = Static<typeof SendTopicMessageRequestSchema>;

export const SendTopicMessageResponseSchema = StrictObject({
  topicId: Type.Integer({ minimum: 1 }),
  turnId: Type.String(),
  // queued: the topic was answering another message; this one starts when that turn ends.
  state: Type.Union([Type.Literal("streaming"), Type.Literal("queued")]),
});
export type SendTopicMessageResponse = Static<typeof SendTopicMessageResponseSchema>;

// A title for a topic that the user opened from a selection: the first words of the selected text, on one line.
export function topicTitleFromQuote(text: string, max = 24): string {
  // A selection often ends in the middle of a sentence: punctuation at either end says nothing in a title.
  const line = text.replace(/\s+/gu, " ").trim().replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "");
  const chars = Array.from(line);
  if (chars.length <= max) return line || text.replace(/\s+/gu, " ").trim();
  return `${chars.slice(0, max).join("").trimEnd()}…`;
}

export function isTopicTurnOrigin(originKind: string | null | undefined): boolean {
  return typeof originKind === "string"
    && (originKind === TOPIC_OPENING_ORIGIN || originKind.endsWith(TOPIC_USER_ORIGIN_SUFFIX));
}

// ── The event: a topic brought its conclusion back ────────────────────────────────────────────

// Written when a topic is closed with a conclusion (engine's ui-actions/topics.ts). Record level: it wakes nobody.
// Lead's main conversation reads it in its situation at the next turn, so the main Lead knows what the topic decided
// without the topic's turns in its context. The user was in the topic and has the conclusion already (the main
// conversation shows a row for it), so the event is not something to tell the user again.
export const TOPIC_CONCLUDED_KIND = "topic.concluded";
// The triage basis of the event: a hard rule that standing orders do not change.
export const TOPIC_CONCLUDED_REPORTED = "topic_concluded_reported";

export const TopicConcludedPayloadSchema = Type.Object({
  topicId: Type.Integer({ minimum: 1 }),
  title: Type.String(),
  conclusion: Type.String(),
  // Who closed the topic: the topic's Lead (it wrote the conclusion in the user's turn there), or the user on the page.
  actor: Type.Union([Type.Literal("user"), Type.Literal("lead")]),
});
export type TopicConcludedPayload = Static<typeof TopicConcludedPayloadSchema>;

export const TOPIC_EVENT_KINDS: readonly EventKindDefinition[] = [
  {
    kind: TOPIC_CONCLUDED_KIND,
    sources: ["system"],
    payload: TopicConcludedPayloadSchema,
    description: "A topic was closed with a conclusion: what it decided, what stays open, the next steps.",
  },
];

for (const definition of TOPIC_EVENT_KINDS) registerEventKind(definition);
