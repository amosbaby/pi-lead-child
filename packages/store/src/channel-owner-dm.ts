// 用户自己私信里的决定请求和工单的来源对话（工单 #81，表在 schema.ts 的 CHANNEL_OWNER_DM_SCHEMA）。
// 决定请求：每条最多推一次（decision_id 是主键）；同一张工单在一段时间里的几条合在一条消息里（message_key 相同）；
// 消息上显示的状态（shown_state）和决定请求的状态不一样时，daemon 改写那条消息。
// 工单的来源对话：用户在自己私信那一轮里让 Lead 建的工单，之后 Lead 为它写给用户的话同步发回那个私信。
import type { Db } from "./db.js";
import { addConversationSource, ticketSourceKindOf } from "./worker-hub.js";

export interface DecisionPush {
  decisionId: number;
  itemId: number;
  conversation: string;
  messageKey: string;
  // 那条消息在来源里的位置（例如 Slack 的 channel、ts）。还没发出去时是 null。
  messageRef: Record<string, string> | null;
  shownState: string;
  recommended: string | null;
  recommendReason: string | null;
  createdAt: string;
}

interface DecisionPushRow {
  decision_id: number;
  item_id: number;
  conversation: string;
  message_key: string;
  message_ref: string | null;
  shown_state: string;
  recommended: string | null;
  recommend_reason: string | null;
  created_at: string;
}

function parsePush(row: DecisionPushRow): DecisionPush {
  return {
    decisionId: row.decision_id, itemId: row.item_id, conversation: row.conversation, messageKey: row.message_key,
    messageRef: row.message_ref ? JSON.parse(row.message_ref) as Record<string, string> : null,
    shownState: row.shown_state, recommended: row.recommended, recommendReason: row.recommend_reason, createdAt: row.created_at,
  };
}

/** 记下一条要推到私信的决定请求。这条已经推过（不管在哪条消息里）时不记，返回 false。 */
export function insertDecisionPush(db: Db, input: {
  decisionId: number; itemId: number; conversation: string; messageKey: string; shownState: string;
  recommended?: string | null; recommendReason?: string | null; now: Date;
}): boolean {
  const result = db.prepare(
    `INSERT OR IGNORE INTO channel_decision_pushes
       (decision_id, item_id, conversation, message_key, shown_state, recommended, recommend_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.decisionId, input.itemId, input.conversation, input.messageKey, input.shownState,
    input.recommended ?? null, input.recommendReason ?? null, input.now.toISOString(),
  );
  return result.changes === 1;
}

export function getDecisionPush(db: Db, decisionId: number): DecisionPush | null {
  const row = db.prepare("SELECT * FROM channel_decision_pushes WHERE decision_id = ?").get(decisionId) as DecisionPushRow | undefined;
  return row ? parsePush(row) : null;
}

/** 一条消息里的决定请求，按推的先后。 */
export function listDecisionPushes(db: Db, messageKey: string): DecisionPush[] {
  return (db.prepare("SELECT * FROM channel_decision_pushes WHERE message_key = ? ORDER BY created_at, decision_id")
    .all(messageKey) as DecisionPushRow[]).map(parsePush);
}

/** 那条消息发出去了：记下它在来源里的位置。 */
export function setDecisionPushMessage(db: Db, messageKey: string, ref: Record<string, string>): void {
  db.prepare("UPDATE channel_decision_pushes SET message_ref = ? WHERE message_key = ?").run(JSON.stringify(ref), messageKey);
}

/** 消息上显示的状态改成了 state。 */
export function setDecisionPushShown(db: Db, decisionId: number, state: string): void {
  db.prepare("UPDATE channel_decision_pushes SET shown_state = ? WHERE decision_id = ?").run(state, decisionId);
}

/**
 * 同一个对话、同一张工单还能合进去的那条消息：第一条是 since 以后推的，里面不到 max 条。没有时返回 null。
 * 只合进 Lead 以外（执行者）的决定请求的消息：Lead 在私信那一轮画的卡各自一条（key 以 turn: 开头）。
 */
export function openDecisionMessage(db: Db, args: { conversation: string; itemId: number; since: Date; max: number }): string | null {
  const row = db.prepare(
    `SELECT message_key FROM channel_decision_pushes
     WHERE conversation = ? AND item_id = ? AND message_key LIKE 'push:%'
     GROUP BY message_key
     HAVING MIN(created_at) >= ? AND COUNT(*) < ?
     ORDER BY MIN(created_at) DESC LIMIT 1`,
  ).get(args.conversation, args.itemId, args.since.toISOString(), args.max) as { message_key: string } | undefined;
  return row?.message_key ?? null;
}

/**
 * 要发或者要改写的消息：since 以后记下、还没发出去的（更早的不再发：过了这么久才冒出来的选项没有用），
 * 或者发出去了、有一条决定请求的状态和消息上显示的不一样。
 */
export function decisionMessagesToSync(db: Db, args: { unsentSince: Date }): string[] {
  return (db.prepare(
    `SELECT DISTINCT p.message_key AS key FROM channel_decision_pushes p
     JOIN decision_requests d ON d.id = p.decision_id
     WHERE (p.message_ref IS NULL AND p.created_at >= ?) OR (p.message_ref IS NOT NULL AND p.shown_state <> d.state)
     ORDER BY p.message_key`,
  ).all(args.unsentSince.toISOString()) as Array<{ key: string }>).map((row) => row.key);
}

/**
 * 还没推过、要用户回答的执行者决定请求（受众是 user、还在等、since 以后提的），按编号。只要 Lead 判断的（lead、lead_or_user）不推。
 * Lead 在会话里画的卡（origin lead）平时由那一轮自己发（私信那一轮）；lead 为 true 时也算上（工单 #101：用户在 App 里看着它建出来、
 * 没回答就离开了 App，同步到 Slack 私信开着）。
 */
export function unpushedUserDecisions(db: Db, args: { since: Date; lead?: boolean }): Array<{ id: number; itemId: number; origin: "agent" | "lead" }> {
  return (db.prepare(
    `SELECT d.id AS id, d.item_id AS itemId, d.origin AS origin FROM decision_requests d
     WHERE (d.origin = 'agent' OR (? = 1 AND d.origin = 'lead')) AND d.audience = 'user' AND d.state = 'pending' AND d.created_at >= ?
       AND NOT EXISTS (SELECT 1 FROM channel_decision_pushes p WHERE p.decision_id = d.id)
     ORDER BY d.id`,
  ).all(args.lead ? 1 : 0, args.since.toISOString()) as Array<{ id: number; itemId: number; origin: "agent" | "lead" }>);
}

/**
 * 记下这张工单是用户在哪个私信对话里让 Lead 建的。已经记过时不改，返回 false。
 * 同时记进来源表（worker-hub.ts 的 ticket_sources，v68 回填的同一个形状）：种类按对话键的第一段（来源插件的 id），
 * 对话是这个私信，没有消息位置。
 */
export function recordTicketOrigin(db: Db, input: { itemId: number; conversation: string; now: Date }): boolean {
  return db.transaction((): boolean => {
    const result = db.prepare("INSERT OR IGNORE INTO channel_ticket_origins (item_id, conversation, created_at) VALUES (?, ?, ?)")
      .run(input.itemId, input.conversation, input.now.toISOString());
    if (result.changes !== 1) return false;
    addConversationSource(db, {
      itemId: input.itemId, kind: ticketSourceKindOf(input.conversation.split(":")[0] ?? ""), conversation: input.conversation, now: input.now,
    });
    return true;
  })();
}

/**
 * 这些工单的来源私信对话：工单自己记的，没有时看它的上级工单（执行者拆出来的子工单）。没有记的工单不出现。去重。
 */
export function ticketOriginConversations(db: Db, itemIds: readonly number[]): string[] {
  const found = new Set<string>();
  const lookup = db.prepare(
    `WITH RECURSIVE chain(id, depth) AS (
       SELECT ?, 0
       UNION ALL
       SELECT i.parent_item_id, chain.depth + 1 FROM items i JOIN chain ON i.id = chain.id
       WHERE i.parent_item_id IS NOT NULL AND chain.depth < 20
     )
     SELECT o.conversation FROM chain JOIN channel_ticket_origins o ON o.item_id = chain.id ORDER BY chain.depth LIMIT 1`,
  );
  for (const itemId of new Set(itemIds)) {
    const row = lookup.get(itemId) as { conversation: string } | undefined;
    if (row) found.add(row.conversation);
  }
  return [...found];
}

/**
 * 这一轮里 Lead 建的工单（编号大于 afterItemId、Lead 建的、不是执行者拆的）：记下来源私信对话。返回记下的工单。
 * Lead 的轮次一轮接一轮地跑，这一轮开始时记下最大的工单编号，结束时按它找。
 */
export function recordTurnTicketOrigins(db: Db, input: { afterItemId: number; conversation: string; now: Date }): number[] {
  const ids = (db.prepare("SELECT id FROM items WHERE id > ? AND created_by = 'lead' AND created_by_run_id IS NULL ORDER BY id")
    .all(input.afterItemId) as Array<{ id: number }>).map((row) => row.id);
  return ids.filter((itemId) => recordTicketOrigin(db, { itemId, conversation: input.conversation, now: input.now }));
}

/** 现在最大的工单编号（没有工单时是 0）。 */
export function latestItemId(db: Db): number {
  return (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM items").get() as { id: number }).id;
}

const ownerConversationKey = (source: string) => `channel.owner_conversation.${source}`;

/** 记下用户自己的私信（用户在里面和 Lead 说话的那个对话）和那个私信凭证。主动推送用它找私信。 */
export function rememberOwnerConversation(db: Db, input: { source: string; conversation: string; bindingId: number }): void {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(ownerConversationKey(input.source), JSON.stringify({ conversation: input.conversation, bindingId: input.bindingId }));
}

/** 用户自己的私信。没有记过，或者那个私信凭证撤销了（设置 → 设备）时返回 null。 */
export function ownerConversationOf(db: Db, source: string): string | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(ownerConversationKey(source)) as { value: string } | undefined;
  if (!row) return null;
  const { conversation, bindingId } = JSON.parse(row.value) as { conversation?: unknown; bindingId?: unknown };
  if (typeof conversation !== "string" || typeof bindingId !== "number") return null;
  const binding = db.prepare("SELECT status FROM bindings WHERE id = ?").get(bindingId) as { status: string } | undefined;
  return binding && binding.status !== "revoked" ? conversation : null;
}

// 「我不在看 App 时，把 Lead 的消息同步到我的 Slack 私信」开关（工单 #88）。存在 kv，缺省关。
// 读到的值坏了（手改、截断）时按关算。改它走 engine 的操作层 owner_dm_sync（页面和 Lead 调同一个函数）。
export const OWNER_DM_SYNC_KEY = "channel.owner_dm_sync";

export interface OwnerDmSyncSetting {
  enabled: boolean;
  // 最近一次修改。从没改过时都是 null。
  updatedAt: string | null;
  updatedBy: "user" | "lead" | null;
}

/** 开关现在的样子。从没改过、读不到时是关。 */
export function getOwnerDmSync(db: Db): OwnerDmSyncSetting {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(OWNER_DM_SYNC_KEY) as { value: string } | undefined;
  if (!row) return { enabled: false, updatedAt: null, updatedBy: null };
  try {
    const stored = JSON.parse(row.value) as { enabled?: unknown; updatedAt?: unknown; updatedBy?: unknown };
    return {
      enabled: stored.enabled === true,
      updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : null,
      updatedBy: stored.updatedBy === "user" || stored.updatedBy === "lead" ? stored.updatedBy : null,
    };
  } catch {
    return { enabled: false, updatedAt: null, updatedBy: null };
  }
}

/** 写入开关。返回写入以后的样子。 */
export function writeOwnerDmSync(db: Db, enabled: boolean, meta: { by: "user" | "lead"; at: Date }): OwnerDmSyncSetting {
  const setting: OwnerDmSyncSetting = { enabled, updatedAt: meta.at.toISOString(), updatedBy: meta.by };
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(OWNER_DM_SYNC_KEY, JSON.stringify(setting));
  return setting;
}
