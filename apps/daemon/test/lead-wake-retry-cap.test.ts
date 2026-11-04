// Lead 的模型一直不可用时，叫醒它的自动重试有上限（工单 #21，来自 #18 的调查）。
// 2026-11-03 17:41 起 DeepSeek 不可用，带事的回合每 5 分钟重试一次直到午夜，252 次失败请求，没有失败上限；
// key 一恢复，每次重试带约 10 万 token 上下文。现在：连续失败到上限就停下，通知用户；Lead 的任何一次成功回合清掉停止状态。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { addInbox, createItem, createPairing, listNotifications, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

const MAX_FAILURES = 3;
const KEY_REJECTED = "401 Unauthorized: invalid api key";
const BLOCKER = "Run #7 crashed";

beforeEach(() => {
  dir = tempDir("plc-lead-wake-retry-cap-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_LEAD_WAKE_RETRY_MS", "20");
  vi.stubEnv("PLC_LEAD_WAKE_MAX_FAILURES", String(MAX_FAILURES));
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

// 模型是否可用由测试切换；不可用时每次调用都以 401 失败。
function lead() {
  const listeners: Array<(event: any) => void> = [];
  const prompts: string[] = [];
  const model = { up: false };
  const factory = async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      async prompt(message: string) {
        prompts.push(message);
        for (const listener of listeners) {
          if (model.up) {
            listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "收到。" } });
            listener({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "收到。" }] } });
          } else {
            listener({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: KEY_REJECTED, content: [] } });
          }
        }
      },
      async steer() {},
      async followUp() {},
      dispose() {},
    },
  });
  // 交给 Lead 的事：<system_event kind="inbox"> 里写着它。当前局面也会列出这张工单，不能按标题数。
  const delivered = new RegExp(`<system_event kind="inbox"[^>]*>\\n[^\\n]*${BLOCKER}`, "u");
  return { factory, prompts, model, withBlocker: () => prompts.filter((prompt) => delivered.test(prompt)).length };
}

async function start(stub: ReturnType<typeof lead>) {
  daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: stub.factory as never, log: () => {}, triageShadow: false });
  const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat"] }).code);
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2`);
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  return async (message: string) => {
    socket.send(JSON.stringify({ type: "chat.send", id: "cmd-1", protocolVersion: 2, message }));
    await vi.waitFor(() => expect(events.some((event) => event.type === "command.result")).toBe(true));
  };
}

const blocker = (summary: string) => addInbox(db, {
  itemId: createItem(db, { title: summary, brief: "b", createdBy: "system" }), severity: "blocker", source: "structural", summary, lossless: true,
});
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stoppedNotices = () => listNotifications(db).filter((row) => row.kind === "lead_retry_stopped");

describe("waking Lead while its model keeps failing", () => {
  // 回归：以前没有上限，退避封顶 5 分钟以后一直重试。
  it("stops retrying after the failure cap and tells the user once", async () => {
    const stub = lead();
    await start(stub);
    blocker(BLOCKER);

    await vi.waitFor(() => expect(stub.withBlocker()).toBe(MAX_FAILURES), { timeout: 10_000 });
    // 退避是 20、40 毫秒：没有上限时，这段时间里还会再试几次。
    await pause(600);
    expect(stub.withBlocker()).toBe(MAX_FAILURES);
    await vi.waitFor(() => expect(stoppedNotices()).toHaveLength(1));
    expect(stoppedNotices()[0]).toMatchObject({ urgency: "immediate", title: expect.stringContaining(String(MAX_FAILURES)) });
  }, 30_000);

  it("resumes with the next successful turn and hands the waiting event over", async () => {
    const stub = lead();
    const send = await start(stub);
    blocker(BLOCKER);
    await vi.waitFor(() => expect(stoppedNotices()).toHaveLength(1), { timeout: 10_000 });
    expect(stub.withBlocker()).toBe(MAX_FAILURES);

    // 用户换了可用的 key 以后发一条消息：这一轮成功，停止状态清掉，没处理的事交给 Lead。
    stub.model.up = true;
    await send("在吗");
    await vi.waitFor(() => expect(stub.withBlocker()).toBe(MAX_FAILURES + 1), { timeout: 10_000 });
    await pause(300);
    expect(stub.withBlocker()).toBe(MAX_FAILURES + 1);
  }, 30_000);
});
