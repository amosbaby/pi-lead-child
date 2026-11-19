// 用户发给 Lead 的文件（protocol 的 chat-files.ts）：走完整的路径。App 的 chat.send 带着文件经网关进来，daemon 和这一轮
// 一起存下，再写进这一轮的文件夹（数据目录的 chat-files/<轮次>/）；交给 Lead 的消息列出每个文件的名字、类型、大小和路径，
// 不放内容；会话快照列出文件，按 id 取得到。重启后再答时，清单照样重建，文件夹里缺的文件再写一份。
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  createPairing, createTurn, insertChatFiles, listTurnChatFiles, openDb, redeemPairing, waitTurnForRetry, type Db,
} from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { chatTurnFilesDir, writeChatTurnFiles } from "../src/chat-files.js";
import { fakePiLead } from "./fake-pi-session.js";

const LOG_BYTES = Buffer.from("2026-11-19 10:00:00 error: disk full\n");
const LOG = LOG_BYTES.toString("base64");
const CSV_BYTES = Buffer.from("name,count\nalice,3\n");
const CSV = CSV_BYTES.toString("base64");

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-chat-files-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_NETWORK_RETRY_MS", "40");
  vi.stubEnv("PLC_USER_TURN_RETRY_MS", "80");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

async function start(factory: unknown) {
  daemon = await startDaemon({
    dataDir: dir, dbPath, sessionFactory: factory as never, log: () => {}, notifyDesktop: () => {}, networkProbe: async () => null,
  });
  const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat", "tickets:view"] }).code);
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2`);
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  let sent = 0;
  const send = async (command: Record<string, unknown>) => {
    const id = `cmd-${++sent}`;
    socket.send(JSON.stringify({ type: "chat.send", id, protocolVersion: 2, ...command }));
    await vi.waitFor(() => expect(events.some((event) => event.type === "command.result" && event.id === id)).toBe(true));
    return events.find((event) => event.type === "command.result" && event.id === id);
  };
  const get = async (path: string) => {
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}${path}`, {
      headers: { authorization: `Bearer ${issued.accessToken}` },
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  };
  return { events, send, get };
}

const turnState = (id: string) => db.prepare("SELECT state, user_text, assistant_text FROM channel_turns WHERE id = ?").get(id) as
  { state: string; user_text: string; assistant_text: string };

describe("files the user sends to Lead", () => {
  it("are written to the turn's folder and listed in Lead's message without their contents", async () => {
    const lead = fakePiLead(() => ({ say: "看过日志了。" }));
    const { events, send, get } = await start(lead.factory);
    const hello = events.find((event) => event.type === "hello.v2");
    expect(hello.capabilities).toContain("chat.files.v1");

    const result = await send({
      message: "这两个文件里有什么问题",
      files: [{ name: "app.log", mimeType: "text/plain", data: LOG }, { name: "../../counts.csv", mimeType: "text/csv", data: CSV }],
    });
    expect(result.success).toBe(true);
    const turnId = result.data.turnId as string;
    await vi.waitFor(() => expect(turnState(turnId)).toMatchObject({ state: "completed", assistant_text: "看过日志了。" }));

    // 文件写进这一轮自己的文件夹，内容和发的一样；跑出文件夹的名字只留下最后一段。
    const folder = chatTurnFilesDir(dir, turnId);
    expect(readFileSync(join(folder, "app.log"))).toEqual(LOG_BYTES);
    expect(readFileSync(join(folder, "counts.csv"))).toEqual(CSV_BYTES);
    expect(existsSync(join(dir, "counts.csv"))).toBe(false);

    const prompt = lead.prompts[0]!;
    expect(prompt).toContain('<user_files count="2">');
    expect(prompt).toContain(`1. app.log · text/plain · ${LOG_BYTES.length} B · ${join(folder, "app.log")}`);
    expect(prompt).toContain(`2. counts.csv · text/csv · ${CSV_BYTES.length} B · ${join(folder, "counts.csv")}`);
    expect(prompt).toMatch(/<user_message[^>]* files="2">\n这两个文件里有什么问题\n<\/user_message>/u);
    // 内容不进上下文。
    expect(prompt).not.toContain("disk full");
    expect(prompt).not.toContain("alice,3");

    const { items } = await get("/v1/conversation/turns?include=files");
    const listed = items.find((item: any) => item.id === turnId);
    expect(listed.files.map(({ name, mimeType, size }: any) => ({ name, mimeType, size }))).toEqual([
      { name: "app.log", mimeType: "text/plain", size: LOG_BYTES.length },
      { name: "counts.csv", mimeType: "text/csv", size: CSV_BYTES.length },
    ]);
    expect(await get(`/v1/chat/files/${listed.files[0].id}`)).toEqual({
      id: listed.files[0].id, name: "app.log", mimeType: "text/plain", size: LOG_BYTES.length, data: LOG,
    });
    // 不要 files 的旧客户端拿到的记录和以前一样。
    const old = await get("/v1/conversation/turns?include=tool_calls,images,quotes");
    expect(old.items.every((item: any) => !("files" in item))).toBe(true);
  });

  it("answers a message that has only a file", async () => {
    const lead = fakePiLead(() => ({ say: "收到文件。" }));
    const { send } = await start(lead.factory);

    const result = await send({ message: "", files: [{ name: "app.log", data: LOG }] });
    expect(result.success).toBe(true);
    await vi.waitFor(() => expect(turnState(result.data.turnId)).toMatchObject({ state: "completed", user_text: "" }));
    expect(lead.prompts[0]).toContain("1. app.log · application/octet-stream");
    expect(lead.prompts[0]).toMatch(/<user_message[^>]* files="1">\n\n<\/user_message>/u);
  });

  it("refuses files in a ticket conversation and keeps nothing", async () => {
    const lead = fakePiLead(() => ({ say: "收到。" }));
    const { send } = await start(lead.factory);

    const result = await send({ message: "看看", context: { ticketId: 1 }, files: [{ name: "app.log", data: LOG }] });
    expect(result).toMatchObject({ success: false, error: { code: "invalid_request", message: "files are only accepted in the Lead conversation" } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_files").get()).toEqual({ n: 0 });
    expect(existsSync(join(dir, "chat-files"))).toBe(false);
  });

  it("rebuilds the file list after a restart, and writes the files again when the folder is gone", async () => {
    const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat"] }).code);
    const waiting = createTurn(db, {
      originBindingId: issued.binding.id, originKind: "paired:companion", userText: "重启前没答上的", state: "streaming",
    });
    insertChatFiles(db, waiting.id, [{ name: "app.log", mimeType: "text/plain", data: LOG_BYTES }]);
    waitTurnForRetry(db, waiting.id, "socket hang up");
    rmSync(join(dir, "chat-files"), { recursive: true, force: true });

    const lead = fakePiLead(() => ({ say: "收到。" }));
    daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {}, notifyDesktop: () => {}, networkProbe: async () => null,
    });
    await vi.waitFor(() => expect(turnState(waiting.id)).toMatchObject({ state: "completed", assistant_text: "收到。" }));
    const prompt = lead.prompts.find((candidate) => candidate.includes("重启前没答上的"))!;
    const path = join(chatTurnFilesDir(dir, waiting.id), "app.log");
    expect(prompt).toContain(`1. app.log · text/plain · ${LOG_BYTES.length} B · ${path}`);
    expect(readFileSync(path)).toEqual(LOG_BYTES);
  });
});

describe("the turn's file folder", () => {
  it("writes the home directory as ~ and keeps every file inside the folder", () => {
    const home = dir;
    const dataDir = join(dir, ".pi-lead-child");
    const turn = createTurn(db, { originKind: "paired:companion", userText: "" });
    insertChatFiles(db, turn.id, [
      { name: "a.txt", mimeType: "text/plain", data: LOG_BYTES },
      { name: "a.txt", mimeType: "text/plain", data: CSV_BYTES },
    ]);
    const listed = writeChatTurnFiles(dataDir, turn.id, listTurnChatFiles(db, turn.id), { home });
    expect(listed.map((file) => file.path)).toEqual([
      `~/.pi-lead-child/chat-files/${turn.id}/a.txt`, `~/.pi-lead-child/chat-files/${turn.id}/a (2).txt`,
    ]);
    expect(readFileSync(join(chatTurnFilesDir(dataDir, turn.id), "a (2).txt"))).toEqual(CSV_BYTES);
    // 磁盘上的名字带目录时不写。
    const [stored] = listTurnChatFiles(db, turn.id);
    expect(() => writeChatTurnFiles(dataDir, "turn-x", [{ ...stored!, diskName: "../escape" }], { home })).toThrow(/escapes/u);
    expect(existsSync(join(dataDir, "chat-files", "escape"))).toBe(false);
    // 外部通道给的轮次编号带别的字符时，文件夹用它的散列。
    expect(chatTurnFilesDir(dataDir, "slack:T1/C2")).toMatch(/chat-files\/turn-[0-9a-f]{32}$/u);
  });
});
