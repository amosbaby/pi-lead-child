// 模型暂停（lead 的 model-hold.ts，2026-11-15）。持久化的完整流程：daemon、网关、store、调度器、空闲车道都是真的；
// Lead 的会话是替身（fake-pi-session.ts），时间按比例缩短。
//
// 以前：provider 停用了账号（403「disabled ... Terms of Service」），带着事件的那一轮失败以后，daemon 按退避（15 秒起翻倍，
// 最多 5 分钟，没有次数上限）一次次自动叫醒 Lead，新来的事件也马上开一轮，每一次都调模型、都失败。用户担心这看起来像滥用。
// 现在：一次账号级的失败以后，系统不再自动调模型；事件留在日志里。用户本人的消息照常开一轮，答上了就解除，排着的事接着交给 Lead。
import { writeFileSync } from "node:fs";
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

// 熔断（2026-11-16）。模型代理关了两天（connect ECONNREFUSED），daemon 自动调了 7,028 次：带着事件的一轮按退避一次次再试，
// 新来的事件马上开一轮，空闲车道的活每次空闲都重新开始。现在：连续 3 次失败以后系统不再自动调模型；等待到了只放一次调用去试，
// 失败了等待加倍；答上了才解除，排着的事接着交给 Lead。
describe("the breaker after consecutive failures", () => {
  const REFUSED = "Connection error.: connect ECONNREFUSED 127.0.0.1:8317";

  it("stops automatic model calls after three failures and lets one call through per wait", async () => {
    vi.stubEnv("PLC_MODEL_BREAKER_WAIT_MS", "1500");
    let down = true;
    blocker("依赖升级卡住了");
    const { lead, logs } = await boot((call) => {
      if (down) return { error: REFUSED };
      return { say: has(call, "你好") ? "你好！" : "处理了。" };
    });
    await vi.waitFor(() => expect(logs.some((line) => line.startsWith("[sched] model.hold action=opened failures=3 kind=unavailable"))).toBe(true), { timeout: 10_000 });
    const atOpen = lead.calls.length;
    // 三个单元各调一次；不因为 pi 的再试多调。
    expect(atOpen).toBeLessThanOrEqual(4);

    // 等待里：新的事件、到点的重试、空闲车道都不调模型。
    blocker("发布流水线红了");
    await sleep(400);
    blocker("证书快过期了");
    await sleep(500);
    expect(lead.calls.length).toBe(atOpen);
    const open = db.prepare("SELECT count(*) AS n FROM inbox WHERE state IN ('pending', 'delivered')").get() as { n: number };
    expect(open.n).toBe(3);

    // 等待到了：只放一次调用。它失败了，重新停下（等待加倍到 3 秒）。
    await vi.waitFor(() => expect(logs.some((line) => line.startsWith("[sched] model.hold action=reopened"))).toBe(true), { timeout: 5_000 });
    expect(lead.calls.length).toBe(atOpen + 1);
    await sleep(800);
    expect(lead.calls.length).toBe(atOpen + 1);

    // 模型服务好了：下一次放出去的调用答上，解除，排着的三件事都交给 Lead。
    down = false;
    const before = lead.calls.length;
    await vi.waitFor(() => expect(logs.some((line) => line.startsWith("[sched] model.hold action=lifted by=lead_turn"))).toBe(true), { timeout: 10_000 });
    await vi.waitFor(() => {
      const later = lead.calls.slice(before);
      for (const title of ["依赖升级卡住了", "发布流水线红了", "证书快过期了"]) {
        expect(later.some((call) => has(call, title)), title).toBe(true);
      }
    }, { timeout: 5_000 });
  }, 40_000);
});

// 自动调用的预算（lead 的 auto-call-budget.ts，2026-11-16）。2026-11-05 一张工单的预算提示每 7–10 秒来一条，每一条都叫醒 Lead
// 答一轮，一夜 6,923 轮：每一轮都成功，所以没有任何失败的退避拦着它。现在：系统自己发起的调用到了每小时的上限就暂停，
// 告诉用户一次；用户本人的消息照常答。
describe("the budget for automatic model calls", () => {
  it("pauses automatic calls at the hourly limit, tells the user once, and still answers the user", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ lead: { autoBudget: { callsPerHour: 4 } } }));
    blocker("提示 1");
    const { lead, logs, say, turn } = await boot((call) => ({ say: has(call, "你好") ? "你好！" : "记下了。" }));
    // 一条提示一轮：一直来，一直答。
    for (let i = 2; i <= 12; i += 1) {
      await sleep(150);
      blocker(`提示 ${i}`);
    }
    await vi.waitFor(() => expect(logs.some((line) => line.startsWith("[sched] model.hold action=paused kind=budget"))).toBe(true), { timeout: 10_000 });
    await sleep(800);
    const automatic = lead.calls.length;
    expect(automatic).toBeLessThanOrEqual(5);
    const notices = db.prepare("SELECT title, body FROM notifications WHERE kind = 'lead_model_hold'").all() as Array<{ title: string; body: string }>;
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toContain("automatic call budget");
    expect(notices[0]!.body).toContain("4 automatic model calls in the last hour (limit 4)");
    // 没处理的提示还在，没有记成处理过。
    const open = db.prepare("SELECT count(*) AS n FROM inbox WHERE state IN ('pending', 'delivered')").get() as { n: number };
    expect(open.n).toBeGreaterThanOrEqual(7);

    // 用户本人的消息不受预算限制。
    const sent = await say("t1", "你好");
    await vi.waitFor(() => expect(turn(sent.turnId).state).toBe("completed"), { timeout: 5_000 });
    // 用户的一轮答上了不解除预算的暂停：系统还是不自己调模型。
    await sleep(600);
    expect(logs.some((line) => line.includes("model.hold action=resumed"))).toBe(false);
  }, 40_000);
});
