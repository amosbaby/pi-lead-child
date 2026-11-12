// 外部工人 hub 的存储层（v68，表在 schema.ts 的 WORKER_HUB_SCHEMA）。
// 工单的来源（Slack、Jira、Notion、手动）、Lead 对工单的判断（能不能自动处理、复杂度）、用户说「没找到」的记录。
// ticket_pushes：每张工单最多一条推给用户私信的「待你处理」消息（engine 的 worker-queue/pushes.ts），和推送的两个开关（Slack 私信、桌面通知）。
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
 * 记一条对话里的来源（通道卡、用户私信）。来自通道卡的（cardId）同一张工单同一张卡只记一次，和 v68 回填同一条规则；
 * 没有卡的（用户私信）同一张工单同一个位置 (kind, conversation, message_ts) 只记一次。
 * 没有 externalKey，不去重到别的工单。记下了返回 true，已经有了返回 false。
 */
export function addConversationSource(
  db: Db, source: {
    itemId: number; kind: TicketSourceKind; conversation: string; messageTs?: string | null; cardId?: number | null; url?: string | null; now?: Date;
  },
): boolean {
  return db.transaction((): boolean => {
    const messageTs = source.messageTs ?? null;
    const cardId = source.cardId ?? null;
    const existing = cardId === null
      ? db.prepare(
        "SELECT 1 FROM ticket_sources WHERE item_id = ? AND kind = ? AND conversation = ? AND message_ts IS ? AND card_id IS NULL LIMIT 1",
      ).get(source.itemId, source.kind, source.conversation, messageTs)
      : db.prepare("SELECT 1 FROM ticket_sources WHERE item_id = ? AND kind = ? AND card_id = ? LIMIT 1").get(source.itemId, source.kind, cardId);
    if (existing) return false;
    db.prepare(
      "INSERT INTO ticket_sources (item_id, kind, url, conversation, message_ts, card_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(source.itemId, source.kind, source.url ?? null, source.conversation, messageTs, cardId, (source.now ?? new Date()).toISOString());
    return true;
  })();
}

/** 撤掉一张工单的处理方式判断（handling、handling_reason 改回 NULL），复杂度留着。工单不存在时抛错。 */
export function clearHandling(db: Db, itemId: number): void {
  const result = db.prepare("UPDATE items SET handling = NULL, handling_reason = NULL, updated_at = datetime('now') WHERE id = ?").run(itemId);
  if (result.changes !== 1) throw new Error(`clearHandling: item ${itemId} does not exist`);
}

/** 改一张工单是不是来自外部来源（external_origin）。只改这一列，不碰 stage 和别的生命周期字段。工单不存在时抛错。 */
export function setExternalOrigin(db: Db, itemId: number, external: boolean): void {
  const result = db.prepare("UPDATE items SET external_origin = ? WHERE id = ?").run(external ? 1 : 0, itemId);
  if (result.changes !== 1) throw new Error(`setExternalOrigin: item ${itemId} does not exist`);
}

/** 这张工单是不是来自外部来源（external_origin = 1）。工单不存在时 false。派生的单（子单、续作、后台检查的轻工单）照它继承。 */
export function isExternalOrigin(db: Db, itemId: number | null | undefined): boolean {
  if (itemId === null || itemId === undefined) return false;
  const row = db.prepare("SELECT external_origin FROM items WHERE id = ?").get(itemId) as { external_origin: number } | undefined;
  return row?.external_origin === 1;
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

export const TICKET_MISS_BY = ["user", "lead"] as const;
export type TicketMissBy = (typeof TICKET_MISS_BY)[number];

/** 记一次「没找到」（用户的原话）。by 是谁记的：user 是用户自己，lead 是 Lead 调操作记的。 */
export function recordMiss(db: Db, text: string, by: TicketMissBy, now: Date = new Date()): void {
  if (text.trim() === "") throw new Error("miss text must not be blank");
  if (!(TICKET_MISS_BY as readonly string[]).includes(by)) throw new Error(`miss by ${String(by)} is not one of ${TICKET_MISS_BY.join(", ")}`);
  db.prepare("INSERT INTO ticket_misses (text, by, created_at) VALUES (?, ?, ?)").run(text, by, now.toISOString());
}

/** 从 since 起（含）记了几次「没找到」。给 by 时只数那一方记的，不给时都数。 */
export function missesSince(db: Db, since: Date, by?: TicketMissBy): number {
  const row = by === undefined
    ? db.prepare("SELECT COUNT(*) AS n FROM ticket_misses WHERE created_at >= ?").get(since.toISOString())
    : db.prepare("SELECT COUNT(*) AS n FROM ticket_misses WHERE created_at >= ? AND by = ?").get(since.toISOString(), by);
  return (row as { n: number }).n;
}

// ── 待你处理推送（ticket_pushes，engine 的 worker-queue/pushes.ts）────────────────────────────

export interface TicketPush {
  itemId: number;
  // 第一次推的原因（needs_user、handed_back）；之后又变成「待你处理」时换成那一次的原因。
  reason: string | null;
  // 推到的用户自己的私信。没有私信、Slack 私信推送关着时是 null（只弹了桌面通知）。
  conversation: string | null;
  // 那条消息在来源里的位置（例如 Slack 的 channel、ts）。还没发出去时是 null。
  messageRef: Record<string, string> | null;
  // 用户现在看到的状态（消息上写的，或者桌面通知弹的）。
  shownState: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TicketPushRow {
  item_id: number; reason: string | null; conversation: string | null; message_ref: string | null; shown_state: string | null;
  created_at: string; updated_at: string;
}

export function getTicketPush(db: Db, itemId: number): TicketPush | null {
  const row = db.prepare("SELECT * FROM ticket_pushes WHERE item_id = ?").get(itemId) as TicketPushRow | undefined;
  return row ? {
    itemId: row.item_id, reason: row.reason, conversation: row.conversation,
    messageRef: row.message_ref ? JSON.parse(row.message_ref) as Record<string, string> : null,
    shownState: row.shown_state, createdAt: row.created_at, updatedAt: row.updated_at,
  } : null;
}

/** 记下一张要推的工单。这张单推过（不管推到哪里）时不记，返回 false。 */
export function insertTicketPush(db: Db, input: {
  itemId: number; reason: string; conversation: string | null; shownState: string; now: Date;
}): boolean {
  const at = input.now.toISOString();
  return db.prepare(
    `INSERT OR IGNORE INTO ticket_pushes (item_id, reason, conversation, message_ref, shown_state, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?)`,
  ).run(input.itemId, input.reason, input.conversation, input.shownState, at, at).changes === 1;
}

const TICKET_PUSH_BASELINE_KEY = "ticket_push.baseline_at";

/** 推送的基线时间（engine 的 ensureTicketPushBaseline 记的）。还没有基线时 null。 */
export function ticketPushBaselineAt(db: Db): string | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(TICKET_PUSH_BASELINE_KEY) as { value: string } | undefined;
  return row ? row.value : null;
}

/**
 * 记下基线：基线时间，和那一刻已经「待你处理」的每张单一行不发的推送（没有私信，shown_state 是那时的状态）。
 * 已经有推送行的单不动。调用方包在事务里。
 */
export function insertTicketPushBaseline(db: Db, input: { items: Array<{ itemId: number; state: string }>; now: Date }): void {
  const at = input.now.toISOString();
  const row = db.prepare(
    `INSERT OR IGNORE INTO ticket_pushes (item_id, reason, conversation, message_ref, shown_state, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, ?, ?, ?)`,
  );
  for (const item of input.items) row.run(item.itemId, item.state, item.state, at, at);
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(TICKET_PUSH_BASELINE_KEY, at);
}

/** 那条消息发出去了：记下它在来源里的位置和消息上的状态。 */
export function setTicketPushMessage(db: Db, itemId: number, ref: Record<string, string>, shownState: string, now: Date): void {
  db.prepare("UPDATE ticket_pushes SET message_ref = ?, shown_state = ?, updated_at = ? WHERE item_id = ?")
    .run(JSON.stringify(ref), shownState, now.toISOString(), itemId);
}

/** 用户现在看到的状态改成了 shownState。reason 给了时一起换（又变成「待你处理」）。 */
export function setTicketPushShown(db: Db, itemId: number, input: { shownState: string; reason?: string; now: Date }): void {
  db.prepare("UPDATE ticket_pushes SET shown_state = ?, reason = COALESCE(?, reason), updated_at = ? WHERE item_id = ?")
    .run(input.shownState, input.reason ?? null, input.now.toISOString(), itemId);
}

/** 以后不再碰来源里的那条消息（例如用户删了它）：只当作弹过桌面通知。 */
export function detachTicketPushMessage(db: Db, itemId: number, now: Date): void {
  db.prepare("UPDATE ticket_pushes SET conversation = NULL, updated_at = ? WHERE item_id = ?").run(now.toISOString(), itemId);
}

/**
 * 可能要同步的推送：除了消息上已经是结束状态（done、cancelled）、工单也还是那个状态的。按工单编号。
 * 状态比较在 engine 里做（状态是从工单、Run 算出来的）。
 */
export function openTicketPushes(db: Db): number[] {
  return (db.prepare(
    `SELECT p.item_id AS id FROM ticket_pushes p JOIN items i ON i.id = p.item_id
     WHERE NOT (p.shown_state IN ('done','cancelled') AND i.stage = p.shown_state)
     ORDER BY p.item_id`,
  ).all() as Array<{ id: number }>).map((row) => row.id);
}

// 推送的两个开关（设置 → 消息通道 → 待你处理推送）：Slack 私信、桌面通知。存在 kv，缺省开；读到的值坏了时按缺省（开）算。
// 改它走 engine 的操作层 ticket_push（页面和 Lead 调同一个函数）。
export const TICKET_PUSH_CHANNELS = ["slack_dm", "desktop"] as const;
export type TicketPushChannel = (typeof TICKET_PUSH_CHANNELS)[number];

export interface TicketPushSetting {
  channel: TicketPushChannel;
  enabled: boolean;
  // 最近一次修改。从没改过时都是 null。
  updatedAt: string | null;
  updatedBy: "user" | "lead" | null;
}

const ticketPushKey = (channel: TicketPushChannel) => `ticket_push.${channel}`;

export function isTicketPushChannel(value: string): value is TicketPushChannel {
  return (TICKET_PUSH_CHANNELS as readonly string[]).includes(value);
}

/** 开关现在的样子。从没改过、读不到时是开。 */
export function getTicketPushSetting(db: Db, channel: TicketPushChannel): TicketPushSetting {
  const fallback: TicketPushSetting = { channel, enabled: true, updatedAt: null, updatedBy: null };
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(ticketPushKey(channel)) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    const stored = JSON.parse(row.value) as { enabled?: unknown; updatedAt?: unknown; updatedBy?: unknown };
    if (typeof stored.enabled !== "boolean") return fallback;
    return {
      channel, enabled: stored.enabled,
      updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : null,
      updatedBy: stored.updatedBy === "user" || stored.updatedBy === "lead" ? stored.updatedBy : null,
    };
  } catch {
    return fallback;
  }
}

/** 写入开关。返回写入以后的样子。 */
export function writeTicketPushSetting(
  db: Db, channel: TicketPushChannel, enabled: boolean, meta: { by: "user" | "lead"; at: Date },
): TicketPushSetting {
  const setting: TicketPushSetting = { channel, enabled, updatedAt: meta.at.toISOString(), updatedBy: meta.by };
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(ticketPushKey(channel), JSON.stringify({ enabled, updatedAt: setting.updatedAt, updatedBy: setting.updatedBy }));
  return setting;
}
