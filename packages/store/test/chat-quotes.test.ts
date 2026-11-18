// 用户消息带的引用按轮次存（chat_quotes，由 SCHEMA 建，不占迁移号）。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";

import { insertChatQuotes, listChatQuoteRefs, listTurnChatQuotes, type StoredChatQuote } from "../src/chat-quotes.js";
import { createTurn } from "../src/conversations.js";
import { openDb, type Db } from "../src/db.js";

let path: string;
let db: Db;
beforeEach(() => {
  path = join(tempDir("plc-"), "plc.db");
  db = openDb(path);
});

const leadQuote: StoredChatQuote = {
  source: { kind: "turn", turnId: "turn-a", role: "assistant" }, author: "lead",
  text: "空闲时到 0.7 倍就会提前压缩", note: "能调到 0.5 吗？", anchor: "s0:b1",
};
const cardQuote: StoredChatQuote = {
  source: { kind: "card", cardId: 7 }, author: "external", text: "明天能上线吗",
  external: { source: "slack", sender: "Nina", conversation: "#proj-demo" },
};

describe("chat quotes", () => {
  it("keeps a turn's quotes in the order they were added, with the external source note", () => {
    const turn = createTurn(db, { originKind: "paired:companion", userText: "这两处一起看下" });
    insertChatQuotes(db, turn.id, [leadQuote, cardQuote]);

    expect(listTurnChatQuotes(db, turn.id)).toEqual([leadQuote, cardQuote]);
  });

  it("lists the quotes of several turns for the snapshot, without the external source note", () => {
    const first = createTurn(db, { originKind: "paired:companion", userText: "" });
    const plain = createTurn(db, { originKind: "paired:companion", userText: "没有引用" });
    insertChatQuotes(db, first.id, [leadQuote, cardQuote]);

    const refs = listChatQuoteRefs(db, [first.id, plain.id]);
    const { external: _external, ...cardRef } = cardQuote;
    expect(refs.get(first.id)).toEqual([leadQuote, cardRef]);
    expect(refs.has(plain.id)).toBe(false);
    expect(listChatQuoteRefs(db, []).size).toBe(0);
  });

  it("keeps the table on reopen", () => {
    const turn = createTurn(db, { originKind: "paired:companion", userText: "" });
    insertChatQuotes(db, turn.id, [leadQuote]);
    db.close();
    db = openDb(path);
    expect(listTurnChatQuotes(db, turn.id)).toEqual([leadQuote]);
  });
});
