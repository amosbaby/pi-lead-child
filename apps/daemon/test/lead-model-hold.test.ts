// 模型暂停（lead 的 model-hold.ts，2026-11-15）。持久化的完整流程：daemon、网关、store、调度器、空闲车道都是真的；
// Lead 的会话是替身（fake-pi-session.ts），时间按比例缩短。
//
// 以前：provider 停用了账号（403「disabled ... Terms of Service」），带着事件的那一轮失败以后，daemon 按退避（15 秒起翻倍，
// 最多 5 分钟，没有次数上限）一次次自动叫醒 Lead，新来的事件也马上开一轮，每一次都调模型、都失败。用户担心这看起来像滥用。
// 现在：一次账号级的失败以后，系统不再自动调模型；事件留在日志里。用户本人的消息照常开一轮，答上了就解除，排着的事接着交给 Lead。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { scriptedSmartModel } from "@pi-lead-child/engine/testing";
import { addInbox, createItem, createLoopbackBinding, openDb, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead, type FakeCall, type FakeReply } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-lead-model-hold-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  // 带着事的那一轮失败以后 50 毫秒就再叫醒（缺省 15 秒），翻倍：1 秒里会再试好几次。
  vi.stubEnv("PLC_LEAD_WAKE_RETRY_MS", "50");
  // 空闲车道：Lead 空闲 50 毫秒就开始要调模型的活（上下文 75%，过了整理笔记的线）。
  vi.stubEnv("PLC_LEAD_IDLE_GRACE_MS", "50");
  vi.stubEnv("PLC_LEAD_IDLE_COMPACT_RATIO", "0.95");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

const DISABLED = "403 This service has been disabled in this account for violation of Terms of Service.";
const has = (call: FakeCall, text: string) => call.inputs.some((input) => input.includes(text));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function boot(script: (call: FakeCall) => FakeReply | Promise<FakeReply>) {
  const logs: string[] = [];
  const lead = fakePiLead(script, {
    smartModel: scriptedSmartModel({ answers: { ask_kind: "other" } }),
    contextUsage: { window: 1_000, tokens: 750 },
  });
  daemon = await startDaemon({
    dataDir: dir, dbPath, log: (line: string) => { logs.push(line); }, notifyDesktop: () => {}, triageShadow: false,
    sessionFactory: lead.factory as never,
  });
  const owner = createLoopbackBinding(db, { name: "Mac 网页" });
  const http = async (path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${owner.accessToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const say = async (id: string, message: string) => {
    const sent = await http("/v1/chat/send", { id, message });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    return sent.body as { turnId: string; mode: string };
  };
  const turn = (id: string) => db.prepare("SELECT state, error FROM channel_turns WHERE id = ?").get(id) as { state: string; error: string | null };
  return { lead, logs, http, say, turn };
}

function blocker(title: string): void {
  addInbox(db, {
    itemId: createItem(db, { title, brief: "b", createdBy: "system" }),
    severity: "blocker", source: "structural", summary: title, lossless: true,
  });
}

describe("the model hold after an account-level failure", () => {
  it("makes no automatic model call for new events, and a successful user turn lets the queued events through", async () => {
    let accountDisabled = true;
    blocker("依赖升级卡住了");
    const { lead, logs, http, say, turn } = await boot((call) => {
      if (accountDisabled) return { error: DISABLED };
      if (has(call, "你好")) return { say: "你好！" };
      return { say: "处理了。" };
    });
    await vi.waitFor(() => expect(lead.calls.some((call) => has(call, "依赖升级卡住了"))).toBe(true), { timeout: 5_000 });
    await vi.waitFor(() => expect(logs.some((line) => line.startsWith("[sched] model.hold action=entered source=turn kind=auth"))).toBe(true), { timeout: 5_000 });
    const afterFirstFailure = lead.calls.length;

    // 新的事件、到点的重试、空闲车道：以前 1 秒里会再调好几次模型（50、100、200、400 毫秒的退避，每个新事件马上一轮）。
    blocker("发布流水线红了");
    await sleep(500);
    blocker("证书快过期了");
    await sleep(700);
    expect(lead.calls.length).toBe(afterFirstFailure);
    expect(logs.filter((line) => line.includes("model.hold action=entered"))).toHaveLength(1);
    // 事件还在：没有记成处理过（交给失败那一轮的是 delivered，后来的是 pending）。
    const open = db.prepare("SELECT count(*) AS n FROM inbox WHERE state IN ('pending', 'delivered')").get() as { n: number };
    expect(open.n).toBe(3);
    // 顶栏的健康状态照实说：模型账号认证失败，系统不承诺下一次自动调用。
    expect((await http("/v1/overview?include=lead")).body.lead).toMatchObject({
      state: "degraded", reason: expect.stringContaining("failed authentication"), nextAttemptAt: null,
    });

    // 用户本人的消息照常开一轮（一条消息一次请求）。还是账号级的失败：继续暂停，系统也不替用户重发。
    const first = await say("t1", "你好");
    await vi.waitFor(() => expect(turn(first.turnId).state).toBe("failed"), { timeout: 5_000 });
    expect(lead.calls.length).toBe(afterFirstFailure + 1);
    await sleep(500);
    expect(lead.calls.length).toBe(afterFirstFailure + 1);

    // 账号修好了：用户的下一条消息答上，暂停解除，排着的事接着交给 Lead。
    accountDisabled = false;
    const userCallIndex = lead.calls.length;
    const second = await say("t2", "你好，在吗");
    await vi.waitFor(() => expect(turn(second.turnId).state).toBe("completed"), { timeout: 5_000 });
    expect((await http("/v1/overview?include=lead")).body.lead).toMatchObject({ state: "online" });
    await vi.waitFor(() => expect(logs.some((line) => /^\[sched\] model\.hold action=lifted by=user_turn source=turn heldMs=\d+$/u.test(line))).toBe(true), { timeout: 5_000 });
    await vi.waitFor(() => {
      const later = lead.calls.slice(userCallIndex);
      for (const title of ["依赖升级卡住了", "发布流水线红了", "证书快过期了"]) {
        expect(later.some((call) => has(call, title)), title).toBe(true);
      }
    }, { timeout: 5_000 });
  }, 30_000);
});
