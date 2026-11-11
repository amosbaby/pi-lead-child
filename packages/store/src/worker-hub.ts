// 外部工人 hub 的存储层（v68，表在 schema.ts 的 WORKER_HUB_SCHEMA）。
// 工单的来源（Slack、Jira、Notion、手动）、Lead 对工单的判断（能不能自动处理、复杂度）、用户说「没找到」的记录。
// ticket_pushes（推给用户私信的消息）只有表，读写由用到它的模块加。
import type { Db } from "./db.js";

export const TICKET_SOURCE_KINDS = ["slack", "jira", "notion", "manual"] as const;
export type TicketSourceKind = (typeof TICKET_SOURCE_KINDS)[number];
export const TICKET_HANDLINGS = ["auto", "needs_user"] as const;
export type TicketHandling = (typeof TICKET_HANDLINGS)[number];
export const TICKET_COMPLEXITIES = ["simple", "medium", "complex"] as const;
export type TicketComplexity = (typeof TICKET_COMPLEXITIES)[number];

export interface NewTicketSource {
  itemId: number;
  kind: TicketSourceKind;
  // 来源的链接。拼不出来时不给。
  url?: string | null;
  // 来源里的编号（例如 Jira 的 key）。给了就按 (kind, externalKey) 去重。
  externalKey?: string | null;
  conversation?: string | null;
  messageTs?: string | null;
  now?: Date;
}

export interface TicketSource {
  id: number;
  itemId: number;
  kind: TicketSourceKind;
  url: string | null;
  externalKey: string | null;
  conversation: string | null;
  messageTs: string | null;
  createdAt: string;
}

interface TicketSourceRow {
  id: number; item_id: number; kind: TicketSourceKind; url: string | null; external_key: string | null;
  conversation: string | null; message_ts: string | null; created_at: string;
}

const assertKind = (kind: string): void => {
  if (!(TICKET_SOURCE_KINDS as readonly string[]).includes(kind)) throw new Error(`ticket source kind ${String(kind)} is not one of ${TICKET_SOURCE_KINDS.join(", ")}`);
};

/**
 * 记一条来源，返回这条来源所属的工单：同一个 (kind, externalKey) 已经属于别的工单时，什么都不记，返回那张已有的工单；
 * 否则记在给定的工单上，返回它。没有 externalKey 的来源不去重。kind 不在清单里、externalKey 是空白、工单不存在时抛错。
 */
export function addTicketSource(db: Db, source: NewTicketSource): number {
  assertKind(source.kind);
  const externalKey = source.externalKey ?? null;
  if (externalKey !== null && externalKey.trim() === "") throw new Error("ticket source externalKey must not be blank");
  return db.transaction((): number => {
    if (externalKey !== null) {
      const existing = findItemByExternalKey(db, source.kind, externalKey);
      if (existing !== null) return existing;
    }
    db.prepare(
      "INSERT INTO ticket_sources (item_id, kind, url, external_key, conversation, message_ts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(source.itemId, source.kind, source.url ?? null, externalKey, source.conversation ?? null, source.messageTs ?? null,
      (source.now ?? new Date()).toISOString());
    return source.itemId;
  })();
}

/**
 * 一个通道（来源插件的 id，例如对话键的第一段）对应的来源种类：本身就是来源种类清单里的一个时用它，别的都是 manual。
 * 代码里不写来源的名字（通道内核不点名来源，spec D14）：只按清单认。
 */
export function ticketSourceKindOf(channel: string): TicketSourceKind {
  return channel !== "manual" && (TICKET_SOURCE_KINDS as readonly string[]).includes(channel) ? channel as TicketSourceKind : "manual";
}

/**
 * 记一条对话里的来源（通道卡、用户私信），同一张工单同一个位置 (kind, conversation, message_ts) 只记一次，和 v68 回填同一条规则。
 * 没有 externalKey，不去重到别的工单。记下了返回 true，已经有了返回 false。
 */
export function addConversationSource(
  db: Db, source: { itemId: number; kind: TicketSourceKind; conversation: string; messageTs?: string | null; url?: string | null; now?: Date },
): boolean {
  return db.transaction((): boolean => {
    const messageTs = source.messageTs ?? null;
    const existing = db.prepare(
      "SELECT 1 FROM ticket_sources WHERE item_id = ? AND kind = ? AND conversation = ? AND message_ts IS ? LIMIT 1",
    ).get(source.itemId, source.kind, source.conversation, messageTs);
    if (existing) return false;
    addTicketSource(db, {
      itemId: source.itemId, kind: source.kind, conversation: source.conversation, messageTs, url: source.url ?? null,
      ...(source.now ? { now: source.now } : {}),
    });
    return true;
  })();
}

/** 把一张工单记成来自外部来源（external_origin = 1）。只改这一列，不碰 stage 和别的生命周期字段。工单不存在时抛错。 */
export function markExternalOrigin(db: Db, itemId: number): void {
  const result = db.prepare("UPDATE items SET external_origin = 1 WHERE id = ?").run(itemId);
  if (result.changes !== 1) throw new Error(`markExternalOrigin: item ${itemId} does not exist`);
}

/** 一张工单的来源，按记下的先后。 */
export function ticketSources(db: Db, itemId: number): TicketSource[] {
  const rows = db.prepare("SELECT * FROM ticket_sources WHERE item_id = ? ORDER BY id").all(itemId) as TicketSourceRow[];
  return rows.map((row) => ({
    id: row.id, itemId: row.item_id, kind: row.kind, url: row.url, externalKey: row.external_key,
    conversation: row.conversation, messageTs: row.message_ts, createdAt: row.created_at,
  }));
}

/** 这个来源编号属于哪张工单。没有时 null。 */
export function findItemByExternalKey(db: Db, kind: TicketSourceKind, key: string): number | null {
  const row = db.prepare("SELECT item_id FROM ticket_sources WHERE kind = ? AND external_key = ?").get(kind, key) as { item_id: number } | undefined;
  return row ? row.item_id : null;
}

/**
 * 写下 Lead 对一张工单的判断，整个换掉上一次的：没给 complexity 时它变回 NULL。只改判断的三列和 updated_at，
 * 不碰 stage 和别的生命周期字段。工单不存在、值不在清单里时抛错。
 */
export function setHandling(
  db: Db, itemId: number, judgment: { handling: TicketHandling; reason: string; complexity?: TicketComplexity },
): void {
  if (!(TICKET_HANDLINGS as readonly string[]).includes(judgment.handling)) throw new Error(`handling ${String(judgment.handling)} is not one of ${TICKET_HANDLINGS.join(", ")}`);
  if (judgment.complexity !== undefined && !(TICKET_COMPLEXITIES as readonly string[]).includes(judgment.complexity)) {
    throw new Error(`complexity ${String(judgment.complexity)} is not one of ${TICKET_COMPLEXITIES.join(", ")}`);
  }
  const result = db.prepare(
    "UPDATE items SET handling = ?, handling_reason = ?, complexity = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(judgment.handling, judgment.reason, judgment.complexity ?? null, itemId);
  if (result.changes !== 1) throw new Error(`setHandling: item ${itemId} does not exist`);
}

/** 记一次「没找到」（用户的原话）。 */
export function recordMiss(db: Db, text: string, now: Date = new Date()): void {
  if (text.trim() === "") throw new Error("miss text must not be blank");
  db.prepare("INSERT INTO ticket_misses (text, created_at) VALUES (?, ?)").run(text, now.toISOString());
}

/** 从 since 起（含）记了几次「没找到」。 */
export function missesSince(db: Db, since: Date): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM ticket_misses WHERE created_at >= ?").get(since.toISOString()) as { n: number }).n;
}
