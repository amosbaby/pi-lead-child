// 一步停不下时释放 Lead（.scratch/tool-occupancy/spec.md L3，用户 2026-11-11）。工具已经停得下来（P1 的 tool-abort-guard），
// pi 里还有别的 await 可以挂住：扩展钩子、transformContext、不理 signal 的模型流。以前中止过了宽限只写一行 abort.stuck，
// pi 的 prompt() 一直不返回，Lead 的下一轮开不了，用户的插话一直排着。
// 现在 daemon 按固定规则释放 Lead：abort.stuck 以后再等一会儿（PLC_LEAD_RELEASE_WAIT_MS），还没停下就在进程里换掉会话
// （lead 的 session-slot.ts）；用户再按一次 /stop 时马上换。换掉以后这一轮照常收尾，单元挂起，排着的插话由新会话回答，
// 新会话收到一条事件，写着卡在哪里、什么时候释放的、留下了什么。
// daemon、网关、store 都是真的；Lead 的会话是按 pi 规则写的替身（fake-pi-session.ts），卡住的是一个不听中止的 await。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLoopbackBinding, openDb, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead, type FakeCall, type FakeReply } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-lead-release-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_LEAD_OVERFLOW_TOOL_CALLS", "100");
  vi.stubEnv("PLC_LEAD_USER_QUEUE_NOTICE_MS", "600000");
  vi.stubEnv("PLC_LEAD_HANDOFF_MS", "5000");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

const never = new Promise<void>(() => {});
const has = (call: FakeCall, text: string) => call.inputs.some((input) => input.includes(text));
const RELEASED = "系统按固定规则释放了你";

// 第一个会话卡住；daemon 换会话时再叫工厂，拿到第二个（第三个，重启以后）。
function sessions(...scripts: Array<(call: FakeCall) => FakeReply>) {
  const leads = scripts.map((script) => fakePiLead(script));
  let built = 0;
  const factory = async (args: unknown) => {
    const lead = leads[Math.min(built, leads.length - 1)]!;
    built += 1;
    return lead.factory(args);
  };
  return { leads, factory, built: () => built };
}

async function boot(factory: (args: unknown) => Promise<unknown>) {
  const logs: string[] = [];
  daemon = await startDaemon({
    dataDir: dir, dbPath, log: (line: string) => { logs.push(line); }, notifyDesktop: () => {}, triageShadow: false,
    sessionFactory: factory as never,
  });
  const owner = createLoopbackBinding(db, { name: "Mac 网页" });
  const say = async (id: string, message: string, mode?: "steer" | "followUp"): Promise<{ turnId: string; mode: string }> => {
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}/v1/chat/send`, {
      method: "POST", headers: { authorization: `Bearer ${owner.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ id, message, ...(mode ? { mode } : {}) }),
    });
    const body = await response.json() as { turnId: string; mode: string };
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body;
  };
  return { say, logs };
}

const turn = (id: string) => db.prepare("SELECT state, error, assistant_text FROM channel_turns WHERE id = ?").get(id) as
  { state: string; error: string | null; assistant_text: string };
const releaseRows = () => (db.prepare("SELECT state, payload, summary FROM inbox WHERE dedup_scope LIKE 'lead-release:%'").all() as
  Array<{ state: string; payload: string; summary: string }>).map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
const schedulerEvents = (kind: string) => (db.prepare("SELECT payload FROM events WHERE kind = ? ORDER BY seq").all(`scheduler.${kind}`) as
  Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as Record<string, unknown>);

describe("a step that does not stop after an abort", () => {
  // 回归：红线中止了这一步，可它卡在一个不听中止的 await 上。以前只有 abort.stuck，插话一直没有回答。
  it("is released by a fixed rule: a new session answers the waiting steer and gets an event about the release", async () => {
    vi.stubEnv("PLC_LEAD_OVERFLOW_MS", "150");
    vi.stubEnv("PLC_LEAD_RED_LINE_MS", "300");
    vi.stubEnv("PLC_LEAD_RELEASE_WAIT_MS", "200");
    const stack = sessions(
      () => ({ stuck: never }),
      (call) => {
        if (has(call, RELEASED)) return { say: "知道了，我看一下有没有留下半截的下载。" };
        if (has(call, "看看磁盘")) return { say: "磁盘还剩 80 GB。" };
        return { say: "好的。" };
      },
    );
    const { say, logs } = await boot(stack.factory);

    const first = await say("r1", "把系统更新下载下来");
    await vi.waitFor(() => expect(stack.leads[0]!.calls.length).toBe(1), { timeout: 5_000 });
    const steer = await say("r2", "先别下了，看看磁盘", "steer");
    expect(steer.mode).toBe("steered");

    // 红线 300 毫秒中止，宽限 5 秒后 abort.stuck，再等 200 毫秒释放。
    await vi.waitFor(() => expect(stack.built()).toBe(2), { timeout: 9_000 });
    await vi.waitFor(() => expect(turn(steer.turnId)).toMatchObject({ state: "completed", assistant_text: "磁盘还剩 80 GB。" }), { timeout: 5_000 });

    // 卡住的那一轮照常收尾，不是失败，末尾告诉用户换了会话。
    expect(turn(first.turnId)).toMatchObject({ state: "completed", error: null });
    expect(turn(first.turnId).assistant_text).toContain("The system started a new session for");
    expect(logs.some((line) => line.includes("abort.stuck"))).toBe(true);
    expect(logs.some((line) => line.includes("release.start") && line.includes("trigger=auto"))).toBe(true);

    // 给新会话的事件：卡在哪里、怎么释放的；它叫醒了 Lead。
    const [row] = releaseRows();
    expect(row?.payload).toMatchObject({ kind: "lead_released", trigger: "auto", reason: "budget", replaced: true, wakeLead: true });
    expect(row?.summary).toContain(RELEASED);
    await vi.waitFor(() => expect(stack.leads[1]!.calls.some((call) => has(call, RELEASED))).toBe(true), { timeout: 5_000 });

    // 记录：释放的决定，单元挂起（H10）。
    expect(schedulerEvents("decided").some((payload) => payload.decision === "release" && payload.trigger === "auto")).toBe(true);
    expect(schedulerEvents("suspended").map((payload) => payload.reason)).toContain("released");
    expect(schedulerEvents("unit_ended").some((payload) => payload.outcome === "suspended")).toBe(true);
  }, 30_000);

  // 用户 2026-11-11：中止过了还没停下时，用户再按一次 /stop，直接释放，不再等。
  it("is released at once by a second /stop", async () => {
    vi.stubEnv("PLC_LEAD_OVERFLOW_MS", "600000");
    vi.stubEnv("PLC_LEAD_RED_LINE_MS", "600000");
    vi.stubEnv("PLC_LEAD_RELEASE_WAIT_MS", "600000");
    const stack = sessions(
      () => ({ stuck: never }),
      (call) => (has(call, RELEASED) ? { say: "好的，不接着做了。" } : { say: "在。" }),
    );
    const { say, logs } = await boot(stack.factory);

    const first = await say("s1", "把系统更新下载下来");
    await vi.waitFor(() => expect(stack.leads[0]!.calls.length).toBe(1), { timeout: 5_000 });
    const stop1 = await say("s2", "/stop");
    await vi.waitFor(() => expect(stack.leads[0]!.aborts()).toBe(1), { timeout: 5_000 });
    expect(stack.built()).toBe(1);

    const started = Date.now();
    const stop2 = await say("s3", "/stop");
    // 不等 5 秒的宽限，也不等释放前的等待。
    await vi.waitFor(() => expect(stack.built()).toBe(2), { timeout: 3_000 });
    await vi.waitFor(() => expect(turn(first.turnId).state).toBe("completed"), { timeout: 3_000 });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(turn(first.turnId).assistant_text).toContain("The turn did not stop after /stop.");
    expect(turn(stop1.turnId).state).toBe("completed");
    expect(turn(stop2.turnId).state).toBe("completed");
    expect(logs.some((line) => line.includes("release.start") && line.includes("trigger=user_stop"))).toBe(true);
    expect(logs.some((line) => line.includes("abort.stuck"))).toBe(false);

    // 用户叫停的单元不挂起：Lead 不该自己接着做。
    expect(releaseRows()[0]?.payload).toMatchObject({ kind: "lead_released", trigger: "user_stop", replaced: true });
    expect(schedulerEvents("suspended")).toEqual([]);
    expect(schedulerEvents("unit_ended").some((payload) => payload.outcome === "stopped")).toBe(true);

    // 新会话照常工作。
    const next = await say("s4", "还在吗");
    await vi.waitFor(() => expect(turn(next.turnId)).toMatchObject({ state: "completed", assistant_text: "在。" }), { timeout: 5_000 });
  }, 20_000);

  // 整条持久化流程：自动释放以后重启 daemon。轮次停在终态，释放的事件交过了不再交，挂起的单元还在当前局面里，启动时不再释放。
  it("leaves a persisted state that the next daemon starts from cleanly", async () => {
    vi.stubEnv("PLC_LEAD_OVERFLOW_MS", "150");
    vi.stubEnv("PLC_LEAD_RED_LINE_MS", "300");
    vi.stubEnv("PLC_LEAD_RELEASE_WAIT_MS", "100");
    const stack = sessions(
      () => ({ stuck: never }),
      (call) => (has(call, RELEASED) ? { say: "看过了，没有留下东西，那件事先挂着。" } : { say: "在。" }),
    );
    const { say } = await boot(stack.factory);
    const first = await say("p1", "把系统更新下载下来");
    await vi.waitFor(() => expect(stack.built()).toBe(2), { timeout: 9_000 });
    await vi.waitFor(() => expect(turn(first.turnId).state).toBe("completed"), { timeout: 5_000 });
    await vi.waitFor(() => expect(stack.leads[1]!.calls.some((call) => has(call, RELEASED))).toBe(true), { timeout: 5_000 });
    await vi.waitFor(() => expect(releaseRows()[0]?.state).not.toBe("pending"), { timeout: 5_000 });

    await daemon!.close();
    daemon = null;
    vi.stubEnv("PLC_LEAD_RED_LINE_MS", "600000");
    vi.stubEnv("PLC_LEAD_OVERFLOW_MS", "600000");
    const after = sessions((call) => (has(call, RELEASED) ? { say: "又收到一次释放的事件。" } : { say: "在。" }));
    const { say: sayAgain, logs } = await boot(after.factory);
    const next = await sayAgain("p2", "还在吗");
    await vi.waitFor(() => expect(turn(next.turnId)).toMatchObject({ state: "completed", assistant_text: "在。" }), { timeout: 5_000 });

    // 没有挂着的轮次；释放的事件不再交一次；挂起的单元还在当前局面里，由 Lead 决定；启动时没有释放。
    const open = db.prepare("SELECT COUNT(*) AS n FROM channel_turns WHERE state NOT IN ('completed', 'failed', 'steered')").get() as { n: number };
    expect(open.n).toBe(0);
    expect(after.leads[0]!.calls.some((call) => has(call, RELEASED))).toBe(false);
    expect(after.leads[0]!.calls[0]!.situation ?? "").toContain("挂起的单元");
    expect(releaseRows()).toHaveLength(1);
    expect(logs.some((line) => line.includes("release.start"))).toBe(false);
  }, 30_000);
});
