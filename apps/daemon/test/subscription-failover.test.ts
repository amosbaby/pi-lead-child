// D5（模型配置方案 C）：一种订阅有几个账号时，一个账号限流以后 Lead 先在分工的同一格里换账号；
// 只有这种订阅的账号都试过（或者在冷却）时，模型切换才换到分工的下一格。<base>-<n>/<id> 和 <base>/<id> 是同一格：
// 换账号不改 Lead 报出去的模型，也不算一次「换模型」（不写 lead.model_switched）。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPairing, listEvents, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { setLeadSubscriptionSource } from "@pi-lead-child/lead";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";

let dir: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

const RATE_LIMIT = "429 Too Many Requests: You have hit your usage limit.";

beforeEach(() => {
  dir = tempDir("plc-subscription-failover-");
  db = openDb(join(dir, "plc.db"));
  // pi 的 agentDir（D2）放在临时目录（startDaemon 的 piAgentDir）：两个 Codex 账号的假凭据和 pi-multi-pass 的配置。
  const piAgentDir = join(dir, "pi-agent");
  mkdirSync(piAgentDir, { recursive: true });
  const fake = { type: "oauth", access: "fake-access", refresh: "fake-refresh", expires: Date.now() + 3_600_000 };
  writeFileSync(join(piAgentDir, "auth.json"), JSON.stringify({ "openai-codex": fake, "openai-codex-2": fake }), { mode: 0o600 });
  writeFileSync(join(piAgentDir, "multi-pass.json"), JSON.stringify({
    subscriptions: [{ provider: "openai-codex", index: 2, label: "Home" }],
    pools: [{ name: "openai-codex", baseProvider: "openai-codex", members: ["openai-codex", "openai-codex-2"], enabled: true }],
    chains: [], presets: [],
  }));
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_USER_TURN_RETRY_MS", "50");
  vi.stubEnv("PLC_LEAD_DRAIN_MS", "50");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  setLeadSubscriptionSource(null);
  vi.unstubAllEnvs();
});

// 不调用模型的 Lead。currentModel 是会话真正用的模型（换了账号时是 openai-codex-2/…），modelName 是分工里的那一格。
// 每次失败的请求都记进 SubscriptionAccountTracker（真的会话里是 plc-subscription-accounts 扩展记）。
// multiPassMoves：像 pi-multi-pass 那样在失败的那次请求的 agent_end 里换到下一个账号（setModel），这一轮照样以失败结束
// （pi 不重试，它的重发被会话扩展拦下）。
function stubLead(models: string[], fails: (model: string) => string | null, options: { multiPassMoves?: Record<string, string> } = {}) {
  const turns: string[] = [];
  const switches: string[] = [];
  const listeners: Array<(event: any) => void> = [];
  let current = models[0]!;
  const emit = (event: unknown) => { for (const listener of listeners) listener(event); };
  let tracker: { failed(provider: string, error: string): void } | null = null;
  const factory = async (args: { subscriptionAccounts?: typeof tracker }) => {
    tracker = args.subscriptionAccounts ?? null;
    return {
    modelName: current,
    models,
    currentModel: () => current,
    switchModel: async (spec: string) => { switches.push(spec); current = spec; },
    session: {
      sessionId: "stub-session",
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      async prompt() {
        turns.push(current);
        const error = fails(current);
        if (error) {
          // 和会话扩展 plc-subscription-accounts 一样：每次失败的请求按它自己的 provider 记一次。
          tracker?.failed(current.slice(0, current.indexOf("/")), error);
          const moved = options.multiPassMoves?.[current];
          if (moved) current = moved;
          emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: error, content: [] } });
          return;
        }
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "收到。" } });
        emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "收到。" }] } });
      },
      async steer() {},
      async followUp() {},
      dispose() {},
    },
    };
  };
  return { factory, turns, switches };
}

async function start(lead: ReturnType<typeof stubLead>) {
  const logs: string[] = [];
  daemon = await startDaemon({
    dataDir: dir, dbPath: join(dir, "plc.db"), sessionFactory: lead.factory as never, log: (line) => logs.push(line),
    piAgentDir: join(dir, "pi-agent"),
  });
  const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat", "tickets:view"] }).code);
  const headers = { authorization: `Bearer ${issued.accessToken}`, "content-type": "application/json" };
  let sent = 0;
  const chat = async (message: string) => {
    sent += 1;
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}/v1/chat/send`, {
      method: "POST", headers, body: JSON.stringify({ id: `cmd-${sent}`, message }),
    });
    expect(response.ok).toBe(true);
    return ((await response.json()) as { turnId: string }).turnId;
  };
  const overview = async () => (await (await fetch(`http://127.0.0.1:${daemon!.pairedPort}/v1/overview`, { headers })).json()) as { model: string };
  return { logs, chat, overview };
}

const turnState = (id: string) => (db.prepare("SELECT state FROM channel_turns WHERE id = ?").get(id) as { state: string }).state;

describe("a rate limit on one subscription account", () => {
  it("moves Lead to the next account in the same slot, not to the next model of the chain", async () => {
    const lead = stubLead(["openai-codex/gpt-5.5", "p/b"], (model) => (model === "openai-codex/gpt-5.5" ? RATE_LIMIT : null));
    const { logs, chat, overview } = await start(lead);

    const turnId = await chat("在吗");
    await vi.waitFor(() => expect(turnState(turnId)).toBe("completed"));
    expect(lead.switches).toEqual(["openai-codex-2/gpt-5.5"]);
    expect(lead.turns.slice(0, 2)).toEqual(["openai-codex/gpt-5.5", "openai-codex-2/gpt-5.5"]);
    expect(logs.some((line) => line.includes("lead subscription account failover") && line.includes("openai-codex-2"))).toBe(true);
    // 同一格：Lead 报出去的模型不变，不是一次换模型。
    expect((await overview()).model).toBe("openai-codex/gpt-5.5");
    expect(listEvents(db, { kind: "lead.model_switched" })).toEqual([]);
  });

  it("keeps the account pi-multi-pass already moved to, and does not switch again", async () => {
    const lead = stubLead(["openai-codex/gpt-5.5", "p/b"], (model) => (model === "openai-codex/gpt-5.5" ? RATE_LIMIT : null), {
      multiPassMoves: { "openai-codex/gpt-5.5": "openai-codex-2/gpt-5.5" },
    });
    const { logs, chat } = await start(lead);

    const turnId = await chat("在吗");
    await vi.waitFor(() => expect(turnState(turnId)).toBe("completed"));
    expect(lead.switches).toEqual([]);
    expect(lead.turns.slice(0, 2)).toEqual(["openai-codex/gpt-5.5", "openai-codex-2/gpt-5.5"]);
    expect(logs.some((line) => line.includes("pi-multi-pass already moved to openai-codex-2"))).toBe(true);
  });

  it("moves to the next model of the chain only after every account of the subscription failed", async () => {
    const lead = stubLead(["openai-codex/gpt-5.5", "p/b"], (model) => (model.startsWith("openai-codex") ? RATE_LIMIT : null));
    const { chat } = await start(lead);

    const first = await chat("在吗");
    await vi.waitFor(() => expect(["completed", "failed"]).toContain(turnState(first)));
    await vi.waitFor(() => expect(lead.switches).toContain("openai-codex-2/gpt-5.5"));
    if (!lead.switches.includes("p/b")) {
      const second = await chat("现在呢");
      await vi.waitFor(() => expect(turnState(second)).toBe("completed"));
    }
    expect(lead.switches).toEqual(["openai-codex-2/gpt-5.5", "p/b"]);
    expect(lead.turns.at(-1)).toBe("p/b");
    expect(listEvents(db, { kind: "lead.model_switched" })).toMatchObject([{ payload: { from: "openai-codex/gpt-5.5", to: "p/b" } }]);
  });
});

// 合进模型暂停（model-hold.ts）以后：账号级的失败（账号被停用）马上让系统停止自动调模型，除非还有别的可换。
// 账号级的失败在这一轮里不再试（protocol 的 leadModelRetryClass），下一轮开始前换账号。
// 同一种订阅里还有能用的账号，就是有别的可换：换账号，不暂停。账号都失败、分工里也没有下一格时，照常暂停。
describe("an account-level failure on one subscription account", () => {
  const DISABLED = "403 This service has been disabled in this account for violation of Terms of Service.";

  it("moves the next turn to the next account and does not hold automatic model calls", async () => {
    const lead = stubLead(["openai-codex/gpt-5.5"], (model) => (model === "openai-codex/gpt-5.5" ? DISABLED : null));
    const { logs, chat } = await start(lead);

    const first = await chat("在吗");
    await vi.waitFor(() => expect(turnState(first)).toBe("failed"));
    await vi.waitFor(() => expect(logs.some((line) => line.includes("the next turn uses openai-codex-2"))).toBe(true));
    const second = await chat("现在呢");
    await vi.waitFor(() => expect(turnState(second)).toBe("completed"));
    expect(lead.switches).toEqual(["openai-codex-2/gpt-5.5"]);
    expect(logs.some((line) => line.includes("model.hold action=entered"))).toBe(false);
  });

  it("holds automatic model calls when every account failed and the chain has no other model", async () => {
    const lead = stubLead(["openai-codex/gpt-5.5"], (model) => (model.startsWith("openai-codex") ? DISABLED : null));
    const { logs, chat } = await start(lead);

    const first = await chat("在吗");
    await vi.waitFor(() => expect(turnState(first)).toBe("failed"));
    expect(logs.some((line) => line.includes("model.hold action=entered"))).toBe(false);
    await vi.waitFor(() => expect(logs.some((line) => line.includes("the next turn uses openai-codex-2"))).toBe(true));
    const second = await chat("现在呢");
    await vi.waitFor(() => expect(turnState(second)).toBe("failed"));
    expect(lead.switches).toEqual(["openai-codex-2/gpt-5.5"]);
    await vi.waitFor(() => expect(logs.some((line) => line.includes("model.hold action=entered"))).toBe(true));
  });
});
