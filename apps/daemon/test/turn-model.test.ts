// 「只这一条」（模型配置方案 C 的 D8，2026-11-16）：走完整的路径。用户的消息经网关进来，带一个单轮模型（chat.send 的 turnModel）。
// daemon 用它答这一条：这一轮开始前在会话里换上，答完换回这一轮之前会话挂着的模型。config.json 不改，模型切换（model-failover）不知道这一轮。
// Lead 忙时，带单轮模型的话等这一轮结束后单独开一轮；用单轮模型的那一轮也不收别的话（收进去就也用了那个模型）。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createPairing, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { deferred } from "./fake-pi-session.js";

// 和 protocol 的 CHAT_TURN_MODEL_CAPABILITY 一样：这里写原文，线上的名字一变测试就失败。
const CAPABILITY = "chat.turn-model.v1";
const PRIMARY = "vibeproxy/claude-sonnet-5";
const BACKUP = "vibeproxy/gemini-3.8-flash-high";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
let vibeproxy: Server | null = null;
const sockets: WebSocket[] = [];

async function startVibeproxy(): Promise<string> {
  vibeproxy = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("content-type", "application/json");
    if (url.pathname !== "/v1/models") { res.statusCode = 404; res.end("{}"); return; }
    if (url.searchParams.get("client_version") === "pi") {
      res.end(JSON.stringify({
        models: ["claude-sonnet-5", "as4/claude-sonnet-5"].map((slug) => ({
          slug, input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
        })).concat([{ slug: "gemini-3.8-flash-high", input_modalities: ["text", "image"], supported_reasoning_levels: [] } as never]),
      }));
      return;
    }
    res.end(JSON.stringify({
      data: [
        { id: "claude-sonnet-5", owned_by: "anthropic" },
        { id: "gemini-3.8-flash-high", owned_by: "antigravity" },
        { id: "as4/claude-sonnet-5", owned_by: "anthropic" },
      ],
    }));
  });
  await new Promise<void>((resolve) => vibeproxy!.listen(0, "127.0.0.1", resolve));
  const address = vibeproxy.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1`;
}

beforeEach(async () => {
  dir = tempDir("plc-turn-model-");
  mkdirSync(dir, { recursive: true });
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    lead: {
      providers: { vibeproxy: { baseUrl: await startVibeproxy(), apiKey: { value: "vibeproxy" }, discover: true } },
      models: [PRIMARY, BACKUP],
    },
  }));
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
  await new Promise<void>((resolve) => (vibeproxy ? vibeproxy.close(() => resolve()) : resolve()));
  vibeproxy = null;
  vi.unstubAllEnvs();
});

// 桩 Lead：会话记着自己挂着哪个模型（switchModel 换，currentModel 读），每次 prompt 记下当时的模型。
// 消息里有「限流」时这一轮失败（429），有「等一下」时停在 hold 上。
function stubLead() {
  const listeners: Array<(event: any) => void> = [];
  const switched: string[] = [];
  const prompts: Array<{ text: string; model: string }> = [];
  let current = PRIMARY;
  let hold: Promise<void> | null = null;
  const factory = async () => ({
    modelName: PRIMARY,
    models: [PRIMARY, BACKUP],
    switchModel: async (spec: string) => { switched.push(spec); current = spec; },
    currentModel: () => current,
    session: {
      sessionId: "stub-session",
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      async prompt(text: string) {
        prompts.push({ text, model: current });
        if (text.includes("等一下") && hold) await hold;
        if (text.includes("限流")) throw new Error("429 Too Many Requests: rate limit exceeded");
        for (const listener of listeners) {
          listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "好。" } });
          listener({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "好。" }] } });
        }
      },
      async steer() {},
      async followUp() {},
      dispose() {},
    },
  });
  return {
    factory, switched, prompts,
    holdOn: (promise: Promise<void> | null) => { hold = promise; },
    current: () => current,
  };
}

async function start(lead: ReturnType<typeof stubLead>) {
  daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {}, notifyDesktop: () => {} });
  const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat", "tickets:view"] }).code);
  const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2`);
  sockets.push(socket);
  const events: any[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
  await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
  let sent = 0;
  const send = async (message: string, turnModel?: { model: string; effort: string | null }) => {
    const id = `cmd-${++sent}`;
    socket.send(JSON.stringify({ type: "chat.send", id, protocolVersion: 2, message, ...(turnModel ? { turnModel } : {}) }));
    await vi.waitFor(() => expect(events.some((event) => event.type === "command.result" && event.id === id)).toBe(true));
    const result = events.find((event) => event.type === "command.result" && event.id === id);
    expect(result.success).toBe(true);
    return result.data as { turnId: string; mode: string };
  };
  const http = async (path: string) => {
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}${path}`, { headers: { authorization: `Bearer ${issued.accessToken}` } });
    return await response.json() as any;
  };
  return { events, send, http, hello: events.find((event) => event.type === "hello.v2") };
}

const configuredModels = () => JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).lead.models as string[];
const turnState = (id: string) => (db.prepare("SELECT state FROM channel_turns WHERE id=?").get(id) as { state: string }).state;
const promptOf = (lead: ReturnType<typeof stubLead>, text: string) => lead.prompts.find((prompt) => prompt.text.includes(text));

describe("a message for one model only", () => {
  it("is answered with that model and effort, then Lead goes back to its model; config.json does not change", async () => {
    const lead = stubLead();
    const { send, hello, http } = await start(lead);
    expect(hello.capabilities).toContain(CAPABILITY);

    const once = await send("想深一点", { model: "vibeproxy/as4/claude-sonnet-5", effort: "high" });
    await vi.waitFor(() => expect(turnState(once.turnId)).toBe("completed"));
    expect(promptOf(lead, "想深一点")?.model).toBe("vibeproxy/as4/claude-sonnet-5(high)");
    await vi.waitFor(() => expect(lead.current()).toBe(PRIMARY));
    expect(lead.switched).toEqual(["vibeproxy/as4/claude-sonnet-5(high)", PRIMARY]);
    expect(configuredModels()).toEqual([PRIMARY, BACKUP]);
    // 目录照旧写分工的模型；带 live=1 时写会话此刻挂着的。
    expect((await http("/v1/lead/models?live=1"))).toMatchObject({ current: { model: PRIMARY, effort: null }, inSession: PRIMARY });

    const next = await send("下一句");
    await vi.waitFor(() => expect(turnState(next.turnId)).toBe("completed"));
    expect(promptOf(lead, "下一句")?.model).toBe(PRIMARY);
    expect(lead.switched).toHaveLength(2);
  });

  it("waits for the running turn and gets a turn of its own; a message sent meanwhile does not join the one-model turn", async () => {
    const lead = stubLead();
    const { send } = await start(lead);
    const answering = deferred();
    lead.holdOn(answering.promise);
    const first = await send("等一下，先答这一句");
    await vi.waitFor(() => expect(lead.prompts).toHaveLength(1));

    const once = await send("用 gemini 答", { model: BACKUP, effort: null });
    expect(once.mode).toBe("queued");
    answering.resolve();
    await vi.waitFor(() => expect(turnState(first.turnId)).toBe("completed"));
    await vi.waitFor(() => expect(turnState(once.turnId)).toBe("completed"));
    expect(promptOf(lead, "等一下")?.model).toBe(PRIMARY);
    expect(promptOf(lead, "用 gemini 答")?.model).toBe(BACKUP);
    await vi.waitFor(() => expect(lead.current()).toBe(PRIMARY));

    // 单轮模型的那一轮在跑时来的话：不插进、不排进那一轮，等它结束后单独开一轮，用回分工的模型。
    const again = deferred();
    lead.holdOn(again.promise);
    const slow = await send("等一下，用 gemini", { model: BACKUP, effort: null });
    await vi.waitFor(() => expect(promptOf(lead, "等一下，用 gemini")?.model).toBe(BACKUP));
    const meanwhile = await send("顺便问一句");
    expect(meanwhile.mode).toBe("queued");
    again.resolve();
    await vi.waitFor(() => expect(turnState(slow.turnId)).toBe("completed"));
    await vi.waitFor(() => expect(turnState(meanwhile.turnId)).toBe("completed"));
    expect(promptOf(lead, "顺便问一句")?.model).toBe(PRIMARY);
    expect(promptOf(lead, "等一下，用 gemini")?.text).not.toContain("顺便问一句");
  });

  it("keeps the model for the automatic retry, and does not let the failure switch Lead's model", async () => {
    vi.stubEnv("PLC_USER_TURN_RETRY_MS", "50");
    const lead = stubLead();
    const { send } = await start(lead);
    const failed = await send("限流了吗", { model: "vibeproxy/as4/claude-sonnet-5", effort: "low" });
    // 限流是临时故障：等一会儿自动再试一次，再试也用这个模型；再失败就是失败。
    await vi.waitFor(() => expect(turnState(failed.turnId)).toBe("failed"), { timeout: 5_000 });
    expect(lead.prompts.filter((prompt) => prompt.text.includes("限流了吗")).map((prompt) => prompt.model))
      .toEqual(["vibeproxy/as4/claude-sonnet-5(low)", "vibeproxy/as4/claude-sonnet-5(low)"]);
    await vi.waitFor(() => expect(lead.current()).toBe(PRIMARY));
    const next = await send("下一句");
    await vi.waitFor(() => expect(turnState(next.turnId)).toBe("completed"));
    // 换到备用（gemini）是模型切换的事：单轮模型失败不算分工的模型失败。
    expect(promptOf(lead, "下一句")?.model).toBe(PRIMARY);
    expect(lead.switched).not.toContain(BACKUP);
  });

  it("answers with Lead's own model when the one-message model is not in the catalog", async () => {
    const lead = stubLead();
    const { send } = await start(lead);
    const turn = await send("用一个不存在的模型", { model: "vibeproxy/as9/claude-sonnet-5", effort: null });
    await vi.waitFor(() => expect(turnState(turn.turnId)).toBe("completed"));
    expect(promptOf(lead, "用一个不存在的模型")?.model).toBe(PRIMARY);
    expect(lead.switched).toEqual([]);
    const effort = await send("强度不对", { model: "vibeproxy/as4/claude-sonnet-5", effort: "max" });
    await vi.waitFor(() => expect(turnState(effort.turnId)).toBe("completed"));
    expect(lead.switched).toEqual([]);
  });
});
