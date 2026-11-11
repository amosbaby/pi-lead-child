// 调度器的运行层：把决策层（core.ts 的纯函数）、控制层（controller.ts）和执行的出口接在一起（lead-scheduler spec D9、D10）。
//
// daemon 建一个实例，pi extension（extension.ts）和 daemon 共用它，不需要进程间通信（D13）。
//   · dispatch(event)：跑一次状态机，再执行它给出的事。通用的事（日志、记录、中止）在这里做；
//     daemon 才做得了的事（插提醒、送交接消息）交给 execute。返回这次给出的全部事，调用方据此决定接下来做什么。
//   · 中止：先把原因写进状态和 controller，再调用执行层的 stop（session.abort()），最多等 abortGraceMs，
//     不等到也照样往下走，并写日志（D10 局限 3）。中止花了多久也写日志（D12 第 5 条）。
//   · 释放（.scratch/tool-occupancy/spec.md L3，用户 2026-11-11）：abort.stuck 以后再等 releaseWaitMs，这一步还没停下，
//     就叫 daemon 释放 Lead（换掉会话，session-slot.ts）。规则是固定的，不问模型。中止已经发出、还没停下时用户再 /stop，
//     daemon 调 releaseNow，马上释放。中止晚到了（释放以前停下了）就取消释放，写 abort.late。
//   · 记录：每个单元的开始和结束、值得记的决定、中止，写进 events 表（record）和会话文件（extension 绑定的 recorder）。
import { abortExecution, abortReasonText, LeadTaskController, type AbortExecutionResult, type LeadAbortReason } from "./controller.js";
import {
  initialSchedulerState, isBusy, schedulerLine, schedulerStep,
  type SchedulerEffect, type SchedulerEvent, type SchedulerRecordKind, type SchedulerState, type UnitOutcome, type UnitState,
  type WaitingEntry,
} from "./core.js";
import type { SchedulerSnapshot } from "@pi-lead-child/protocol";
import { inputLane, laneClockMs, LANES, laneName, type InputKind, type Lane, type UnitSource } from "./lanes.js";

export type { SchedulerSnapshot };

export const DEFAULT_ABORT_GRACE_MS = 5_000;
// abort.stuck 以后再等多久就释放 Lead（用户 2026-11-11：约 10 秒）。daemon 读 PLC_LEAD_RELEASE_WAIT_MS。
export const DEFAULT_RELEASE_WAIT_MS = 10_000;
export const LEAD_RELEASE_WAIT_MS_ENV = "PLC_LEAD_RELEASE_WAIT_MS";

/** daemon 读环境变量里的等待时间；没设或者不是正数时用缺省值。 */
export function releaseWaitMsFromEnv(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env[LEAD_RELEASE_WAIT_MS_ENV]);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_RELEASE_WAIT_MS;
}

/** 释放 Lead 的请求：哪个单元的哪一步、卡在哪个阶段、什么时候中止的。 */
export interface LeadReleaseRequest {
  // auto：abort.stuck 以后等过了 releaseWaitMs；user_stop：中止还没停下时用户又 /stop。
  trigger: "auto" | "user_stop";
  unitId: string | null;
  segment: number | null;
  // 第一次中止的原因（abortReasonText）。
  reason: string;
  // 中止时这一步在哪个阶段（extension 报的，D7）。
  stage: LeadStageInfo | null;
  // 第一次中止的时刻（毫秒）和到现在过了多久。
  abortedAt: number;
  stuckMs: number;
}

/** 一步现在在哪个阶段（extension 报来的，D7）。 */
export interface LeadStageInfo {
  run: number;
  step: number;
  // A 请求前准备；B1 上传和排队；B2 等第一段输出；C 流式输出；tool 在跑工具；idle 一步结束了。
  stage: "A" | "B1" | "B2" | "C" | "tool" | "idle";
  since: number;
  tool?: string;
}

export interface LeadSchedulerRuntimeOptions {
  now?: () => number;
  // daemon 的日志（同步写）。
  log: (line: string) => void;
  // 写进 events 表（scheduler.*）。写不进时由调用方记日志，不影响调度。
  record?: (kind: SchedulerRecordKind, payload: Record<string, string | number | boolean | null>) => void;
  // daemon 才做得了的事。
  execute?: (effect: SchedulerEffect) => void;
  // 让执行层停下（session.abort()）。不给时中止只记原因。
  stopExecution?: () => unknown;
  abortGraceMs?: number;
  // abort.stuck 以后再等多久就释放（缺省 DEFAULT_RELEASE_WAIT_MS）。
  releaseWaitMs?: number;
  // 释放 Lead（daemon 换掉会话）。不给时中止停不下只写 abort.stuck（以前的样子）。
  release?: (request: LeadReleaseRequest) => Promise<unknown>;
  newUnitId?: () => string;
}

// 一次还没停下的中止（同一步里第二次中止，例如红线以后用户 /stop，算同一次）。
interface PendingStop {
  unitId: string | null;
  segment: number | null;
  reason: LeadAbortReason;
  stage: LeadStageInfo | null;
  startedAt: number;
  settled: boolean;
  stuck: boolean;
  released: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

let unitCounter = 0;
function defaultUnitId(): string {
  unitCounter += 1;
  return `unit_${Date.now().toString(36)}${unitCounter.toString(36).padStart(3, "0")}`;
}

export class LeadSchedulerRuntime {
  #state: SchedulerState = initialSchedulerState();
  #controller: LeadTaskController | null = null;
  // 最近一次用户的单元（L0）结束的时刻：L1 的时限从这里算（laneClockMs）。
  #userUnitEndedAt: number | null = null;
  #aborting: Promise<AbortExecutionResult> | null = null;
  #sessionRecorder: ((data: Record<string, unknown>) => void) | null = null;
  #stage: LeadStageInfo | null = null;
  #pendingStop: PendingStop | null = null;
  #releasing: Promise<void> | null = null;
  readonly #options: LeadSchedulerRuntimeOptions;
  readonly #now: () => number;

  constructor(options: LeadSchedulerRuntimeOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  get state(): SchedulerState {
    return this.#state;
  }

  get busy(): boolean {
    return isBusy(this.#state);
  }

  get draining(): boolean {
    return this.#state.draining;
  }

  get starting(): boolean {
    return this.#state.starting;
  }

  get unit(): UnitState | null {
    return this.#state.unit;
  }

  /** 最近一次用户的单元（L0）结束的时刻；还没有过时是 null。 */
  get userUnitEndedAt(): number | null {
    return this.#userUnitEndedAt;
  }

  /** 一个在等的输入按车道的时限算了多久（laneClockMs）：L1 不算用户的单元在跑的时间。 */
  laneClockMs(lane: Lane, waitedMs: number): number {
    const unit = this.#state.unit;
    return laneClockMs({
      lane, waitedMs, now: this.#now(),
      userUnitOpenedAt: unit && unit.lane === 0 ? unit.openedAt : null, userUnitEndedAt: this.#userUnitEndedAt,
    });
  }

  /** 这一段运行的 controller；没有单元时为 null。 */
  get controller(): LeadTaskController | null {
    return this.#controller;
  }

  /** 最近一次中止的执行（drain 据此等它）。 */
  get aborting(): Promise<AbortExecutionResult> | null {
    return this.#aborting;
  }

  /** 已经发出了中止，这一步还没停下（也还没释放）。 */
  get abortPending(): boolean {
    const pending = this.#pendingStop;
    return pending !== null && !pending.settled && !pending.released;
  }

  /** 正在释放 Lead（daemon 在换会话）。 */
  get releasing(): Promise<void> | null {
    return this.#releasing;
  }

  /**
   * 用户又按了 /stop（用户 2026-11-11）：中止已经发出、这一步还没停下时，不再等，马上释放。返回有没有开始释放。
   * 没有在等的中止、正在释放、正在排空（停机）、daemon 没给 release 时返回 false。
   */
  releaseNow(trigger: LeadReleaseRequest["trigger"] = "user_stop"): boolean {
    const pending = this.#pendingStop;
    if (!pending || pending.settled || pending.released || this.#releasing || this.#state.draining || !this.#options.release) return false;
    this.#release(pending, trigger);
    return true;
  }

  /** extension 绑定会话文件的写入口（pi 的 appendEntry，同步写）。重新加载扩展时新的一份替换旧的。 */
  bindSessionRecorder(recorder: (data: Record<string, unknown>) => void): void {
    this.#sessionRecorder = recorder;
  }

  /** 会话关了：解开它绑定的写入口（已经被新的一份替换时不动）。 */
  unbindSessionRecorder(recorder: (data: Record<string, unknown>) => void): void {
    if (this.#sessionRecorder === recorder) this.#sessionRecorder = null;
  }

  /** extension 发现一步在某个阶段等过了阈值（D7）：写进 events 表。日志和会话文件由 extension 自己写。 */
  noteStageSlow(payload: Record<string, string | number | boolean | null> & { unitId: string }): void {
    try {
      this.#options.record?.("stage_slow", payload);
    } catch (error) {
      this.#options.log(schedulerLine("record.failed", { kind: "stage_slow", error: error instanceof Error ? error.message : String(error) }));
    }
  }

  /**
   * 一个输入进来了（D12 第 1 条）：来源、车道、车道是怎么定的、放在哪里（用户的消息：新开、插话、排队……）。
   * 带上正在跑的单元编号：它出现在那个单元的时间线里，能看出它是在哪个单元跑的时候到的。只写编号和种类，不写原文。
   */
  noteInput(input: {
    kind: InputKind; turnId?: string | null; seq?: number | null; level?: string | null; placement?: string | null;
  }): Lane {
    const { lane, how } = inputLane(input);
    this.#options.log(schedulerLine("input", {
      unit: this.#state.unit?.id ?? "-", kind: input.kind, lane: laneName(lane), how,
      ...(input.turnId !== undefined ? { turn: input.turnId ?? "-" } : {}),
      ...(input.seq !== undefined && input.seq !== null ? { seq: input.seq } : {}),
      ...(input.level ? { level: input.level } : {}),
      ...(input.placement ? { placement: input.placement } : {}),
      running: this.#state.unit ? laneName(this.#state.unit.lane) : "-",
    }));
    return lane;
  }

  /**
   * 打断式插话停下了这一步的模型请求（step-interrupt.ts，D4 的「插话」）。它不经过控制层：只中止这一次模型请求，
   * 单元照常往下走。记一条决定，带单元编号和插话的那一轮，时间线里看得到它。
   */
  noteSteerInterrupt(turnId: string): void {
    const unit = this.#state.unit;
    this.#options.log(schedulerLine("decide", {
      unit: unit?.id ?? "-", lane: unit ? laneName(unit.lane) : "-", turn: turnId, decision: "steer_interrupt",
      stage: this.#stage?.stage ?? "-", step: this.#stage?.step ?? null,
    }));
    if (unit) this.#record("decided", { unitId: unit.id, turnId, lane: laneName(unit.lane), decision: "steer_interrupt" });
  }

  /** extension 报告一步现在在哪个阶段。 */
  noteStage(stage: LeadStageInfo | null): void {
    this.#stage = stage;
  }

  get stage(): LeadStageInfo | null {
    return this.#stage;
  }

  dispatch(event: SchedulerEvent): SchedulerEffect[] {
    const before = this.#state;
    const step = schedulerStep(before, event, this.#now());
    this.#state = step.state;
    const unit = step.state.unit;
    if (this.#controller && unit && this.#controller.unitId === unit.id && this.#controller.lane !== unit.lane) {
      this.#controller.setLane(unit.lane);
    }
    for (const effect of step.effects) this.#run(effect);
    return step.effects;
  }

  /** 开一个单元：编号、controller、状态机的 unit.open。返回单元编号。 */
  openUnit(input: { source: UnitSource; lane: Lane; origin: string | null; turnId: string | null }): string {
    const id = (this.#options.newUnitId ?? defaultUnitId)();
    this.#controller = this.#newController(id, 1, input.lane);
    this.dispatch({ type: "unit.open", id, ...input });
    return id;
  }

  /** 单元的下一段运行（红线以后的交接）：新的 controller，同一个单元编号。 */
  nextSegment(): LeadTaskController | null {
    const unit = this.#state.unit;
    if (!unit) return null;
    this.#controller = this.#newController(unit.id, unit.segment, unit.lane);
    return this.#controller;
  }

  closeUnit(outcome: UnitOutcome): void {
    if (this.#state.unit?.lane === 0) this.#userUnitEndedAt = this.#now();
    // 单元结束了：还在等的释放不再做（它是这个单元的）。
    const pending = this.#pendingStop;
    if (pending?.timer) clearTimeout(pending.timer);
    this.#pendingStop = null;
    this.dispatch({ type: "unit.close", outcome });
    this.#controller = null;
    this.#stage = null;
  }

  /** 现在的样子（GET /v1/lead/scheduler）。waiting 是在等的人（带车道），host 是宿主的负载。 */
  snapshot(facts: { waiting?: readonly WaitingEntry[]; host?: string | null; budgetMs: number }): SchedulerSnapshot {
    const now = this.#now();
    const unit = this.#state.unit;
    const stage = this.#stage;
    const lanes = ([0, 1, 2, 3, 4] as Lane[]).map((lane) => {
      const deadline = LANES[lane].firstResponseMs;
      return {
        lane: laneName(lane), deadlineMs: deadline,
        waiting: (facts.waiting ?? []).filter((entry) => entry.lane === lane).map((entry) => {
          const countedMs = this.laneClockMs(lane, entry.waitedMs);
          return {
            who: entry.who, conversation: entry.conversation, count: entry.count, waitedMs: entry.waitedMs,
            countedMs, overdue: deadline !== null && countedMs > deadline,
          };
        }),
      };
    });
    return {
      at: new Date(now).toISOString(),
      draining: this.#state.draining,
      starting: this.#state.starting,
      unit: unit ? {
        id: unit.id, lane: laneName(unit.lane), source: unit.source, origin: unit.origin, turnId: unit.turnId,
        openedAt: new Date(unit.openedAt).toISOString(), elapsedMs: now - unit.openedAt,
        deadlineMs: LANES[unit.lane].firstResponseMs,
        budget: {
          usedMs: unit.budgetStartedAt === null ? null : now - unit.budgetStartedAt, budgetMs: facts.budgetMs,
          toolCalls: unit.toolCalls, yellowReminded: unit.yellowReminded, secondReminded: unit.secondReminded,
        },
        toolCalls: unit.totalToolCalls, steps: unit.steps, segment: unit.segment, redLine: unit.redLine?.phase ?? null,
        aborts: unit.aborts.map(abortReasonText),
        tools: Object.values(unit.tools).map((tool) => ({ name: tool.name, write: tool.write })),
        stage: stage ? { stage: stage.stage, step: stage.step, sinceMs: now - stage.since, ...(stage.tool ? { tool: stage.tool } : {}) } : null,
      } : null,
      lanes,
      host: facts.host ?? null,
    };
  }

  #newController(unitId: string, segment: number, lane: Lane): LeadTaskController {
    const deadlineMs = LANES[lane].firstResponseMs;
    const controller = new LeadTaskController({
      unitId, segment, lane, deadline: deadlineMs === null ? null : this.#now() + deadlineMs,
    });
    controller.signal.addEventListener("abort", () => {
      this.#stopExecution(controller, controller.abortReason ?? { kind: "user_stop" });
    }, { once: true });
    return controller;
  }

  #run(effect: SchedulerEffect): void {
    switch (effect.type) {
      case "log":
        this.#options.log(effect.line);
        return;
      case "record":
        this.#record(effect.kind, effect.payload);
        return;
      case "abort":
        this.#abort(effect.reason);
        return;
      default:
        this.#options.execute?.(effect);
    }
  }

  #record(kind: SchedulerRecordKind, payload: Record<string, string | number | boolean | null>): void {
    try {
      this.#options.record?.(kind, payload);
    } catch (error) {
      this.#options.log(schedulerLine("record.failed", { kind, error: error instanceof Error ? error.message : String(error) }));
    }
    try {
      this.#sessionRecorder?.({ kind, ...payload, at: new Date(this.#now()).toISOString() });
    } catch { /* 会话已经关了 */ }
  }

  // 先把原因写进 controller（状态机里已经记了），监听者再让执行层停下。这一段已经中止过时（例如红线中断以后用户又 /stop），
  // 直接再叫一次执行层：和以前一样，pi 的 abort 可以叫多次。
  #abort(reason: LeadAbortReason): void {
    const controller = this.#controller;
    if (controller && !controller.signal.aborted) {
      controller.abort(reason);
      return;
    }
    this.#stopExecution(controller, reason);
  }

  #stopExecution(controller: LeadTaskController | null, reason: LeadAbortReason): void {
    const stop = this.#options.stopExecution;
    if (!stop) return;
    const graceMs = this.#options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
    const where = controller ? { unit: controller.unitId, seg: controller.segment } : { unit: "-" };
    const running = this.#stage;
    // 同一步里还没停下的中止（例如红线中止以后用户又 /stop）：算同一次，从第一次中止算起。
    const earlier = this.#pendingStop;
    const pending: PendingStop = earlier && !earlier.settled && !earlier.released ? earlier : {
      unitId: controller?.unitId ?? this.#state.unit?.id ?? null, segment: controller?.segment ?? null, reason, stage: running,
      startedAt: this.#now(), settled: false, stuck: false, released: false, timer: null,
    };
    this.#pendingStop = pending;
    this.#aborting = abortExecution(stop, { graceMs, now: this.#now, onSettled: () => this.#stopSettled(pending) }).then((result) => {
      const fields = {
        ...where, reason: abortReasonText(reason), settled: result.settled, ms: result.ms,
        ...(running ? { stage: running.stage, step: running.step } : {}),
        ...(result.error ? { error: result.error } : {}),
      };
      // 宽限到点时已经释放过了（用户第二次 /stop）：release.* 已经记了这一步，旧会话也换掉了，不再写 abort.stuck。
      if (!result.settled && pending.released) return result;
      // 过了宽限时间还没停下：中止本身挂住了（有东西不听 signal）。照样往下走，留一条日志，再等 releaseWaitMs 就释放。
      this.#options.log(schedulerLine(result.settled ? "abort.done" : "abort.stuck", { ...fields, graceMs }));
      if (!result.settled && !pending.settled) this.#stuck(pending);
      return result;
    });
  }

  // abort.stuck：再等 releaseWaitMs，这一步还没停下就释放。停机前的排空不释放（排空有自己的时限，到了 daemon 就退出）。
  #stuck(pending: PendingStop): void {
    pending.stuck = true;
    if (!this.#options.release || pending.timer || pending.released || this.#state.draining) return;
    const waitMs = this.#options.releaseWaitMs ?? DEFAULT_RELEASE_WAIT_MS;
    pending.timer = setTimeout(() => {
      pending.timer = null;
      if (pending.settled || pending.released || this.#pendingStop !== pending || this.#state.draining) return;
      this.#release(pending, "auto");
    }, waitMs);
    pending.timer.unref?.();
  }

  #stopSettled(pending: PendingStop): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    // 宽限过了以后才停下：不用释放了。已经释放过的，旧会话这时才停下，只记一笔。
    if (pending.stuck || pending.released) {
      this.#options.log(schedulerLine("abort.late", {
        unit: pending.unitId ?? "-", reason: abortReasonText(pending.reason), ms: this.#now() - pending.startedAt, released: pending.released,
      }));
    }
    if (this.#pendingStop === pending) this.#pendingStop = null;
  }

  #release(pending: PendingStop, trigger: LeadReleaseRequest["trigger"]): void {
    const release = this.#options.release;
    if (!release || this.#releasing) return;
    pending.released = true;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    const request: LeadReleaseRequest = {
      trigger, unitId: pending.unitId, segment: pending.segment, reason: abortReasonText(pending.reason), stage: pending.stage,
      abortedAt: pending.startedAt, stuckMs: this.#now() - pending.startedAt,
    };
    const fields = {
      unit: request.unitId ?? "-", trigger, reason: request.reason, stuckMs: request.stuckMs,
      stage: request.stage?.stage ?? "-", ...(request.stage?.tool ? { tool: request.stage.tool } : {}),
    };
    this.#options.log(schedulerLine("release.start", fields));
    if (request.unitId) {
      this.#record("decided", {
        unitId: request.unitId, decision: "release", trigger, reason: request.reason, stage: request.stage?.stage ?? null,
        tool: request.stage?.tool ?? null, stuckMs: request.stuckMs,
      });
    }
    const started = this.#now();
    let running: Promise<unknown>;
    try {
      running = Promise.resolve(release(request));
    } catch (error) {
      running = Promise.reject(error);
    }
    this.#releasing = running.then(
      () => { this.#options.log(schedulerLine("release.done", { unit: request.unitId ?? "-", trigger, ms: this.#now() - started })); },
      (error: unknown) => {
        this.#options.log(schedulerLine("release.failed", {
          unit: request.unitId ?? "-", trigger, ms: this.#now() - started, error: error instanceof Error ? error.message : String(error),
        }));
      },
    ).finally(() => {
      this.#releasing = null;
      if (this.#pendingStop === pending) this.#pendingStop = null;
    });
  }
}
