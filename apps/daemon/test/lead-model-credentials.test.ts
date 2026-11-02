// Lead 的模型没有 key（一次真实的首次运行改写）：缺省模型的服务商没有 key，pi 在发 prompt 前就报
// "No API key found for openai."，不调模型，也没有 message_end。以前：
//   - 这句错误分成 unknown，也没记进 Lead 的健康状态：顶栏一直是绿点，用户看不出来；
//   - 交给 Lead 的事每一轮都失败，按退避（最长 5 分钟）一直叫醒 Lead，失败了几百次。
// daemon、store 是真的；Lead 的会话是替身，prompt 直接抛出 pi 的那句错误。
import { join } from "node:path";
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
  const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat", "tickets:view"] }).code);
  const overview = async () => (await (await fetch(`http://127.0.0.1:${daemon!.pairedPort}/v1/overview?include=lead`, {
    headers: { authorization: `Bearer ${issued.accessToken}` },
  })).json()) as { lead?: Record<string, any> };
  return { prompts, overview };
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
});
