// Topics (protocol's topics.ts): what the read routes return.
//   GET /v1/topics       the topics, open ones first.
//   GET /v1/topics/:id   one topic and its turns.
// A turn of a topic is mapped to the conversation turn DTO, with its tool calls folded from the same ledger events as
// the main conversation (protocol's foldTurnToolCalls), so a refresh shows what the live events showed.
// The write routes are in paired-server.ts: opening, renaming and closing go through the operation layer
// (POST /v1/actions/topics/…), a message goes to the daemon's topic runtime.
import { foldTurnToolCalls, type ConversationTurn, type Scope, type TopicDetailResponse, type TopicsResponse } from "@pi-lead-child/protocol";
import {
  getTopic, listChatFileRefs, listChatImageRefs, listTopicDtos, listTopicTurns, listTurnToolEvents, topicDto,
  type Db, type TopicTurnRow,
} from "@pi-lead-child/store";

export function topicsResponse(db: Db): TopicsResponse {
  return { topics: listTopicDtos(db) };
}

// images, files: what the user sent with the turn (the same tables and ids as in the main conversation; the client
// gets one by id from /v1/chat/images/:id and /v1/chat/files/:id). Left out when the turn has none.
function topicTurnDto(
  turn: TopicTurnRow, toolCalls: ConversationTurn["toolCalls"],
  attachments: { images?: ConversationTurn["images"]; files?: ConversationTurn["files"] },
): ConversationTurn {
  return {
    id: turn.id,
    originBindingId: turn.origin_binding_id,
    originKind: turn.origin_kind,
    ticketId: null,
    state: turn.state,
    userText: turn.user_text,
    assistantText: turn.assistant_text,
    error: turn.error,
    createdAt: turn.created_at,
    updatedAt: turn.updated_at,
    toolCalls: toolCalls ?? [],
    ...(attachments.images?.length ? { images: attachments.images } : {}),
    ...(attachments.files?.length ? { files: attachments.files } : {}),
  };
}

/** null: there is no such topic. scopes: the reader's scopes; tool events it cannot read are left out. */
export function topicDetailResponse(db: Db, topicId: number, scopes: readonly Scope[]): TopicDetailResponse | null {
  const row = getTopic(db, topicId);
  if (!row) return null;
  const turns = listTopicTurns(db, topicId);
  const turnIds = turns.map((turn) => turn.id);
  const toolEvents = listTurnToolEvents(db, turnIds, { scopes });
  const images = listChatImageRefs(db, turnIds);
  const files = listChatFileRefs(db, turnIds);
  return {
    topic: topicDto(db, row),
    turns: turns.map((turn) => topicTurnDto(
      turn, foldTurnToolCalls(toolEvents.get(turn.id) ?? []), { images: images.get(turn.id), files: files.get(turn.id) },
    )),
  };
}
