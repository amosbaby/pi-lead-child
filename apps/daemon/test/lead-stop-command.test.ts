// /stop（用户 2026-11-03）：Lead 的一条 bash 命令 15 分钟没有结束，用户发的 /stop 只是一条普通消息，要等那条命令结束，
// Lead 才看得到。现在 daemon 自己答 /stop：中断正在跑的这一轮（模型调用和工具），这一轮按完成收尾，末尾加一句
// 「已用 /stop 停下」，不给失败卡片，也不自动重试。下一轮开头告诉 Lead 一次，免得它自己接着做。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createPairing, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { isStopCommand } from "@pi-lead-child/protocol";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-lead-stop-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

// block：先说一句话、开始跑一条 bash，然后一直等，直到被中断。中断时像 pi 一样发出 stopReason=aborted 的 message_end。
// block-reject：一样等着，中断时这次调用以错误结束。answer：直接回答。
type Script = "block" | "block-reject" | "answer";

function lead(scripts: Script[]) {
  const listeners: Array<(event: any) => void> = [];
  const prompts: string[] = [];
  const steered: string[] = [];
  let release: (() => void) | null = null;
  let running: Promise<void> | null = null;
  let aborts = 0;
  const emit = (event: unknown) => { for (const listener of [...listeners]) listener(event); };
  const say = (text: string) => emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
  const factory = async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      prompt(message: string) {
        prompts.push(message);
        const script = scripts.shift() ?? "answer";
        running = (async () => {
          if (script === "answer") {
            say("收到。");
            emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "收到。" }] } });
            return;
          }
          say("我先在仓库里搜一下。");
          emit({
            type: "message_end",
            message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "我先在仓库里搜一下。" }, { type: "toolCall" }] },
          });
          emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "grep -rln electron ." } });
          await new Promise<void>((resolve) => { release = resolve; });
          release = null;
          emit({
            type: "tool_execution_end", toolCallId: "call-1", toolName: "bash",
            result: { content: [{ type: "text", text: "Command aborted" }] }, isError: true,
          });
          if (script === "block-reject") throw new Error("aborted");
          emit({ type: "message_end", message: { role: "assistant", stopReason: "aborted", content: [] } });
        })();
        return running;
      },
      async abort() {
        aborts += 1;
        release?.();
        await running?.catch(() => {});
      },
      async steer(text: string) { steered.push(text); },
      async followUp() {},
      clearQueue() { return { steering: [], followUp: [] }; },
      dispose() { release?.(); },
    },
  });
  return { factory, prompts, steered, blocked: () => release !== null, aborts: () => aborts };
}

async function start(stub: ReturnType<typeof lead>) {
  daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: stub.factory as never, log: () => {} });
  const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat"] }).code);
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2`);
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  let sent = 0;
  const send = async (message: string) => {
    const id = `cmd-${++sent}`;
    socket.send(JSON.stringify({ type: "chat.send", id, protocolVersion: 2, message }));
    await vi.waitFor(() => expect(events.some((event) => event.type === "command.result" && event.id === id)).toBe(true));
    return events.find((event) => event.type === "command.result" && event.id === id).data.turnId as string;
  };
  return { events, send };
}

const turn = (id: string) => db.prepare("SELECT state, error, assistant_text FROM channel_turns WHERE id=?").get(id) as
  { state: string; error: string | null; assistant_text: string };

describe("isStopCommand", () => {
  it("matches a message that is only /stop", () => {
    expect(isStopCommand("/stop")).toBe(true);
    expect(isStopCommand("  /STOP \n")).toBe(true);
    expect(isStopCommand("/stop now")).toBe(false);
    expect(isStopCommand("please /stop")).toBe(false);
    expect(isStopCommand("stop")).toBe(false);
  });
});

describe("the /stop command", () => {
  for (const script of ["block", "block-reject"] as const) {
    it(`stops the running turn and its tool, and the turn ends as done (${script})`, async () => {
      const stub = lead([script]);
      const { events, send } = await start(stub);
      const running = await send("我想打包一个 desktop app，你有什么建议");
      await vi.waitFor(() => expect(stub.blocked()).toBe(true));

      const stop = await send("/stop");

      await vi.waitFor(() => expect(turn(stop)).toMatchObject({ state: "completed" }));
      expect(turn(stop).assistant_text).toContain("Stopped the turn that");
      expect(stub.aborts()).toBe(1);
      await vi.waitFor(() => expect(turn(running)).toMatchObject({
        state: "completed", error: null, assistant_text: "我先在仓库里搜一下。\n\nStopped with /stop.",
      }));
      // /stop 不交给 Lead：不插进这一轮，也不另开一轮。
      expect(stub.steered).toHaveLength(0);
      expect(stub.prompts.some((prompt) => prompt.includes("/stop</user_message>"))).toBe(false);
      // 用户停下的不是失败：没有错误通知。
      expect(events.some((event) => event.type === "notice.created" && event.turnId === running)).toBe(false);

      // 下一轮开头告诉 Lead 一次。
      const next = await send("先说说 Electron 和 Tauri 的差别");
      await vi.waitFor(() => expect(turn(next)).toMatchObject({ state: "completed", assistant_text: "收到。" }));
      expect(stub.prompts.at(-1)).toContain("用户用 /stop 停下了你的上一轮");
      const after = await send("还有别的吗");
      await vi.waitFor(() => expect(turn(after)).toMatchObject({ state: "completed" }));
      expect(stub.prompts.at(-1)).not.toContain("用户用 /stop 停下了你的上一轮");
    });
  }

  it("answers that there is nothing to stop when Lead is idle, without asking Lead", async () => {
    const stub = lead([]);
    const { send } = await start(stub);

    const stop = await send("/stop");

    await vi.waitFor(() => expect(turn(stop)).toMatchObject({ state: "completed" }));
    expect(turn(stop).assistant_text).toContain("There is nothing to stop.");
    expect(stub.aborts()).toBe(0);
    expect(stub.prompts).toHaveLength(0);
  });
});
