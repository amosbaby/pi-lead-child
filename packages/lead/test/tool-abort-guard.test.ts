// 工具中止兜底的决策边界（tool-abort-guard.ts，.scratch/tool-occupancy/spec.md L1、L2）：工具先返回、宽限内响应中止、
// 过了宽限还不返回；按工具清单，改东西的调用在调度器中止时转后台、只读的停下；软时限、插话、stop_job 和作业上限。
import { describe, expect, it } from "vitest";
import {
  BackgroundJobRegistry, detachOnAbort, ForegroundWaits, type LeadBackgroundJob, type LeadBackgroundJobs,
} from "../src/background-jobs.js";
import type { LeadAbortReason } from "../src/scheduler/controller.js";
import { guardToolAbort, installToolAbortGuard, isAbortGuarded } from "../src/tool-abort-guard.js";

type Result = { content: Array<{ type: string; text?: string }>; isError?: boolean; details?: unknown };
const result = (text: string, isError = false): Result => ({ content: [{ type: "text", text }], ...(isError ? { isError } : {}) });
const textOf = (value: unknown) => ((value as Result).content ?? []).map((part) => part.text ?? "").join("");

function recorder() {
  const started: LeadBackgroundJob[] = [];
  const finished: Array<LeadBackgroundJob & { text: string; isError: boolean; ms: number }> = [];
  const jobs: LeadBackgroundJobs = { started: (job) => { started.push(job); }, finished: (job) => { finished.push(job); } };
  return { jobs, started, finished };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

describe("guardToolAbort", () => {
  it("passes the result through when the tool returns before any abort", async () => {
    const tool = guardToolAbort({ name: "quick", execute: async (..._args: unknown[]) => result("好了") }, { graceMs: 50 });
    expect(textOf(await tool.execute("c1", {}, new AbortController().signal))).toBe("好了");
  });

  it("passes the error through when the tool throws before any abort", async () => {
    const tool = guardToolAbort({ name: "broken", execute: async (..._args: unknown[]) => { throw new Error("坏了"); } }, { graceMs: 50 });
    await expect(tool.execute("c1", {}, new AbortController().signal)).rejects.toThrow("坏了");
  });

  it("calls the tool as is when pi gives no signal", async () => {
    const tool = guardToolAbort({ name: "plain", execute: async (_id: string, params: { n: number }) => result(String(params.n + 1)) });
    expect(textOf(await tool.execute("c1", { n: 1 }))).toBe("2");
  });

  it("keeps the tool's own answer when it stops within the grace after an abort", async () => {
    const { jobs, started } = recorder();
    const tool = guardToolAbort({
      name: "listens",
      execute: (_id: string, _params: unknown, signal: AbortSignal) => new Promise<Result>((resolve) => {
        signal.addEventListener("abort", () => resolve(result("停下了")), { once: true });
      }),
    }, { graceMs: 200, jobs });
    const controller = new AbortController();
    const running = tool.execute("c1", {}, controller.signal);
    controller.abort();
    expect(textOf(await running)).toBe("停下了");
    expect(started).toEqual([]);
  });

  it("ends the step after the grace when the tool ignores the abort, and hands the late result back as a background job", async () => {
    const { jobs, started, finished } = recorder();
    const lines: string[] = [];
    const late = deferred<Result>();
    const tool = guardToolAbort({ name: "deaf", execute: (..._args: unknown[]) => late.promise }, { graceMs: 30, jobs, log: (line) => lines.push(line) });
    const controller = new AbortController();
    const running = tool.execute("call-7", { command: "softwareupdate -d x" }, controller.signal);
    controller.abort();
    const answer = await running as Result;
    expect(textOf(answer)).toContain("转到后台");
    expect(answer.details).toMatchObject({ detached: true, backgroundJob: started[0]!.id });
    expect(started[0]).toMatchObject({ tool: "deaf", toolCallId: "call-7", command: "softwareupdate -d x" });
    expect(lines.some((line) => line.startsWith("[sched] tool.detached tool=deaf"))).toBe(true);

    late.resolve(result("下载完了"));
    await expect.poll(() => finished.length).toBe(1);
    expect(finished[0]).toMatchObject({ id: started[0]!.id, text: "下载完了", isError: false });
  });

  it("reports a late failure of a detached tool as an error", async () => {
    const { jobs, finished } = recorder();
    const late = deferred<Result>();
    const tool = guardToolAbort({ name: "deaf", execute: (..._args: unknown[]) => late.promise }, { graceMs: 10, jobs });
    const controller = new AbortController();
    controller.abort();
    await tool.execute("c1", {}, controller.signal);
    late.reject(new Error("磁盘满了"));
    await expect.poll(() => finished.length).toBe(1);
    expect(finished[0]).toMatchObject({ text: "磁盘满了", isError: true });
  });

  it("wraps a tool once, and keeps its name, description and parameters", () => {
    const original = { name: "t", description: "说明", parameters: { type: "object" }, execute: async () => result("") };
    const once = guardToolAbort(original);
    expect(isAbortGuarded(original)).toBe(false);
    expect(isAbortGuarded(once)).toBe(true);
    expect(guardToolAbort(once)).toBe(once);
    expect(once).toMatchObject({ name: "t", description: "说明", parameters: { type: "object" } });
  });
});

describe("installToolAbortGuard", () => {
  it("wraps the current tools and every tool list set later", () => {
    let tools: any[] = [{ name: "a", execute: async () => result("") }];
    const agent = { state: { get tools() { return tools; }, set tools(next: any[]) { tools = next.slice(); } } };
    installToolAbortGuard(agent);
    expect(agent.state.tools.every(isAbortGuarded)).toBe(true);
    agent.state.tools = [{ name: "b", execute: async () => result("") }, ...agent.state.tools];
    expect(agent.state.tools.map((tool) => [tool.name, isAbortGuarded(tool)])).toEqual([["b", true], ["a", true]]);
  });
});

describe("stopping or detaching a host command when the step is aborted", () => {
  it("stops it for the user's /stop, the shutdown drain and an unknown cause, and detaches it for the scheduler's own aborts", () => {
    expect(detachOnAbort(null)).toBe(false);
    expect(detachOnAbort({ kind: "user_stop" })).toBe(false);
    expect(detachOnAbort({ kind: "drain" })).toBe(false);
    expect(detachOnAbort({ kind: "budget" })).toBe(true);
    expect(detachOnAbort({ kind: "preempt", by: "user" })).toBe(true);
    expect(detachOnAbort({ kind: "handoff_timeout" })).toBe(true);
    expect(detachOnAbort({ kind: "stage_timeout", stage: "C" })).toBe(true);
    expect(detachOnAbort({ kind: "idle_yield", by: "L0" })).toBe(true);
  });

});

// 一个永远不自己结束的调用：记下它拿到的信号，信号来了才结束（像接收中止的 run_on_host）。
function hanging() {
  const seen: { signal: AbortSignal | null } = { signal: null };
  const late = deferred<Result>();
  const execute = (_id: string, _params: unknown, signal: AbortSignal) => {
    seen.signal = signal;
    signal.addEventListener("abort", () => late.resolve(result("停掉了")), { once: true });
    return late.promise;
  };
  return { seen, late, execute };
}

describe("what an abort does to a call, by the tool manifest", () => {
  const abortWith = (reason: LeadAbortReason | null) => {
    const step = new AbortController();
    return { step, abortReason: () => reason };
  };

  it("moves a write to the background for the scheduler's own abort, without stopping it", async () => {
    const { jobs, started, finished } = recorder();
    const call = hanging();
    const { step, abortReason } = abortWith({ kind: "budget" });
    const tool = guardToolAbort({ name: "run_on_host", execute: call.execute }, { jobs, abortReason, settleMs: 20 });
    const running = tool.execute("c1", { command: "sleep 60" }, step.signal);
    step.abort();
    const answer = await running as Result;
    expect(textOf(answer)).toContain("这一步被系统停下了，run_on_host 没有停");
    expect(call.seen.signal!.aborted).toBe(false);
    expect(started).toHaveLength(1);
    call.late.resolve(result("做完了"));
    await expect.poll(() => finished.length).toBe(1);
    expect(finished[0]!.text).toBe("做完了");
  });

  it("stops a write for the user's /stop", async () => {
    const { jobs, started } = recorder();
    const call = hanging();
    const { step, abortReason } = abortWith({ kind: "user_stop" });
    const tool = guardToolAbort({ name: "run_on_host", execute: call.execute }, { jobs, abortReason, settleMs: 20 });
    const running = tool.execute("c1", {}, step.signal);
    step.abort();
    expect(textOf(await running)).toBe("停掉了");
    expect(started).toEqual([]);
  });

  it("stops a read for the scheduler's own abort", async () => {
    const { jobs, started } = recorder();
    const call = hanging();
    const { step, abortReason } = abortWith({ kind: "budget" });
    const tool = guardToolAbort({ name: "grep", execute: call.execute }, { jobs, abortReason, settleMs: 20 });
    const running = tool.execute("c1", {}, step.signal);
    step.abort();
    expect(textOf(await running)).toBe("停掉了");
    expect(started).toEqual([]);
  });

  it("returns the real result of a write that ends within the settle window after the abort", async () => {
    const { jobs, started } = recorder();
    const late = deferred<Result>();
    const step = new AbortController();
    const tool = guardToolAbort({ name: "save_note", execute: (..._args: unknown[]) => late.promise }, {
      jobs, abortReason: () => ({ kind: "budget" }), settleMs: 200,
    });
    const running = tool.execute("c1", {}, step.signal);
    step.abort();
    late.resolve(result("记下了"));
    expect(textOf(await running)).toBe("记下了");
    expect(started).toEqual([]);
  });
});

describe("the soft limit and steering in", () => {
  it("moves a call that outlasts the soft limit to the background", async () => {
    const { jobs, started, finished } = recorder();
    const call = hanging();
    const tool = guardToolAbort({ name: "codemode", execute: call.execute }, { jobs, softMs: 30 });
    const answer = await tool.execute("c1", { code: "await tools.x()" }, new AbortController().signal) as Result;
    expect(textOf(answer)).toMatch(/codemode 跑了 0 秒还没结束，转到后台：作业 job_/u);
    expect(call.seen.signal!.aborted).toBe(false);
    expect(started).toHaveLength(1);
    call.late.resolve(result("脚本跑完了"));
    await expect.poll(() => finished.length).toBe(1);
  });

  it("moves a waiting call to the background when the user steers in, and says to answer the user first", async () => {
    const { jobs, started } = recorder();
    const waits = new ForegroundWaits();
    const call = hanging();
    const tool = guardToolAbort({ name: "run_on_host", execute: call.execute }, { jobs, waits, settleMs: 0 });
    const running = tool.execute("c1", {}, new AbortController().signal);
    expect(waits.detachAll()).toBe(1);
    const answer = await running;
    expect(textOf(answer)).toContain("用户插话了，run_on_host 没有停");
    expect(textOf(answer)).toContain("stop_job");
    expect(call.seen.signal!.aborted).toBe(false);
    expect(started).toHaveLength(1);
    expect(waits.detachAll()).toBe(0);
  });

  it("lets a call that ends within the settle window answer for itself when the user steers in", async () => {
    const { jobs, started } = recorder();
    const waits = new ForegroundWaits();
    const late = deferred<Result>();
    const tool = guardToolAbort({ name: "get_ticket", execute: (..._args: unknown[]) => late.promise }, { jobs, waits, settleMs: 200 });
    const running = tool.execute("c1", {}, new AbortController().signal);
    waits.detachAll();
    late.resolve(result("工单 #3"));
    expect(textOf(await running)).toBe("工单 #3");
    expect(started).toEqual([]);
  });

  it("leaves a call that already returned alone", async () => {
    const { jobs, started } = recorder();
    const waits = new ForegroundWaits();
    const tool = guardToolAbort({ name: "bash", execute: async (..._args: unknown[]) => result("很快") }, { jobs, waits });
    expect(textOf(await tool.execute("c1", { command: "ls" }, new AbortController().signal))).toBe("很快");
    expect(waits.detachAll()).toBe(0);
    expect(started).toEqual([]);
  });
});

describe("background jobs", () => {
  it("stops a job when Lead calls stop_job, and says so in the result it hands back", async () => {
    const { jobs, started, finished } = recorder();
    const registry = new BackgroundJobRegistry();
    const call = hanging();
    const tool = guardToolAbort({ name: "run_on_host", execute: call.execute }, { jobs, registry, softMs: 10 });
    await tool.execute("c1", { command: "brew upgrade" }, new AbortController().signal);
    expect(registry.list().map((job) => job.id)).toEqual([started[0]!.id]);
    expect(registry.stop(started[0]!.id)).toMatchObject({ tool: "run_on_host", command: "brew upgrade" });
    expect(call.seen.signal!.aborted).toBe(true);
    await expect.poll(() => finished.length).toBe(1);
    expect(finished[0]!.text).toBe("（这个作业被 stop_job 停掉了。）停掉了");
    expect(registry.list()).toEqual([]);
    expect(registry.stop(started[0]!.id)).toBeNull();
  });

  it("stops a job that runs past the background limit", async () => {
    const { jobs, finished } = recorder();
    const call = hanging();
    const tool = guardToolAbort({ name: "codemode", execute: call.execute }, { jobs, softMs: 10, maxJobMs: 60 });
    await tool.execute("c1", {}, new AbortController().signal);
    await expect.poll(() => finished.length).toBe(1);
    expect(finished[0]!.text).toContain("后台作业的上限");
  });

  it("keeps a longer limit the tool was given", async () => {
    const { jobs, finished } = recorder();
    const call = hanging();
    const tool = guardToolAbort({ name: "run_on_host", execute: call.execute }, { jobs, softMs: 10, maxJobMs: 60 });
    await tool.execute("c1", { timeout_seconds: 600 }, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(call.seen.signal!.aborted).toBe(false);
    expect(finished).toEqual([]);
    call.late.resolve(result("下完了"));
    await expect.poll(() => finished.length).toBe(1);
  });
});

describe("an instant tool that takes too long", () => {
  it("writes a tool.overrun line", async () => {
    const lines: string[] = [];
    const late = deferred<Result>();
    const tool = guardToolAbort({ name: "get_ticket", execute: (..._args: unknown[]) => late.promise }, { log: (line) => lines.push(line) });
    const running = tool.execute("c9", {}, new AbortController().signal);
    await expect.poll(() => lines.some((line) => line.startsWith("[sched] tool.overrun tool=get_ticket call=c9")), { timeout: 4_000 }).toBe(true);
    late.resolve(result("好了"));
    expect(textOf(await running)).toBe("好了");
  });
});
