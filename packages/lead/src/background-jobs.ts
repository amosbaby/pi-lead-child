// Lead 的后台作业（lead-scheduler spec D6；.scratch/tool-occupancy/spec.md L1、L2）。
//
// Lead 的一步里，一个工具调用占不过软时限（缺省 20 秒）：过了软时限、用户插话、调度器为了空出 Lead 而中止，调用都转成
// 后台作业。Lead 先拿到「转到后台：作业 #id」，这一步就此结束；调用接着跑，结束后 daemon 把结果作为一件事交给 Lead
// （走原单元的车道）。以前到了时限会杀掉命令，已经做的工作也丢了；转后台以后工作能保住。
// 什么时候转、什么时候停由 tool-abort-guard.ts 按工具清单（tool-manifest.ts）决定；这里是共用的部件：
// 时限、作业的登记（stop_job 用它停掉作业）、插话时马上转后台的登记。
import type { LeadAbortReason } from "./scheduler/controller.js";

// 软时限（.scratch/tool-occupancy/spec.md I2）。
export const LEAD_TOOL_SOFT_MS_ENV = "PLC_LEAD_TOOL_SOFT_MS";
export const DEFAULT_TOOL_SOFT_MS = 20_000;
// 后台作业最多跑多久（工具自己没有更长的时限时）。到点停掉，结果照样交回 Lead。
export const LEAD_JOB_MAX_MS_ENV = "PLC_LEAD_JOB_MAX_MS";
export const DEFAULT_JOB_MAX_MS = 10 * 60_000;
// 转后台的只读命令没填 timeout 时最多跑多久（秒）。
export const DEFAULT_BACKGROUND_JOB_MAX_SECONDS = 30 * 60;

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function toolSoftLimitMs(env: Record<string, string | undefined> = process.env): number {
  return positive(env[LEAD_TOOL_SOFT_MS_ENV], DEFAULT_TOOL_SOFT_MS);
}

export function backgroundJobMaxMs(env: Record<string, string | undefined> = process.env): number {
  return positive(env[LEAD_JOB_MAX_MS_ENV], DEFAULT_JOB_MAX_MS);
}

/**
 * 这一步被中止时，改东西的调用是停掉还是转后台（.scratch/tool-occupancy/spec.md 第 7 节第 1 条）。用户 /stop、停机排空、
 * 原因不明时停掉。调度器为了把 Lead 空出来而中止（红线、抢占、阶段超时、交接窗口到点、空闲车道让路）时转后台：
 * 这件事没有被取消，停掉它只会让已经做的工作白做，有副作用的命令还会停在一半。
 */
export function detachOnAbort(reason: LeadAbortReason | null): boolean {
  if (!reason) return false;
  return reason.kind !== "user_stop" && reason.kind !== "drain";
}

export interface LeadBackgroundJob {
  id: string;
  tool: string;
  command: string;
  toolCallId: string;
  // 转后台时已经跑了多久。
  softMs: number;
}

/** daemon 给的出口：记下转后台的作业，作业结束时把结果交给 Lead。 */
export interface LeadBackgroundJobs {
  started(job: LeadBackgroundJob): void;
  finished(job: LeadBackgroundJob & { text: string; isError: boolean; ms: number }): void;
}

let jobCounter = 0;
export function newBackgroundJobId(): string {
  jobCounter += 1;
  return `job_${Date.now().toString(36)}${jobCounter.toString(36).padStart(3, "0")}`;
}

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean; details?: unknown };

/** 结果的文字（pi 的工具结果是几段文字）。 */
export function toolResultText(result: ToolResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text ?? "" : "")).join("\n");
}

export type JobStopCause = "lead" | "max";

interface RunningJob {
  job: LeadBackgroundJob;
  startedAt: number;
  stop: (cause: JobStopCause) => void;
}

/**
 * 正在跑的后台作业。中止兜底在转后台时登记、作业结束时注销；Lead 的 stop_job 用它停掉一个作业
 * （用户 2026-11-11：插话说「先停下」「做错了」时，Lead 读完插话自己决定停不停）。
 */
export class BackgroundJobRegistry {
  readonly #jobs = new Map<string, RunningJob>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  add(job: LeadBackgroundJob, stop: (cause: JobStopCause) => void): () => void {
    this.#jobs.set(job.id, { job, startedAt: this.#now() - job.softMs, stop });
    return () => { this.#jobs.delete(job.id); };
  }

  list(): Array<LeadBackgroundJob & { runningMs: number }> {
    return [...this.#jobs.values()].map(({ job, startedAt }) => ({ ...job, runningMs: this.#now() - startedAt }));
  }

  /** 停掉一个作业：发中止信号（命令停掉整个进程组），它结束时结果照常交回 Lead。 */
  stop(id: string): LeadBackgroundJob | null {
    const running = this.#jobs.get(id);
    if (!running) return null;
    running.stop("lead");
    return running.job;
  }
}

/**
 * 这一步里正在等、能转后台的工具调用（中止兜底登记）。用户插话时 daemon 调 detachAll：它们马上转后台，
 * 这一步结束，插话送到 Lead，不用等软时限（.scratch/tool-occupancy/eval-2026-11-10.md：以前插话要 15–18 秒才得到回答）。
 * 调用不停，结果照旧作为后台作业交回 Lead。
 */
export class ForegroundWaits {
  readonly #waits = new Set<() => void>();

  /** 登记一个等着的调用；返回注销函数（调用返回时注销）。 */
  add(detach: () => void): () => void {
    this.#waits.add(detach);
    return () => { this.#waits.delete(detach); };
  }

  /** 让所有等着的调用马上转后台，返回有几个。 */
  detachAll(): number {
    const waits = [...this.#waits];
    this.#waits.clear();
    for (const detach of waits) detach();
    return waits.length;
  }
}
