// 用户消息带的引用（protocol 的 chat-quotes.ts，设计规范 P17）。表在 schema.ts 的 chat_quotes（由 SCHEMA 建，不占迁移号）。
import type { ChatQuoteAuthor, ChatQuoteRef, ChatQuoteSource } from "@pi-lead-child/protocol";

import type { Db } from "./db.js";

// 外来消息卡引用的来源说明：交给 Lead 时写进外部内容的标签（source、sender、conversation）。
export interface ChatQuoteExternal {
  source: string;
  sender: string;
  conversation: string;
}

export interface StoredChatQuote extends ChatQuoteRef {
  external?: ChatQuoteExternal;
}

interface QuoteRow {
  turn_id: string;
  source_kind: string;
  source_turn_id: string | null;
  source_role: string | null;
  source_card_id: number | null;
  author: string;
  text: string;
  note: string | null;
  anchor: string | null;
  external: string | null;
}

const isoNow = (now?: Date) => (now ?? new Date()).toISOString();

// 存下一轮带的引用，按给的顺序。调用方和建这一轮放在同一个事务里。
export function insertChatQuotes(db: Db, turnId: string, quotes: readonly StoredChatQuote[], now?: Date): void {
  const insert = db.prepare(
    `INSERT INTO chat_quotes (turn_id, position, source_kind, source_turn_id, source_role, source_card_id, author, text, note, anchor, external, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const createdAt = isoNow(now);
  quotes.forEach((quote, position) => {
    const source = quote.source;
    insert.run(
      turnId, position, source.kind,
      source.kind === "turn" ? source.turnId : null,
      source.kind === "turn" ? source.role : null,
      source.kind === "card" ? source.cardId : null,
      quote.author, quote.text, quote.note ?? null, quote.anchor ?? null,
      quote.external ? JSON.stringify(quote.external) : null, createdAt,
    );
  });
}

function sourceOf(row: QuoteRow): ChatQuoteSource | null {
  if (row.source_kind === "turn" && row.source_turn_id && (row.source_role === "assistant" || row.source_role === "user")) {
    return { kind: "turn", turnId: row.source_turn_id, role: row.source_role };
  }
  if (row.source_kind === "card" && row.source_card_id !== null) return { kind: "card", cardId: row.source_card_id };
  return null;
}

function parseExternal(text: string | null): ChatQuoteExternal | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as Partial<ChatQuoteExternal>;
    if (typeof value.source === "string" && typeof value.sender === "string" && typeof value.conversation === "string") {
      return { source: value.source, sender: value.sender, conversation: value.conversation };
    }
  } catch {
    // 坏的 JSON 当作没有来源说明。
  }
  return undefined;
}

function quoteOf(row: QuoteRow): StoredChatQuote | null {
  const source = sourceOf(row);
  if (!source) return null;
  const author = row.author as ChatQuoteAuthor;
  const external = parseExternal(row.external);
  return {
    source, author, text: row.text,
    ...(row.note ? { note: row.note } : {}),
    ...(row.anchor ? { anchor: row.anchor } : {}),
    ...(external ? { external } : {}),
  };
}

// 一轮带的引用，按加入的顺序，带外来消息卡的来源说明（交给 Lead 用）。没有时是空数组。
export function listTurnChatQuotes(db: Db, turnId: string): StoredChatQuote[] {
  const rows = db.prepare("SELECT * FROM chat_quotes WHERE turn_id = ? ORDER BY position").all(turnId) as QuoteRow[];
  return rows.map(quoteOf).filter((quote): quote is StoredChatQuote => quote !== null);
}

// 几轮各带了哪些引用（会话快照用，不带来源说明）。没有引用的轮次不在结果里。
export function listChatQuoteRefs(db: Db, turnIds: readonly string[]): Map<string, ChatQuoteRef[]> {
  const refs = new Map<string, ChatQuoteRef[]>();
  if (!turnIds.length) return refs;
  const rows = db.prepare(
    `SELECT * FROM chat_quotes WHERE turn_id IN (SELECT value FROM json_each(?)) ORDER BY turn_id, position`,
  ).all(JSON.stringify(turnIds)) as QuoteRow[];
  for (const row of rows) {
    const quote = quoteOf(row);
    if (!quote) continue;
    const { external: _external, ...ref } = quote;
    const list = refs.get(row.turn_id) ?? [];
    list.push(ref);
    refs.set(row.turn_id, list);
  }
  return refs;
}
