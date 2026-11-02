// Lead 的模型没有 key（一次真实的首次运行改写）：缺省模型的服务商没有 key，pi 在发 prompt 前就报
// "No API key found for openai."，不调模型，也没有 message_end。以前：
//   - 这句错误分成 unknown，也没记进 Lead 的健康状态：顶栏一直是绿点，用户看不出来；
//   - 交给 Lead 的事每一轮都失败，按退避（最长 5 分钟）一直叫醒 Lead，失败了几百次。现在等用户改了模型设置再叫。
// daemon、store 是真的；Lead 的会话是替身，prompt 直接抛出 pi 的那句错误。
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { addInbox, createItem, createPairing, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

const NO_KEY = "No API key found for openai.\n\nUse /login to log into a provider via OAuth or API key.";

beforeEach(() => {
  dir = tempDir("plc-lead-model-credentials-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_DATA_DIR", dir);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_LEAD_WAKE_RETRY_MS", "50");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

async function boot() {
  const prompts: string[] = [];
  daemon = await startDaemon({
    dataDir: dir, dbPath, log: () => {}, notifyDesktop: () => {}, triageShadow: false,
    sessionFactory: (async () => ({
      modelName: "openai/gpt-test",
      refreshProviders: async () => {},
      session: {
        sessionId: "no-key-session",
        subscribe() { return () => {}; },
        async prompt(text: string) {
          prompts.push(text);
          throw new Error(NO_KEY);
        },
        async steer() {},
        async followUp() {},
        dispose() {},
      },
    })) as never,
  });
  const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat", "tickets:view", "tickets:create"] }).code);
  const headers = { authorization: `Bearer ${issued.accessToken}` };
  const overview = async () => (await (await fetch(`http://127.0.0.1:${daemon!.pairedPort}/v1/overview?include=lead`, { headers })).json()) as
    { lead?: Record<string, any> };
  // 设置 → 模型：用户填上服务商的 key（和网页走同一个操作入口）。
  const saveProvider = async () => (await fetch(`http://127.0.0.1:${daemon!.pairedPort}/v1/actions/model_settings/models/save_provider`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ input: { name: "openai", baseUrl: "https://api.example.com/v1", api: "openai-completions", apiKey: "sk-test-new-0123" } }),
  })).status;
  return { prompts, overview, saveProvider };
}

function blocker(summary: string) {
  addInbox(db, {
    itemId: createItem(db, { title: summary, brief: "b", createdBy: "system" }), severity: "blocker", source: "structural", summary, lossless: true,
  });
}

describe("Lead's model has no API key", () => {
  it("shows Lead degraded with an account problem, not a green dot", async () => {
    const { prompts, overview } = await boot();
    blocker("Run #7 crashed");
    await vi.waitFor(() => expect(prompts.length).toBeGreaterThanOrEqual(1), { timeout: 10_000 });
    await vi.waitFor(async () => expect((await overview()).lead).toMatchObject({ state: "degraded" }), { timeout: 10_000 });
    const lead = (await overview()).lead!;
    expect(lead.detail).toContain("No API key found for openai");
    expect(lead.reason).toMatch(/account|账号/);
  }, 30_000);

  // 回归：以前按退避（50ms 起，翻倍）一直叫醒 Lead，1.5 秒里就有五六轮，真实环境里是每 5 分钟一轮、三天几百轮。
  it("does not wake Lead again for the same events until the user changes the model settings", async () => {
    const { prompts, saveProvider } = await boot();
    blocker("Run #7 crashed");
    await vi.waitFor(() => expect(prompts).toHaveLength(1), { timeout: 10_000 });
    await delay(1_500);
    expect(prompts).toHaveLength(1);
    // 用户在设置 → 模型填了 key：交给 Lead 的事马上再交一次。
    expect(await saveProvider()).toBe(200);
    await vi.waitFor(() => expect(prompts).toHaveLength(2), { timeout: 10_000 });
    expect(prompts[1]).toContain("Run #7 crashed");
  }, 30_000);
});
