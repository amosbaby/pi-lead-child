// Lead 的一步永远停得下来：工具调用的统一兜底（.scratch/tool-occupancy/spec.md L1、L2）。
//
// pi 的对话循环对每个工具只做一次 await tool.execute(id, args, signal, onUpdate)（pi-agent-core 的
// executePreparedToolCall）。工具不理 signal，这一步就结束不了；session.abort() 等 pi 空闲，也跟着挂住。
// 2026-11-10 那一次：run_on_host 在前台下载 3.2 GB，红线到点中止（abort reason=budget），5 秒后 abort.stuck，
// 用户的插话排在后面十几分钟。
//
// 这里给会话里的每个工具包一层，不靠工具自己。工具拿到的是这一次调用自己的中止信号（作业的信号），不是这一步的：
//   · 工具在下面这些事以前返回：原样交给 pi。
//   · 这一步被中止：只读的调用（tool-manifest.ts 的 effect）收到中止信号、停下；改东西的调用在调度器为了空出 Lead 而中止时
//     （红线、抢占等，background-jobs.ts 的 detachOnAbort）不停，转后台；用户 /stop、停机排空时也停下。停下的调用有
//     graceMs 去响应，过了宽限还没返回也转后台（它不听 signal）。
//   · 软时限（只在 Lead 自己的会话里，softMs）：过了还没返回，转后台。
//   · 用户插话（只在 Lead 自己的会话里，waits）：马上转后台。
// 转后台：马上给 pi 一个结果（「转到后台：作业 #id」），这一步就能结束。调用接着跑，结束时结果经 LeadBackgroundJobs
// 交回 Lead（daemon 写一条叫醒 Lead 的收件箱）。工作不丢（spec I3）。Lead 用 stop_job 停掉一个作业；作业跑过上限
// （backgroundJobMaxMs，或者工具自己更长的时限）也停掉。
// 子 agent 的会话不给 softMs 和 waits：它本来就在后台跑，没有人在等它（用户 2026-11-11：子 agent 可以放宽）。
//
// 包在 agent.state.tools 上：Lead 的自定义工具、hands.ts 换过的 bash/edit/write、pi 的内置工具、SoL-Pi 和扩展注册的
// 工具都从这里进 pi 的对话循环。pi 每次换工具表（setActiveToolsByName、扩展重载）都写 agent.state.tools，所以包在
// 它的 setter 上，新的工具进来时也包上。codemode 脚本里嵌套的调用不经过这一层：codemode 自己被包着，整段脚本一起转后台。
import {
  backgroundJobMaxMs, detachOnAbort, newBackgroundJobId, toolResultText,
  type BackgroundJobRegistry, type ForegroundWaits, type JobStopCause, type LeadBackgroundJob, type LeadBackgroundJobs,
} from "./background-jobs.js";
import type { LeadAbortReason } from "./scheduler/controller.js";
import { toolDeclaration, toolDuration, toolEffect } from "./tool-manifest.js";

export const LEAD_TOOL_ABORT_GRACE_MS_ENV = "PLC_LEAD_TOOL_ABORT_GRACE_MS";
// 调度器等中止落地的宽限是 5 秒（scheduler/runtime.ts 的 DEFAULT_ABORT_GRACE_MS），这里要比它短，留出 pi 收尾的时间。
export const DEFAULT_TOOL_ABORT_GRACE_MS = 2_000;
// 插话、调度器中止要转后台时，刚开始跑的调用先等这么久：几毫秒就结束的调用照常返回，不变成一个后台作业。
export const DEFAULT_DETACH_SETTLE_MS = 1_000;
// instant 的工具超过这么久写一行 [sched] tool.overrun。
export const INSTANT_TOOL_BUDGET_MS = 2_000;

export function toolAbortGraceMs(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env[LEAD_TOOL_ABORT_GRACE_MS_ENV]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOOL_ABORT_GRACE_MS;
}

const GUARDED = Symbol.for("plc.lead.toolAbortGuard");

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean; details?: unknown };

export interface ToolAbortGuardOptions {
  graceMs?: number;
  // daemon 给的出口：转后台的调用记成后台作业，结束时把结果交给 Lead。不给时只写日志。
  jobs?: LeadBackgroundJobs;
  // 正在跑的后台作业（stop_job 用）。
  registry?: BackgroundJobRegistry;
  // 这一步为什么被中止（调度器的 controller.abortReason）。不给时按原因不明处理：都停下。
  abortReason?: () => LeadAbortReason | null;
  // Lead 自己的会话才给：软时限和插话时马上转后台。
  softMs?: number;
  waits?: ForegroundWaits;
  settleMs?: number;
  maxJobMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}

/** 这个工具已经包过了吗（测试和 session.ts 的自检用）。 */
export function isAbortGuarded(tool: unknown): boolean {
  return Boolean(tool && typeof tool === "object" && (tool as Record<symbol, unknown>)[GUARDED]);
}

function summaryOf(params: unknown): string {
  if (params && typeof params === "object") {
    const command = (params as { command?: unknown }).command;
    if (typeof command === "string") return command.slice(0, 300);
  }
  try {
    return (JSON.stringify(params) ?? "").slice(0, 300);
  } catch {
    return "";
  }
}

/** 工具自己的时限（毫秒）：bash 的 timeout、run_on_host 的 timeout_seconds（秒）。 */
function ownLimitMs(params: unknown): number {
  const input = (params ?? {}) as { timeout?: unknown; timeout_seconds?: unknown };
  const seconds = Number(input.timeout_seconds ?? input.timeout);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 0;
}

type DetachWhy = "soft" | "steer" | "abort" | "stuck";

function seconds(ms: number): number {
  return Math.round(ms / 1_000);
}

function detachedText(why: DetachWhy, tool: string, job: LeadBackgroundJob, options: ToolAbortGuardOptions): string {
  const ran = seconds(job.softMs);
  const head = {
    soft: `${tool} 跑了 ${ran} 秒还没结束，转到后台：作业 ${job.id}。`,
    steer: `用户插话了，${tool} 没有停（已经跑了 ${ran} 秒），转到后台：作业 ${job.id}。先回应用户的插话；插话要你停下或者说前面做错了，用 stop_job 停掉它，再收拾它做了一半的事。`,
    abort: `这一步被系统停下了，${tool} 没有停（已经跑了 ${ran} 秒），转到后台：作业 ${job.id}。`,
    stuck: `这一步被中止了，${tool} 过了 ${ran} 秒还没结束，它没有停：转到后台，作业 ${job.id}。`,
  }[why];
  return head
    + (options.jobs ? "它结束时系统会叫醒你，把结果交给你。现在可以先做别的、先回用户一句。" : "")
    + "不要再调一次同样的调用；它做的事可能已经做了一部分。"
    + (options.registry && why !== "steer" ? "要停掉它，用 stop_job。" : "");
}

const STOP_NOTE: Record<JobStopCause, (ms: number) => string> = {
  lead: () => "（这个作业被 stop_job 停掉了。）",
  max: (ms) => `（这个作业跑到了后台作业的上限 ${seconds(ms)} 秒，系统停掉了它。）`,
};

/** 给一个工具包上中止兜底。已经包过的原样返回。 */
export function guardToolAbort<T extends { name: string; execute: (...args: any[]) => any }>(tool: T, options: ToolAbortGuardOptions = {}): T {
  if (isAbortGuarded(tool)) return tool;
  const now = options.now ?? Date.now;
  const original = tool.execute;
  const execute = (toolCallId: string, params: unknown, signal?: AbortSignal, ...rest: unknown[]): Promise<unknown> => {
    const watched = Boolean(signal || options.softMs || options.waits);
    if (!watched) {
      try {
        return Promise.resolve(original.call(tool, toolCallId, params, signal, ...rest));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const started = now();
    const job = new AbortController();
    let stopCause: JobStopCause | null = null;
    // 同步调用工具（和 pi 一样），它挂 abort 监听的时机不变；同步抛的错也变成 rejected。
    let running: Promise<unknown>;
    try {
      running = Promise.resolve(original.call(tool, toolCallId, params, job.signal, ...rest));
    } catch (error) {
      running = Promise.reject(error);
    }
    type Outcome = { value: unknown } | { error: unknown };
    const settled: Promise<Outcome> = running.then((value) => ({ value }), (error: unknown) => ({ error }));
    const unwrap = (outcome: Outcome): unknown => {
      if ("error" in outcome) throw outcome.error;
      return outcome.value;
    };
    return new Promise<unknown>((resolve, reject) => {
      let done = false;
      const timers = new Set<ReturnType<typeof setTimeout>>();
      const later = (ms: number, fn: () => void) => {
        const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
        timer.unref?.();
        timers.add(timer);
      };
      let leaveWaits: (() => void) | undefined;
      const cleanup = () => {
        done = true;
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        signal?.removeEventListener("abort", onAbort);
        leaveWaits?.();
      };
      const finish = (outcome: Outcome) => {
        if (done) return;
        cleanup();
        try {
          resolve(unwrap(outcome));
        } catch (error) {
          reject(error);
        }
      };
      const detach = (why: DetachWhy) => {
        if (done) return;
        cleanup();
        const record: LeadBackgroundJob = {
          id: newBackgroundJobId(), tool: tool.name, command: summaryOf(params), toolCallId, softMs: now() - started,
        };
        options.log?.(`[sched] tool.detached tool=${tool.name} call=${toolCallId} job=${record.id} why=${why} ms=${record.softMs}`);
        const stop = (cause: JobStopCause) => {
          if (stopCause) return;
          stopCause = cause;
          options.log?.(`[sched] job.stop job=${record.id} tool=${tool.name} cause=${cause}`);
          job.abort();
        };
        const leaveRegistry = options.registry?.add(record, stop);
        // 工具自己的时限更长时（run_on_host 的 timeout_seconds 最多 30 分钟），按它的再留 30 秒让它自己收尾。
        const own = ownLimitMs(params);
        const maxMs = Math.max(options.maxJobMs ?? backgroundJobMaxMs(), own ? own + 30_000 : 0);
        const cap = setTimeout(() => stop("max"), Math.max(0, maxMs - record.softMs));
        cap.unref?.();
        options.jobs?.started(record);
        void settled.then((outcome) => {
          clearTimeout(cap);
          leaveRegistry?.();
          const failed = "error" in outcome;
          const text = (stopCause ? STOP_NOTE[stopCause](now() - started) : "") + (failed
            ? (outcome.error instanceof Error ? outcome.error.message : String(outcome.error))
            : toolResultText(outcome.value as ToolResult));
          options.log?.(`[sched] tool.detached_end tool=${tool.name} job=${record.id} ms=${now() - started} error=${failed}`);
          options.jobs?.finished({
            ...record, text, isError: failed || Boolean((outcome as { value?: ToolResult }).value?.isError), ms: now() - started,
          });
        });
        resolve({
          content: [{ type: "text", text: detachedText(why, tool.name, record, options) }],
          details: { backgroundJob: record.id, detached: true },
        });
      };
      // 插话、调度器中止要转后台时，刚开始的调用先等到 settleMs：很快就结束的照常返回。
      const detachSoon = (why: "steer" | "abort") => {
        const waited = now() - started;
        const settle = options.settleMs ?? DEFAULT_DETACH_SETTLE_MS;
        if (waited >= settle) detach(why);
        else later(settle - waited, () => detach(why));
      };
      let aborted = false;
      function onAbort() {
        if (done || aborted) return;
        aborted = true;
        const reason = options.abortReason?.() ?? null;
        if (toolEffect(tool.name, params) === "write" && detachOnAbort(reason)) {
          detachSoon("abort");
          return;
        }
        job.abort();
        later(options.graceMs ?? toolAbortGraceMs(), () => detach("stuck"));
      }
      void settled.then(finish);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      if (options.softMs) later(options.softMs, () => detach("soft"));
      if (options.waits) leaveWaits = options.waits.add(() => detachSoon("steer"));
      if (toolDeclaration(tool.name) && toolDuration(tool.name) === "instant") {
        later(INSTANT_TOOL_BUDGET_MS, () => {
          options.log?.(`[sched] tool.overrun tool=${tool.name} call=${toolCallId} budgetMs=${INSTANT_TOOL_BUDGET_MS}`);
        });
      }
    });
  };
  return { ...tool, execute, [GUARDED]: true } as T;
}

/**
 * 给 pi 会话的 agent 装上中止兜底：现在的工具表包一遍，以后每次换工具表（写 agent.state.tools）都包上新的。
 * 和 step-interrupt.ts 一样直接动 pi Agent 的成员：agent.state 是 pi-agent-core 的 createMutableAgentState 建的普通对象，
 * tools 是它的 getter/setter。
 */
export function installToolAbortGuard(agent: { state: { tools: any[] } }, options: ToolAbortGuardOptions = {}): void {
  const state = agent.state as Record<string, any>;
  const descriptor = Object.getOwnPropertyDescriptor(state, "tools");
  if (!descriptor?.get || !descriptor.set) throw new Error("pi agent.state.tools 不是 getter/setter，工具中止兜底装不上");
  const get = descriptor.get.bind(state);
  const set = descriptor.set.bind(state);
  const wrap = (tools: any[]) => tools.map((tool) => guardToolAbort(tool, options));
  Object.defineProperty(state, "tools", {
    configurable: true,
    enumerable: descriptor.enumerable ?? true,
    get,
    set: (next: any[]) => {
      set(wrap(next));
    },
  });
  set(wrap(get()));
}
