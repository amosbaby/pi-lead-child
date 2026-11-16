// The pace of Lead's wakes for ordinary system events (lead's wake-pace.ts, user 2026-11-16), through the whole
// persisted flow: the daemon, the gateway, the store and the scheduler are real; Lead's session is the stand-in
// (fake-pi-session.ts). A "minute" of the setting is 1.5 seconds here and the provider's cache stays warm for 400 ms.
//
// Before: every ordinary event woke Lead at once. After a quiet time each of those wakes read the whole context at the
// full input price. Now, with a batch window set, events that arrive on a cold cache wait for each other; on a warm
// cache Lead still wakes at once. Reminders and the user's follow-ups never wait, also not for the budget pause.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { FakeSlack, scriptedSmartModel } from "@pi-lead-child/engine/testing";
import { addInbox, appendEvent, createItem, createLoopbackBinding, getWakePace, openDb, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead, type FakeCall, type FakeReply } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-wake-pace-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_WAKE_PACE_MINUTE_MS", "1500");
  vi.stubEnv("PLC_LEAD_CACHE_WARM_MS", "400");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

const has = (call: FakeCall, text: string) => call.inputs.some((input) => input.includes(text));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function boot(script: (call: FakeCall) => FakeReply | Promise<FakeReply> = () => ({ say: "处理了。" }), slack?: FakeSlack) {
  const logs: string[] = [];
  // A small context: the idle lane has nothing to do, so every model call here is a wake for events.
  const lead = fakePiLead(script, {
    smartModel: scriptedSmartModel({ answers: { ask_kind: "other" } }),
    contextUsage: { window: 1_000, tokens: 100 },
  });
  daemon = await startDaemon({
    dataDir: dir, dbPath, log: (line: string) => { logs.push(line); }, notifyDesktop: () => {}, triageShadow: false,
    sessionFactory: lead.factory as never,
    ...(slack ? {
      channels: {
        sources: { slack: { api: slack.api } },
        credentials: { credential: async (provider: string) => (provider === "slack" ? slack.credential : null) },
        audit: { rate: 0 },
      },
    } : {}),
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
  const setPace = async (coldBatchMinutes: number) => {
    const set = await http("/v1/actions/wake_pace/lead/set", { input: { coldBatchMinutes } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
  };
  const dm = async (user: string, body: string) => {
    await daemon!.channels!.receive("slack", slack!.dm(user, body));
    await daemon!.channels!.idle();
  };
  return { lead, logs, http, setPace, dm };
}

function blocker(title: string): void {
  addInbox(db, {
    itemId: createItem(db, { title, brief: "b", createdBy: "system" }),
    severity: "blocker", source: "structural", summary: title, lossless: true,
  });
}

function reminderFires(title: string) {
  const itemId = createItem(db, { title, brief: "b", createdBy: "user" });
  return db.transaction(() => appendEvent(db, {
    source: "timer", kind: "timer.fired", entityKey: `reminder:${itemId}`, level: "interrupt",
    payload: { timer: "reminder", scheduledAt: new Date().toISOString(), itemId, title, wakeLead: true },
  }).event)();
}

describe("the pace of Lead's wakes for ordinary system events", () => {
  it("wakes Lead at once for each event when no window is set", async () => {
    const { lead, logs } = await boot();
    blocker("依赖升级卡住了");
    await vi.waitFor(() => expect(lead.calls.some((call) => has(call, "依赖升级卡住了"))).toBe(true), { timeout: 1_000 });
    expect(logs.some((line) => line.includes("pace.wait"))).toBe(false);
  });

  it("holds events that arrive on a cold cache until the window ends, then hands them over together", async () => {
    const { lead, logs, setPace } = await boot();
    await setPace(1);
    expect(getWakePace(db)).toEqual({ coldBatchMinutes: 1 });

    blocker("依赖升级卡住了");
    await sleep(500);
    blocker("发布流水线红了");
    await sleep(500);
    // One second into the 1.5-second window: no model call yet, and the events are still open.
    expect(lead.calls.length).toBe(0);
    expect(logs.filter((line) => line.startsWith("[sched] pace.wait"))).toHaveLength(1);
    const open = db.prepare("SELECT count(*) AS n FROM inbox WHERE state IN ('pending', 'delivered')").get() as { n: number };
    expect(open.n).toBe(2);

    // The window ends: one wake, with both events.
    await vi.waitFor(() => expect(lead.calls.length).toBeGreaterThanOrEqual(1), { timeout: 2_000 });
    expect(has(lead.calls[0]!, "依赖升级卡住了") && has(lead.calls[0]!, "发布流水线红了")).toBe(true);
    expect(logs.some((line) => line.startsWith("[sched] pace.release why=window_end"))).toBe(true);

    // The cache is warm now: the next event does not wait.
    const before = lead.calls.length;
    blocker("证书快过期了");
    await vi.waitFor(() => expect(lead.calls.slice(before).some((call) => has(call, "证书快过期了"))).toBe(true), { timeout: 350 });

    // Cold again: the next event waits again.
    await sleep(700);
    const cold = lead.calls.length;
    blocker("磁盘快满了");
    await sleep(600);
    expect(lead.calls.length).toBe(cold);
    await vi.waitFor(() => expect(lead.calls.slice(cold).some((call) => has(call, "磁盘快满了"))).toBe(true), { timeout: 2_000 });
  }, 20_000);

  it("does not hold a reminder that is due", async () => {
    const { lead, setPace } = await boot();
    await setPace(4);
    blocker("依赖升级卡住了");
    await sleep(300);
    expect(lead.calls.length).toBe(0);
    reminderFires("部署窗口快关了");
    await vi.waitFor(() => expect(lead.calls.some((call) => has(call, "部署窗口快关了"))).toBe(true), { timeout: 1_000 });
  }, 20_000);

  it("tells Lead in each situation how many calls the system made and what the pace is", async () => {
    const { lead, setPace } = await boot();
    blocker("依赖升级卡住了");
    await vi.waitFor(() => expect(lead.calls.length).toBeGreaterThanOrEqual(1), { timeout: 1_000 });
    expect(has(lead.calls[0]!, "系统自己叫醒你调的模型：最近一小时 0/120 次")).toBe(true);
    expect(has(lead.calls[0]!, "普通系统事件的节奏：不攒")).toBe(true);
    await setPace(1);
    await sleep(500);
    const before = lead.calls.length;
    blocker("发布流水线红了");
    await vi.waitFor(() => expect(lead.calls.length).toBeGreaterThan(before), { timeout: 3_000 });
    const call = lead.calls.at(-1)!;
    expect(has(call, "缓存冷了以后攒 1 分钟")).toBe(true);
    expect(has(call, `最近一小时 ${before}/120 次`)).toBe(true);
  }, 20_000);
});

describe("the budget pause and what the user set a time for", () => {
  it("still wakes Lead for a reminder while the budget pauses its other automatic calls", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ lead: { autoBudget: { callsPerHour: 2 } } }));
    const { lead, logs } = await boot();
    blocker("提示 1");
    await vi.waitFor(() => expect(lead.calls.length).toBeGreaterThanOrEqual(1), { timeout: 2_000 });
    await sleep(150);
    blocker("提示 2");
    await vi.waitFor(() => expect(logs.some((line) => line.startsWith("[sched] model.hold action=paused kind=budget"))).toBe(true), { timeout: 5_000 });
    await sleep(300);
    const paused = lead.calls.length;

    // An ordinary event waits for the budget.
    blocker("提示 3");
    await sleep(500);
    expect(lead.calls.length).toBe(paused);

    // A reminder that is due does not.
    reminderFires("部署窗口快关了");
    await vi.waitFor(() => expect(lead.calls.slice(paused).some((call) => has(call, "部署窗口快关了"))).toBe(true), { timeout: 2_000 });
    // The ordinary event still waits, and the pause is still on.
    await sleep(400);
    expect(lead.calls.slice(paused).some((call) => has(call, "提示 3") && !has(call, "部署窗口快关了"))).toBe(false);
    expect(logs.some((line) => line.includes("model.hold action=resumed"))).toBe(false);
  }, 30_000);

  // 2026-11-16: a colleague's direct message arrived during a budget pause. The card showed, and nobody woke Lead.
  it("still wakes Lead for someone who waits in an external channel, and holds the pace for nobody who waits", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ lead: { autoBudget: { callsPerHour: 2 } } }));
    const slack = new FakeSlack({ users: { U0NINA: { name: "Nina" } } });
    const { lead, logs, dm, setPace } = await boot(() => ({ say: "处理了。" }), slack);
    await setPace(4);
    // The pace holds an ordinary event on the cold cache, but not Nina.
    blocker("提示 1");
    await sleep(300);
    expect(lead.calls.length).toBe(0);
    await dm("U0NINA", "在吗，发布的时间定了没有");
    await vi.waitFor(() => expect(lead.calls.some((call) => has(call, "发布的时间定了没有"))).toBe(true), { timeout: 3_000 });

    // Use up the budget, then Nina writes again: Lead still wakes for her; the ordinary event still waits.
    await vi.waitFor(() => expect(logs.some((line) => line.startsWith("[sched] model.hold action=paused kind=budget"))).toBe(true), { timeout: 8_000 });
    await sleep(300);
    const paused = lead.calls.length;
    blocker("提示 9");
    await dm("U0NINA", "另外，回滚的预案在哪");
    await vi.waitFor(() => expect(lead.calls.slice(paused).some((call) => has(call, "回滚的预案在哪"))).toBe(true), { timeout: 3_000 });
    await sleep(400);
    expect(lead.calls.slice(paused).some((call) => has(call, "提示 9") && !has(call, "回滚的预案在哪"))).toBe(false);
  }, 30_000);
});
