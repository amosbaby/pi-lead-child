// 对外提问（用户 2026-11-11、2026-11-12）：Lead 替一张工单在一个通道的对话里问了人，等待挂在那个对话上。
// 那个对话里来了别人的消息：等待了结，Lead 被叫醒，带着它的备注、是谁回的、回了什么。回的是别人写的话，所以带外部标记。
// 不为某个通道写特例：通道适配器把「别人发来的消息」这几种事件声明成 waitSignal=message。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import { tempDir } from "@pi-lead-child/core/testing";
import { registerEventKind, registerExternalEventSource } from "@pi-lead-child/protocol";
import { appendEvent, getLeadWait, listEvents, openDb, registerLeadWait, type Db } from "../src/index.js";

// 一个测试用的通道来源，事件的形状和真的通道适配器一样（engine 的 channels/payload.ts）。
const SOURCE = "testchat";
const INBOUND = "testchat.dm.received";
const OWN = "testchat.self.reply";
registerExternalEventSource(SOURCE);
const payload = Type.Object({ role: Type.String(), sender: Type.Object({ id: Type.String(), name: Type.String() }), text: Type.String() });
registerEventKind({ kind: INBOUND, sources: [SOURCE], payload, waitSignal: "message", description: "someone sent a message" });
registerEventKind({ kind: OWN, sources: [SOURCE], payload, description: "the user's own message" });

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-wait-conversation-"), "plc.db"));
});

const CONVERSATION = "testchat:D0NINA:main";
const NOTE = "工单 #12 的决定请求 #5：问 Nina 导出要不要保留删掉的行。回复来了用它回答这个问题。";

function ask() {
  return registerLeadWait(db, { entityKey: CONVERSATION, note: NOTE, origin: "question:ticket:12:decision:5" }).wait;
}

function message(options: { kind?: string; role?: string; conversation?: string; text?: string; ref: string }) {
  // 事件和它记的那次写入在同一笔事务里（appendEvent 的要求）。
  return db.transaction(() => appendEvent(db, {
    source: SOURCE, sourceRef: options.ref, kind: options.kind ?? INBOUND, entityKey: options.conversation ?? CONVERSATION,
    payload: {
      role: options.role ?? "message", sender: { id: "U0NINA", name: "Nina" },
      text: options.text ?? "Keep them, and mark them as deleted.",
    },
  }))();
}

const woke = () => listEvents(db, { kind: "lead.wait_satisfied", limit: 20 });

describe("a wait on a channel conversation", () => {
  it("ends when the other person replies there, and wakes Lead with its note, the sender and the text", () => {
    const wait = ask();
    message({ ref: "m1" });

    expect(getLeadWait(db, wait.id)).toMatchObject({ state: "satisfied" });
    const [event] = woke();
    expect(event).toMatchObject({
      level: "tell", entityKey: CONVERSATION,
      payload: { note: NOTE, origin: "question:ticket:12:decision:5", trigger: { kind: INBOUND, entityKey: CONVERSATION } },
    });
    const summary = String((event!.payload.trigger as { summary: string }).summary);
    expect(summary).toContain("Nina");
    expect(summary).toContain("Keep them, and mark them as deleted.");
  });

  it("marks the wake as external content from that source: the reply is someone else's words", () => {
    ask();
    message({ ref: "m1" });
    expect(woke()[0]!.payload).toMatchObject({ external: true, source: SOURCE, sender: "Nina" });
  });

  it("keeps a long reply readable: the summary carries up to 1200 characters of it", () => {
    ask();
    message({ ref: "m1", text: `${"a".repeat(1100)} END` });
    expect(String((woke()[0]!.payload.trigger as { summary: string }).summary)).toContain("END");
  });

  it("does not end on the user's own message or an echo of what Lead sent", () => {
    const wait = ask();
    message({ ref: "m1", kind: OWN, role: "self_reply" });
    message({ ref: "m2", role: "echo" });
    expect(getLeadWait(db, wait.id)).toMatchObject({ state: "waiting" });
    expect(woke()).toEqual([]);
  });

  it("does not end on a message in another conversation", () => {
    const wait = ask();
    message({ ref: "m1", conversation: "testchat:D0ETHAN:main" });
    expect(getLeadWait(db, wait.id)).toMatchObject({ state: "waiting" });
    expect(woke()).toEqual([]);
  });

  it("wakes Lead once: a second message finds no open wait", () => {
    ask();
    message({ ref: "m1" });
    message({ ref: "m2", text: "One more thing." });
    expect(woke()).toHaveLength(1);
  });
});
