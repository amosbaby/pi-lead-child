// Topics (protocol's topics.ts): a second Lead conversation with a clean context. Tables in schema.ts TOPICS_SCHEMA.
//
// A topic's turns live in topic_turns, never in channel_turns: the main conversation snapshot returns every row of
// channel_turns to every client, and Lead's own recovery reads its unfinished rows as Lead turns. A topic turn has
// the same columns as a channel turn (TopicTurnRow extends the same shape), so the gateway maps it to the same DTO.
//
// This file only reads and writes rows. Permission, the session and the events are in engine's ui-actions/topics.ts
// and the daemon's topics.ts.
import { randomUUID } from "node:crypto";
import {
  TOPIC_OPEN_LIMIT, TOPIC_OPENING_ORIGIN, type TopicDto, type TopicOpener, type TopicState,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";

export interface TopicRow {
  id: number;
  title: string;
  state: TopicState;
  opened_by: TopicOpener;
  origin_turn_id: string | null;
  origin_quote: string | null;
  origin_role: "assistant" | "user" | null;
  // provider/id with an optional effort suffix. null: the topic follows the main conversation's model.
  model: string | null;
  conclusion: string | null;
  concluded_at: string | null;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
}

export type TopicTurnState = "queued" | "streaming" | "completed" | "failed";

export interface TopicTurnRow {
  id: string;
  topic_id: number;
  origin_binding_id: number | null;
  origin_kind: string;
  state: TopicTurnState;
  user_text: string;
  assistant_text: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

// Every topic turn id starts with this. user-turn-authority.ts reads it to find the turn in topic_turns.
export const TOPIC_TURN_ID_PREFIX = "tturn_";

const isoNow = (now?: Date) => (now ?? new Date()).toISOString();

export class TopicLimitError extends Error {
  constructor(readonly limit: number) {
    super(`there are already ${limit} open topics`);
    this.name = "TopicLimitError";
  }
}

export function getTopic(db: Db, id: number): TopicRow | undefined {
  return db.prepare("SELECT * FROM topics WHERE id = ?").get(id) as TopicRow | undefined;
}

/** Open topics first (latest activity first), then closed ones (latest first). */
export function listTopics(db: Db, opts?: { state?: TopicState; limit?: number }): TopicRow[] {
  const where = opts?.state ? " WHERE state = ?" : "";
  return db.prepare(
    `SELECT * FROM topics${where}
     ORDER BY CASE state WHEN 'open' THEN 0 ELSE 1 END, last_activity_at DESC, id DESC LIMIT ?`,
  ).all(...(opts?.state ? [opts.state] : []), opts?.limit ?? 200) as TopicRow[];
}

export function countOpenTopics(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM topics WHERE state = 'open'").get() as { n: number }).n;
}

export function createTopic(
  db: Db,
  args: {
    title: string;
    openedBy: TopicOpener;
    originTurnId?: string | null;
    originQuote?: string | null;
    originRole?: "assistant" | "user" | null;
    now?: Date;
  },
): TopicRow {
  const timestamp = isoNow(args.now);
  return db.transaction((): TopicRow => {
    if (countOpenTopics(db) >= TOPIC_OPEN_LIMIT) throw new TopicLimitError(TOPIC_OPEN_LIMIT);
    const result = db.prepare(
      `INSERT INTO topics
        (title, state, opened_by, origin_turn_id, origin_quote, origin_role, last_activity_at, created_at, updated_at)
       VALUES (?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      args.title, args.openedBy, args.originTurnId ?? null, args.originQuote ?? null, args.originRole ?? null,
      timestamp, timestamp, timestamp,
    );
    return getTopic(db, Number(result.lastInsertRowid))!;
  })();
}

export function renameTopic(db: Db, id: number, title: string, now?: Date): TopicRow | undefined {
  db.prepare("UPDATE topics SET title = ?, updated_at = ? WHERE id = ?").run(title, isoNow(now), id);
  return getTopic(db, id);
}

/** The model of this topic only. null: follow the main conversation's model. */
export function setTopicModel(db: Db, id: number, model: string | null, now?: Date): TopicRow | undefined {
  db.prepare("UPDATE topics SET model = ?, updated_at = ? WHERE id = ?").run(model, isoNow(now), id);
  return getTopic(db, id);
}

/** Close a topic. A conclusion is kept when given; a close without one keeps the earlier conclusion. */
export function closeTopic(db: Db, id: number, conclusion: string | null, now?: Date): TopicRow | undefined {
  const timestamp = isoNow(now);
  if (conclusion === null) {
    db.prepare("UPDATE topics SET state = 'closed', updated_at = ? WHERE id = ?").run(timestamp, id);
  } else {
    db.prepare("UPDATE topics SET state = 'closed', conclusion = ?, concluded_at = ?, updated_at = ? WHERE id = ?")
      .run(conclusion, timestamp, timestamp, id);
  }
  return getTopic(db, id);
}

export function reopenTopic(db: Db, id: number, now?: Date): TopicRow | undefined {
  const timestamp = isoNow(now);
  return db.transaction((): TopicRow | undefined => {
    const topic = getTopic(db, id);
    if (!topic || topic.state === "open") return topic;
    if (countOpenTopics(db) >= TOPIC_OPEN_LIMIT) throw new TopicLimitError(TOPIC_OPEN_LIMIT);
    db.prepare("UPDATE topics SET state = 'open', updated_at = ?, last_activity_at = ? WHERE id = ?").run(timestamp, timestamp, id);
    return getTopic(db, id);
  })();
}

// ── Turns ───────────────────────────────────────────────────────────────────────

export function getTopicTurn(db: Db, id: string): TopicTurnRow | undefined {
  return db.prepare("SELECT * FROM topic_turns WHERE id = ?").get(id) as TopicTurnRow | undefined;
}

export function createTopicTurn(
  db: Db,
  args: {
    topicId: number;
    originKind: string;
    originBindingId?: number | null;
    userText?: string;
    assistantText?: string;
    state?: TopicTurnState;
    now?: Date;
  },
): TopicTurnRow {
  const id = `${TOPIC_TURN_ID_PREFIX}${randomUUID()}`;
  const timestamp = isoNow(args.now);
  return db.transaction((): TopicTurnRow => {
    db.prepare(
      `INSERT INTO topic_turns
        (id, topic_id, origin_binding_id, origin_kind, state, user_text, assistant_text, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, args.topicId, args.originBindingId ?? null, args.originKind, args.state ?? "streaming",
      args.userText ?? "", args.assistantText ?? "", timestamp, timestamp,
    );
    db.prepare("UPDATE topics SET last_activity_at = ?, updated_at = ? WHERE id = ?").run(timestamp, timestamp, args.topicId);
    return getTopicTurn(db, id)!;
  })();
}

export function appendTopicTurnDelta(db: Db, id: string, delta: string, now?: Date): void {
  db.prepare("UPDATE topic_turns SET assistant_text = assistant_text || ?, updated_at = ? WHERE id = ?")
    .run(delta, isoNow(now), id);
}

export function startTopicTurn(db: Db, id: string, now?: Date): void {
  db.prepare("UPDATE topic_turns SET state = 'streaming', updated_at = ? WHERE id = ? AND state = 'queued'").run(isoNow(now), id);
}

function settleTopicTurn(db: Db, id: string, state: "completed" | "failed", error: string | null, now?: Date): TopicTurnRow | undefined {
  const timestamp = isoNow(now);
  return db.transaction((): TopicTurnRow | undefined => {
    db.prepare("UPDATE topic_turns SET state = ?, error = ?, updated_at = ? WHERE id = ?").run(state, error, timestamp, id);
    const turn = getTopicTurn(db, id);
    if (turn) db.prepare("UPDATE topics SET last_activity_at = ?, updated_at = ? WHERE id = ?").run(timestamp, timestamp, turn.topic_id);
    return turn;
  })();
}

export function completeTopicTurn(db: Db, id: string, now?: Date): TopicTurnRow | undefined {
  return settleTopicTurn(db, id, "completed", null, now);
}

export function failTopicTurn(db: Db, id: string, error: string, now?: Date): TopicTurnRow | undefined {
  return settleTopicTurn(db, id, "failed", error, now);
}

/** The turns of a topic, oldest first. */
export function listTopicTurns(db: Db, topicId: number, opts?: { limit?: number }): TopicTurnRow[] {
  return db.prepare(
    `SELECT * FROM (
       SELECT * FROM topic_turns WHERE topic_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
     ) ORDER BY created_at, id`,
  ).all(topicId, opts?.limit ?? 500) as TopicTurnRow[];
}

/** Turns that a daemon stop left unfinished (streaming or queued), oldest first. The daemon fails them at startup. */
export function listUnfinishedTopicTurns(db: Db): TopicTurnRow[] {
  return db.prepare(
    "SELECT * FROM topic_turns WHERE state IN ('streaming', 'queued') ORDER BY created_at, id",
  ).all() as TopicTurnRow[];
}

/** The opening of a topic (its first assistant text), or null when the topic has none yet. */
export function topicOpeningText(db: Db, topicId: number): string | null {
  const row = db.prepare(
    "SELECT assistant_text FROM topic_turns WHERE topic_id = ? AND origin_kind = ? ORDER BY created_at, id LIMIT 1",
  ).get(topicId, TOPIC_OPENING_ORIGIN) as { assistant_text: string } | undefined;
  return row?.assistant_text.trim() ? row.assistant_text : null;
}

export interface MainDialogueTurn {
  id: string;
  createdAt: string;
  userText: string;
  assistantText: string;
}

/**
 * The last turns of the main conversation between the user and Lead, oldest first: what a new topic carries over.
 * Only finished turns that the user started from a paired device. Ticket chats, turns that Lead started for events
 * and daemon notices are not conversation between the two, so they are left out. upTo: no turn later than this one.
 */
export function recentMainDialogue(db: Db, opts?: { limit?: number; upTo?: string | null }): MainDialogueTurn[] {
  const cursor = opts?.upTo
    ? db.prepare("SELECT created_at, id FROM channel_turns WHERE id = ?").get(opts.upTo) as { created_at: string; id: string } | undefined
    : undefined;
  const bound = cursor ? " AND (created_at < ? OR (created_at = ? AND id <= ?))" : "";
  const rows = db.prepare(
    `SELECT id, created_at, user_text, assistant_text FROM channel_turns
     WHERE origin_kind LIKE 'paired:%' AND origin_kind NOT LIKE '%:ticket-agent' AND origin_kind NOT LIKE '%:ticket'
       AND state = 'completed' AND trim(user_text) <> ''${bound}
     ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(...(cursor ? [cursor.created_at, cursor.created_at, cursor.id] : []), opts?.limit ?? 6) as Array<{
    id: string; created_at: string; user_text: string; assistant_text: string;
  }>;
  return rows.reverse().map((row) => ({ id: row.id, createdAt: row.created_at, userText: row.user_text, assistantText: row.assistant_text }));
}

export function topicDto(db: Db, row: TopicRow): TopicDto {
  const stats = db.prepare(
    `SELECT COUNT(*) AS n, (
       SELECT id FROM topic_turns WHERE topic_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
     ) AS last FROM topic_turns WHERE topic_id = ?`,
  ).get(row.id, row.id) as { n: number; last: string | null };
  return {
    id: row.id,
    title: row.title,
    state: row.state,
    openedBy: row.opened_by,
    originTurnId: row.origin_turn_id,
    originQuote: row.origin_quote,
    originRole: row.origin_role,
    model: row.model,
    conclusion: row.conclusion,
    concludedAt: row.concluded_at,
    turnCount: stats.n,
    lastTurnId: stats.last,
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listTopicDtos(db: Db, opts?: { state?: TopicState; limit?: number }): TopicDto[] {
  return listTopics(db, opts).map((row) => topicDto(db, row));
}
