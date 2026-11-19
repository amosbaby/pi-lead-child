// 发给 Lead 的文件（protocol 的 chat-files.ts）：网关宣布能力、校验并解码文件、清理名字、交给 chatV2；按 id 取文件；
// 会话快照列出文件。
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { Value } from "typebox/value";
import {
  CHAT_FILE_MAX_BYTES, CHAT_FILES_CAPABILITY, ChatFileSchema, ConversationTurnSchema, HelloV2Schema,
} from "@pi-lead-child/protocol";
import {
  createPairing, createTurn, insertChatFiles, openDb, redeemPairing, type ChatFileData, type Db,
} from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";

import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";

const LOG = Buffer.from("2026-11-19 error: disk full\n").toString("base64");
// 1×1 的透明 PNG：图片也可以当文件发。
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-"), "plc.db"));
});

function runtime() {
  return { model: "stub/model", sessionId: "stub-session", busy: false, runningItemIds: [], aish: null };
}

function issue() {
  const { code } = createPairing(db, { name: "web", kind: "companion", scopes: ["chat", "tickets:view"] });
  return redeemPairing(db, code);
}

type Chat = { message: string; itemId?: number; files?: ChatFileData[] };

async function start(options: { chatFiles?: boolean } = {}) {
  const chats: Chat[] = [];
  const server = await startPairedServer({
    db,
    controlPlane: createControlPlaneService(db, { runtime }),
    hello: runtime,
    chat: () => "started",
    addClient: () => () => {},
    log: () => {},
    chatV2: (command: Chat) => { chats.push(command); return { mode: "started" as const, turnId: `turn-${chats.length}` }; },
    ...(options.chatFiles === false ? {} : { chatFiles: true }),
    ticketMessageV2: () => ({ mode: "started", turnId: "ticket-turn" }),
  }, { port: 0 });
  return { server, chats };
}

async function connect(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/paired/events?token=${token}&protocol=2`);
  const messages: any[] = [];
  ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(messages.some((message) => message.type === "hello.v2")).toBe(true));
  const send = async (command: Record<string, unknown>) => {
    ws.send(JSON.stringify({ type: "chat.send", protocolVersion: 2, ...command }));
    await vi.waitFor(() => expect(messages.some((message) => message.type === "command.result" && message.id === command.id))
      .toBe(true), { timeout: 10_000 });
    return messages.find((message) => message.type === "command.result" && message.id === command.id);
  };
  return { ws, messages, send };
}

function post(port: number, token: string, body: Record<string, unknown>) {
  return fetch(`http://127.0.0.1:${port}/v1/chat/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("chat files over the paired gateway", () => {
  it("announces the capability only when the daemon says it takes files", async () => {
    const issued = issue();
    for (const chatFiles of [true, false]) {
      const { server, chats } = await start({ chatFiles });
      const client = await connect(server.port, issued.accessToken);
      try {
        const hello = client.messages.find((message) => message.type === "hello.v2");
        expect(Value.Check(HelloV2Schema, hello)).toBe(true);
        expect(hello.capabilities.includes(CHAT_FILES_CAPABILITY)).toBe(chatFiles);
        if (!chatFiles) {
          expect(await client.send({ id: "cmd-old", message: "x", files: [{ name: "a.log", data: LOG }] }))
            .toMatchObject({ success: false, error: { message: "this daemon does not accept files" } });
          expect(chats).toEqual([]);
        }
      } finally {
        client.ws.close();
        await server.close();
      }
    }
  });

  it("decodes the files of a WebSocket chat.send, cleans their names and hands them to Lead in order", async () => {
    const issued = issue();
    const { server, chats } = await start();
    const client = await connect(server.port, issued.accessToken);
    try {
      const result = await client.send({
        id: "cmd-1", message: "看看这几个文件",
        files: [
          { name: "app.log", mimeType: "Text/Plain; charset=utf-8", data: LOG },
          { name: "../../x", data: PNG },
          { name: "C:\\Users\\alice\\empty.txt", mimeType: "text/plain", data: "" },
        ],
      });
      expect(result).toMatchObject({ success: true, data: { mode: "started", turnId: "turn-1" } });
      expect(chats[0]!.files?.map(({ name, mimeType }) => ({ name, mimeType }))).toEqual([
        { name: "app.log", mimeType: "text/plain" },
        { name: "x", mimeType: "application/octet-stream" },
        { name: "empty.txt", mimeType: "text/plain" },
      ]);
      expect(chats[0]!.files?.[0]!.data.equals(Buffer.from(LOG, "base64"))).toBe(true);
      expect(chats[0]!.files?.[2]!.data.length).toBe(0);
    } finally {
      client.ws.close();
      await server.close();
    }
  });

  it("accepts a message with only files and refuses bad names, bad base64, too many files and files for a ticket", async () => {
    const issued = issue();
    const { server, chats } = await start();
    const client = await connect(server.port, issued.accessToken);
    try {
      expect(await client.send({ id: "cmd-file-only", message: "", files: [{ name: "a.log", data: LOG }] }))
        .toMatchObject({ success: true });
      for (const [id, name] of [["cmd-dots", ".."], ["cmd-dir", "logs/"], ["cmd-control", "a\nb.log"]] as const) {
        expect(await client.send({ id, message: "x", files: [{ name, data: LOG }] }))
          .toMatchObject({ success: false, error: { code: "invalid_request" } });
      }
      expect(await client.send({ id: "cmd-base64", message: "x", files: [{ name: "a.log", data: "not base64!" }] }))
        .toMatchObject({ success: false, error: { code: "invalid_request", message: "file 1 is not valid base64" } });
      expect(await client.send({
        id: "cmd-many", message: "x", files: Array.from({ length: 6 }, () => ({ name: "a.log", data: LOG })),
      })).toMatchObject({ success: false, error: { code: "invalid_request" } });
      expect(await client.send({
        id: "cmd-ticket", message: "x", context: { ticketId: 7 }, files: [{ name: "a.log", data: LOG }],
      })).toMatchObject({ success: false, error: { message: "files are only accepted in the Lead conversation" } });
      expect(chats.map((chat) => chat.message)).toEqual([""]);
    } finally {
      client.ws.close();
      await server.close();
    }
  });

  it("takes 5 full-size files over WebSocket and HTTP, and refuses a file over 10 MB", async () => {
    const issued = issue();
    const { server, chats } = await start();
    const client = await connect(server.port, issued.accessToken);
    const full = Buffer.alloc(CHAT_FILE_MAX_BYTES, 7);
    const files = Array.from({ length: 5 }, (_, index) => ({ name: `part-${index}.bin`, data: full.toString("base64") }));
    try {
      expect(await client.send({ id: "cmd-full", message: "五个大文件", files })).toMatchObject({ success: true });
      const response = await post(server.port, issued.accessToken, { id: "cmd-full-http", message: "五个大文件", files });
      expect(response.status).toBe(200);
      expect(chats.map((chat) => chat.files?.length)).toEqual([5, 5]);
      expect(chats[1]!.files?.[4]!.data.equals(full)).toBe(true);

      const over = Buffer.alloc(CHAT_FILE_MAX_BYTES + 1, 7).toString("base64");
      const refused = await post(server.port, issued.accessToken, { id: "cmd-over", message: "x", files: [{ name: "big.bin", data: over }] });
      expect(refused.status).toBe(400);
      expect(chats).toHaveLength(2);
    } finally {
      client.ws.close();
      await server.close();
    }
  }, 60_000);

  it("serves a stored file by id to a chat binding and lists a turn's files only when asked", async () => {
    const issued = issue();
    const turn = createTurn(db, { originKind: "paired:companion", userText: "文件在这里", state: "completed" });
    const plain = createTurn(db, { originKind: "paired:companion", userText: "没有文件", state: "completed" });
    const [ref] = insertChatFiles(db, turn.id, [{ name: "app.log", mimeType: "text/plain", data: Buffer.from(LOG, "base64") }]);
    const { server } = await start();
    const get = (path: string, token = issued.accessToken) =>
      fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { authorization: `Bearer ${token}` } });
    try {
      const file = await get(`/v1/chat/files/${ref!.id}`);
      expect(file.status).toBe(200);
      const body = await file.json();
      expect(Value.Check(ChatFileSchema, body)).toBe(true);
      expect(body).toEqual({ id: ref!.id, name: "app.log", mimeType: "text/plain", size: ref!.size, data: LOG });
      expect((await get("/v1/chat/files/file_missing")).status).toBe(404);
      expect((await get("/v1/chat/files/..%2Fplc.db")).status).toBe(404);
      expect((await get(`/v1/chat/files/${ref!.id}`, "wrong-token")).status).toBe(401);

      const withFiles = await (await get("/v1/conversation/turns?include=tool_calls,files")).json();
      for (const item of withFiles.items) expect(Value.Check(ConversationTurnSchema, item)).toBe(true);
      expect(withFiles.items.find((item: any) => item.id === turn.id).files)
        .toEqual([{ id: ref!.id, name: "app.log", mimeType: "text/plain", size: ref!.size }]);
      expect(withFiles.items.find((item: any) => item.id === plain.id).files).toBeUndefined();
      // 不要 files 的旧客户端拿到的记录和以前一样。
      const without = await (await get("/v1/conversation/turns?include=tool_calls,images,quotes")).json();
      expect(without.items.every((item: any) => !("files" in item))).toBe(true);
    } finally {
      await server.close();
    }
  });
});
