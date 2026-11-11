// 一步停不下时释放 Lead 的规则（scheduler/runtime.ts，.scratch/tool-occupancy/spec.md L3，用户 2026-11-11）：
//   · abort.stuck 以后再等 releaseWaitMs，执行层还没停下，就叫 release（daemon 换掉会话），触发方式是 auto；
//   · 中止晚到了（释放以前停下了）：不释放，写 abort.late；
//   · 中止已经发出、还没停下时 releaseNow（用户又 /stop）：马上释放，不等宽限；
//   · 单元结束了、停机前的排空：不释放。
import { describe, expect, it } from "vitest";
import { LeadSchedulerRuntime, type LeadReleaseRequest } from "../src/scheduler/index.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function runtime(stop: () => unknown, options: { graceMs?: number; waitMs?: number } = {}) {
  const logs: string[] = [];
  const records: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const releases: LeadReleaseRequest[] = [];
  const rt = new LeadSchedulerRuntime({
    log: (line) => logs.push(line), record: (kind, payload) => records.push({ kind, payload }),
    stopExecution: stop, abortGraceMs: options.graceMs ?? 30, releaseWaitMs: options.waitMs ?? 40,
    release: async (request) => { releases.push(request); },
    newUnitId: () => "unit_t",
  });
  rt.openUnit({ source: "user", lane: 0, origin: null, turnId: "turn_1" });
  rt.noteStage({ run: 1, step: 2, stage: "A", since: Date.now() });
  return { rt, logs, records, releases };
}

describe("releasing Lead when a step does not stop", () => {
  it("releases after abort.stuck plus the wait, with the stage and the first reason", async () => {
    const { rt, logs, records, releases } = runtime(() => new Promise(() => {}));
    rt.dispatch({ type: "stop.request", canAbort: true });
    expect(rt.abortPending).toBe(true);
    await rt.aborting;
    expect(releases).toHaveLength(0);
    await delay(80);
    expect(releases).toEqual([expect.objectContaining({
      trigger: "auto", unitId: "unit_t", segment: 1, reason: "user_stop", stage: expect.objectContaining({ stage: "A", step: 2 }),
    })]);
    expect(releases[0]!.stuckMs).toBeGreaterThanOrEqual(60);
    await rt.releasing;
    expect(logs.some((line) => line.startsWith("[sched] release.start unit=unit_t trigger=auto reason=user_stop"))).toBe(true);
    expect(logs.some((line) => line.startsWith("[sched] release.done unit=unit_t trigger=auto"))).toBe(true);
    expect(records).toContainEqual({ kind: "decided", payload: expect.objectContaining({ unitId: "unit_t", decision: "release", trigger: "auto" }) });
    expect(rt.abortPending).toBe(false);
  });

  it("does not release when the stop arrives late, and logs abort.late", async () => {
    let stopped!: () => void;
    const { rt, logs, releases } = runtime(() => new Promise<void>((resolve) => { stopped = resolve; }), { waitMs: 200 });
    rt.dispatch({ type: "stop.request", canAbort: true });
    await rt.aborting;
    expect(logs.some((line) => line.startsWith("[sched] abort.stuck"))).toBe(true);
    stopped();
    await delay(250);
    expect(releases).toHaveLength(0);
    expect(logs.some((line) => line.startsWith("[sched] abort.late unit=unit_t reason=user_stop"))).toBe(true);
  });

  it("releases at once when asked while an abort has not stopped, and only once", async () => {
    const { rt, releases } = runtime(() => new Promise(() => {}), { graceMs: 5_000, waitMs: 60_000 });
    expect(rt.releaseNow()).toBe(false);
    rt.dispatch({ type: "stop.request", canAbort: true });
    expect(rt.releaseNow()).toBe(true);
    expect(releases).toEqual([expect.objectContaining({ trigger: "user_stop", unitId: "unit_t" })]);
    expect(rt.releaseNow()).toBe(false);
    expect(releases).toHaveLength(1);
  });

  it("does not release for a unit that already ended", async () => {
    const { rt, releases } = runtime(() => new Promise(() => {}));
    rt.dispatch({ type: "stop.request", canAbort: true });
    await rt.aborting;
    rt.closeUnit("stopped");
    await delay(80);
    expect(releases).toHaveLength(0);
    expect(rt.abortPending).toBe(false);
  });

  it("does not release while the daemon drains before it stops", async () => {
    const { rt, releases } = runtime(() => new Promise(() => {}));
    rt.dispatch({ type: "drain.start" });
    rt.dispatch({ type: "drain.abort" });
    await rt.aborting;
    await delay(80);
    expect(releases).toHaveLength(0);
    expect(rt.releaseNow()).toBe(false);
  });

  it("keeps the old behavior when the daemon gives no release", async () => {
    const logs: string[] = [];
    const rt = new LeadSchedulerRuntime({ log: (line) => logs.push(line), stopExecution: () => new Promise(() => {}), abortGraceMs: 20 });
    rt.openUnit({ source: "user", lane: 0, origin: null, turnId: null });
    rt.dispatch({ type: "stop.request", canAbort: true });
    await rt.aborting;
    expect(rt.releaseNow()).toBe(false);
    expect(logs.some((line) => line.startsWith("[sched] abort.stuck"))).toBe(true);
  });
});
