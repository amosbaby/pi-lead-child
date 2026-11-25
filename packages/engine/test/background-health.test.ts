// 后台任务的健康（.scratch/background-models spec D3）：失败和恢复交给 Lead，但不成风暴。核对：
//   - 连续 3 次失败、跨度至少 5 分钟才转为失败；只有这一次转变写 system.background_failing（tell），之后的失败不再写；
//   - 成功一次并且 10 分钟没有失败才恢复，写 system.background_recovered（record），只在告诉过 Lead 时写；
//   - 同一任务、同一类原因 6 小时内最多一条；所有任务每小时最多 4 条，多的折进下一条；
//   - 模型暂停期间什么也不写，holdLifted 以后还在失败的才写；
//   - 状态在 kv 里，重启（新建一个实例）不会重发；
//   - 设置页的状态和今天的调用、失败次数。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { BACKGROUND_FAILING_KIND, BACKGROUND_RECOVERED_KIND } from "@pi-lead-child/protocol";
import { listEvents, openDb, type Db } from "@pi-lead-child/store";
import { BACKGROUND_MODEL_OPERATION, createBackgroundHealth, type BackgroundHealth } from "../src/index.js";

let db: Db;
let clock: Date;
let held: boolean;
let health: BackgroundHealth;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function advance(ms: number): void {
  clock = new Date(clock.getTime() + ms);
}

function create(): BackgroundHealth {
  return createBackgroundHealth({ db, now: () => clock, log: () => {}, held: () => held });
}

beforeEach(() => {
  db = openDb(join(tempDir("plc-background-health-"), "plc.db"));
  // 本地中午，测试里推几个小时都不跨本地日期（跨日的测试自己推到第二天）。
  clock = new Date(2026, 10, 20, 9, 0, 0);
  held = false;
  health = create();
});

const failing = () => listEvents(db, { kind: BACKGROUND_FAILING_KIND, limit: 50 });
const recovered = () => listEvents(db, { kind: BACKGROUND_RECOVERED_KIND, limit: 50 });

const fail = (job: string, reasonClass = "quota", extra: { action?: string | null; operation?: string | null; reason?: string } = {}) =>
  health.report(job, { ok: false, reasonClass, reason: extra.reason ?? `${reasonClass} error`, ...extra });
const succeed = (job: string) => health.report(job, { ok: true });

// 让一个任务转为失败：3 次失败，跨 5 分钟。
function makeFailing(job: string, reasonClass = "quota"): void {
  fail(job, reasonClass);
  advance(2.5 * MINUTE);
  fail(job, reasonClass);
  advance(2.5 * MINUTE);
  fail(job, reasonClass);
}

describe("turning failing", () => {
  it("needs 3 consecutive failures that span at least 5 minutes, and writes the failing event only once", () => {
    fail("background_model");
    advance(MINUTE);
    fail("background_model");
    advance(MINUTE);
    fail("background_model");
    // 3 次，但只跨了 2 分钟。
    expect(failing()).toHaveLength(0);
    expect(health.states().find((state) => state.job === "background_model")?.state).toBe("ok");

    advance(3 * MINUTE);
    fail("background_model", "quota", { action: "switched to model cheap-b", reason: "429 quota exceeded" });
    const events = failing();
    expect(events).toHaveLength(1);
    expect(events[0]!.level).toBe("tell");
    expect(events[0]!.entityKey).toBe("background:background_model");
    expect(events[0]!.rootCause?.code).toBe("quota");
    expect(events[0]!.payload).toMatchObject({
      job: "background_model", reasonClass: "quota", reason: "429 quota exceeded", failures: 4,
      action: "switched to model cheap-b", operation: BACKGROUND_MODEL_OPERATION, folded: [], afterHold: false,
      since: new Date(2026, 10, 20, 9, 0, 0).toISOString(),
    });

    for (let i = 0; i < 10; i += 1) {
      advance(MINUTE);
      fail("background_model");
    }
    expect(failing()).toHaveLength(1);
    const state = health.states().find((entry) => entry.job === "background_model")!;
    expect(state).toMatchObject({ state: "failing", failures: 14, told: true, reasonClass: "quota" });
  });

  it("starts the count again after a success", () => {
    fail("channel_memory");
    advance(3 * MINUTE);
    fail("channel_memory");
    succeed("channel_memory");
    advance(3 * MINUTE);
    fail("channel_memory");
    advance(MINUTE);
    fail("channel_memory");
    expect(failing()).toHaveLength(0);
    advance(4 * MINUTE);
    fail("channel_memory");
    expect(failing()).toHaveLength(1);
    // 别的任务没有默认的操作。
    expect(failing()[0]!.payload.operation).toBeNull();
  });

  it("redacts and caps the reason, and ignores an invalid job name", () => {
    const secret = "password=hunter2hunter2hunter2";
    fail("hindsight", "Auth Failed!", { reason: `login failed ${secret} ${"x".repeat(1_000)}` });
    advance(3 * MINUTE);
    fail("hindsight", "Auth Failed!", { reason: `login failed ${secret} ${"x".repeat(1_000)}` });
    advance(3 * MINUTE);
    fail("hindsight", "Auth Failed!", { reason: `login failed ${secret} ${"x".repeat(1_000)}` });
    const [event] = failing();
    expect(event!.payload.reasonClass).toBe("auth_failed_");
    expect(String(event!.payload.reason)).not.toContain("hunter2");
    expect(String(event!.payload.reason).length).toBeLessThanOrEqual(301);

    health.report("../etc", { ok: false, reasonClass: "x", reason: "y" });
    expect(health.states().map((state) => state.job)).not.toContain("../etc");
  });
});

describe("recovering", () => {
  it("needs a success and 10 quiet minutes, and writes a record-level recovered event", () => {
    makeFailing("background_model");
    expect(failing()).toHaveLength(1);
    advance(MINUTE);
    succeed("background_model");
    // 成功了，但离上一次失败才 1 分钟。
    expect(recovered()).toHaveLength(0);
    expect(health.states().find((state) => state.job === "background_model")?.state).toBe("failing");

    advance(9 * MINUTE);
    succeed("background_model");
    const events = recovered();
    expect(events).toHaveLength(1);
    expect(events[0]!.level).toBe("record");
    expect(events[0]!.payload).toMatchObject({ job: "background_model", reasonClass: "quota", failures: 3 });
    expect(health.states().find((state) => state.job === "background_model")?.state).toBe("ok");
  });

  it("settles a recovery on tick when the success came early and no call came after", () => {
    makeFailing("channel_memory");
    advance(MINUTE);
    succeed("channel_memory");
    advance(5 * MINUTE);
    health.tick();
    expect(recovered()).toHaveLength(0);
    advance(5 * MINUTE);
    health.tick();
    expect(recovered()).toHaveLength(1);
  });

  it("does not recover on quiet time alone, without a success", () => {
    makeFailing("hindsight");
    advance(30 * MINUTE);
    health.tick();
    expect(recovered()).toHaveLength(0);
  });

  it("writes no recovered event when Lead was never told about the episode", () => {
    held = true;
    makeFailing("hindsight");
    advance(MINUTE);
    succeed("hindsight");
    advance(10 * MINUTE);
    succeed("hindsight");
    held = false;
    health.holdLifted();
    expect(failing()).toHaveLength(0);
    expect(recovered()).toHaveLength(0);
  });
});

describe("rate limits", () => {
  it("writes at most one failing event per job and reason class in 6 hours, and the waiting one after the window", () => {
    makeFailing("background_model", "quota");
    advance(MINUTE);
    succeed("background_model");
    advance(10 * MINUTE);
    succeed("background_model");
    expect(recovered()).toHaveLength(1);

    // 同一类原因又失败了：6 小时内不再叫醒 Lead。
    advance(HOUR);
    makeFailing("background_model", "quota");
    expect(failing()).toHaveLength(1);
    expect(health.states().find((state) => state.job === "background_model")).toMatchObject({ state: "failing", told: false });

    // 另一类原因的另一个任务照常写。
    makeFailing("channel_memory", "auth");
    expect(failing()).toHaveLength(2);

    // 6 小时过去，还在失败：现在写。
    advance(5 * HOUR);
    fail("background_model", "quota");
    expect(failing()).toHaveLength(3);
    expect(failing().find((event) => event.seq === Math.max(...failing().map((entry) => entry.seq)))!.payload.job)
      .toBe("background_model");
  });

  it("writes at most 4 failing events an hour across jobs, and folds the rest into the next one", () => {
    const jobs = ["job_a", "job_b", "job_c", "job_d", "job_e", "job_f"];
    for (const job of jobs) {
      makeFailing(job);
      advance(MINUTE);
    }
    // 6 个任务都转为失败了，这一小时只写 4 条。
    expect(failing()).toHaveLength(4);
    expect(failing().map((event) => event.payload.job).sort()).toEqual(["job_a", "job_b", "job_c", "job_d"]);
    expect(health.states().filter((state) => state.state === "failing" && !state.told).map((state) => state.job).sort())
      .toEqual(["job_e", "job_f"]);

    // 一小时以后，下一条写出时，等着的另一个折进去。
    advance(HOUR);
    health.tick();
    const events = failing();
    expect(events).toHaveLength(5);
    const latest = events.reduce((left, right) => (right.seq > left.seq ? right : left));
    expect(latest.payload.job).toBe("job_e");
    expect(latest.payload.folded).toEqual([expect.objectContaining({ job: "job_f", reasonClass: "quota" })]);
    expect(health.states().find((state) => state.job === "job_f")?.told).toBe(true);

    // 折进去的也算告诉过：它恢复时写恢复事件。
    succeed("job_f");
    advance(10 * MINUTE);
    succeed("job_f");
    expect(recovered().map((event) => event.payload.job)).toContain("job_f");
    // 再 tick 不会重写。
    health.tick();
    expect(failing()).toHaveLength(5);
  });
});

describe("the model hold", () => {
  it("writes nothing while held, and the still-failing job's event after the hold lifts", () => {
    held = true;
    makeFailing("background_model");
    advance(MINUTE);
    fail("background_model");
    health.tick();
    expect(failing()).toHaveLength(0);
    expect(health.states().find((state) => state.job === "background_model")?.state).toBe("failing");

    held = false;
    health.holdLifted();
    const events = failing();
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ job: "background_model", afterHold: true, failures: 4 });
    health.holdLifted();
    expect(failing()).toHaveLength(1);
  });

  it("holds a recovered event back while held, and writes it after", () => {
    makeFailing("channel_memory");
    expect(failing()).toHaveLength(1);
    held = true;
    advance(MINUTE);
    succeed("channel_memory");
    advance(10 * MINUTE);
    succeed("channel_memory");
    expect(recovered()).toHaveLength(0);
    expect(health.states().find((state) => state.job === "channel_memory")?.state).toBe("ok");
    held = false;
    health.holdLifted();
    expect(recovered()).toHaveLength(1);
  });

  it("treats a throwing held() as not held", () => {
    health = createBackgroundHealth({ db, now: () => clock, log: () => {}, held: () => { throw new Error("boom"); } });
    makeFailing("hindsight");
    expect(failing()).toHaveLength(1);
  });
});

describe("restart", () => {
  it("keeps the state in kv, so a new instance does not send again", () => {
    makeFailing("background_model");
    expect(failing()).toHaveLength(1);

    // daemon 重启：新的实例，同一个库。
    health = create();
    advance(MINUTE);
    fail("background_model");
    health.tick();
    health.holdLifted();
    expect(failing()).toHaveLength(1);
    expect(health.states().find((state) => state.job === "background_model")).toMatchObject({ state: "failing", told: true, failures: 4 });

    // 恢复也接得上。
    succeed("background_model");
    advance(10 * MINUTE);
    health = create();
    health.tick();
    expect(recovered()).toHaveLength(1);
    health = create();
    health.tick();
    expect(recovered()).toHaveLength(1);
  });

  it("continues a streak across a restart", () => {
    fail("hindsight");
    advance(3 * MINUTE);
    fail("hindsight");
    health = create();
    advance(3 * MINUTE);
    fail("hindsight");
    expect(failing()).toHaveLength(1);
  });
});

describe("states for the settings page", () => {
  it("lists the known jobs and counts today's calls and failures, starting again on a new local day", () => {
    expect(health.states().map((state) => state.job)).toEqual(["background_model", "channel_memory", "hindsight"]);
    succeed("background_model");
    succeed("background_model");
    fail("background_model");
    fail("extra_job");
    const today = health.states();
    expect(today.find((state) => state.job === "background_model")).toMatchObject({
      state: "ok", callsToday: 3, failuresToday: 1, since: null, failures: 0,
    });
    expect(today.find((state) => state.job === "extra_job")).toMatchObject({ callsToday: 1, failuresToday: 1 });

    clock = new Date(2026, 10, 21, 0, 5, 0);
    expect(health.states().find((state) => state.job === "background_model")).toMatchObject({ callsToday: 0, failuresToday: 0 });
    succeed("background_model");
    expect(health.states().find((state) => state.job === "background_model")).toMatchObject({ callsToday: 1, failuresToday: 0 });
  });
});
