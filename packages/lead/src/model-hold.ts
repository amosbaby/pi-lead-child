// 模型暂停（model hold，2026-11-15）：Lead 的模型账号出了账号级的问题（认证失败、没有权限、账号被停用、欠费、额度用完；
// protocol 的 isLeadAccountFailure），系统暂停所有自动的模型调用。provider 停用了账号以后，daemon 还在按退避一次次自动调用，
// 用户担心这看起来像滥用，账号会被封。
//
// 进入：Lead 的一轮、上下文压缩（pi 的就地压缩、daemon 的补压缩、空闲车道的摘要）或者决策模型的 LLM 后端，任何一次以账号级的
// 失败结束。别的失败（限流、连不上、断网、路被拦）照旧走各自的退避，不进暂停。
// 暂停期间（daemon 和 smart-model.ts 读 held）：
//   · 不为事件、提醒、摘要、跟进、通知、挂起的单元自动开一轮。事件留在事件日志里，游标不动，什么都不丢、不记成处理过；
//   · 不重试带着事的那一轮（没有退避的定时器）；
//   · 空闲车道不开要调模型的活（整理笔记、写摘要）；
//   · 决策模型的 LLM 后端（走 Lead 的 provider）不调模型，调用方拿到 MODEL_HOLD_ERROR，按没有 LLM 后端处理。
// 用户本人的消息照常开一轮（一条消息一次请求）。那一轮答上了就解除，排着的事接着交给 Lead；还是账号级的失败就继续暂停。
// 没有定时探测：暂停期间没有任何定时器去调模型。
//
// 暂停跨重启保留（2026-11-16，snapshot / restore，daemon 存在库里）。以前只在内存里：每次重启，熔断要再失败 3 次才打开，
// 账号级的暂停也要再失败一次。2026-11-15 daemon 崩溃重启了约 400 次，那样就是上千次注定失败的调用。
// 当时不存的理由是「用户在别处修好了账号、daemon 重启，暂停还在，没人知道为什么事件不处理」。现在进入暂停时系统告诉用户一次，
// 顶栏的健康状态也写着；用户发一条消息，答上了就解除。恢复出来的熔断到点照样放一次调用去试。
//
// 熔断和预算（2026-11-16）。只拦账号级的失败不够：模型代理关了两天，daemon 自动调了 7,028 次，其中 5,527 次是空闲车道的活，
// 1,466 次是事件叫醒的一轮，用户本人的只有 13 次。同一个暂停再管两种情况，拦的地方和上面一样：
//   · 熔断（breaker）：连续 3 次失败（一轮、一次压缩或者一次决策调用算一次；本机断网不算，那由网络探测管）以后暂停。
//     等 5 分钟，放一次自动调用去试；它失败了就再暂停，等待加倍，最长 4 小时；它答上了就解除，重新数。
//     上一次失败是连不上模型服务时，等待里每分钟免费看一眼连不连得上（reachable，daemon 给的是一次 TCP 连接，不调模型）：
//     看到它从连不上变成连得上，马上放一次调用，不等到点（用户不在时 Lead 也要尽快接着做事）；一直连不上就一直不放。
//     模型代理关着的两天里，一次模型调用都不发；代理一开，一分钟里就接着做。
//   · 预算（budget）：自动调用超过预算（auto-call-budget.ts）时暂停到这个时间窗结束，或者用户说继续（resume）。
//     模型答上了不解除它：模型是好的，是系统自己调得太多。
// 账号级的暂停最强：它不按时间解除，也不被另外两种盖掉。还有别的模型可以换时（failed 的 alternative，model-failover.ts 换了模型）
// 不进账号级的暂停：出问题的模型由 model-failover 停用，系统换到备用的模型接着做事。所有模型都不行了才整体暂停。
import { classifyLeadModelError, isLeadAccountFailure, redactSecretText } from "@pi-lead-child/protocol";
import { schedulerLine } from "./scheduler/core.js";

/** 暂停期间决策模型的 LLM 后端给调用方的错误。 */
export const MODEL_HOLD_ERROR = "model hold: the Lead model account failed; automatic model calls wait for the user's next message";

/**
 * The same error for the kind of hold that is on. On 2026-11-16 a budget pause was reported as an account failure.
 */
export function modelHoldError(state: Pick<ModelHoldState, "kind" | "retryAt"> | null | undefined): string {
  if (!state || state.kind === "account") return MODEL_HOLD_ERROR;
  const until = state.retryAt === null ? "later" : new Date(state.retryAt).toISOString();
  return state.kind === "budget"
    ? `model hold: the budget for automatic model calls is used up; automatic model calls wait until ${until}`
    : `model hold: model calls keep failing; the next automatic model call is at ${until}`;
}

/**
 * 这段错误文字是不是模型暂停拒了调用（MODEL_HOLD_ERROR、modelHoldError）：调用没有发出去。
 * 调用记录（decision_model.called）不记它，用量统计只数真的调用（2026-11-20）。
 */
export function isModelHoldRefusal(text: string | null | undefined): boolean {
  return typeof text === "string" && text.startsWith("model hold:");
}

/** 谁的失败让系统进入暂停。 */
export type ModelHoldSource = "turn" | "compaction" | "decision";

/** 为什么暂停：账号级的失败、连续失败（熔断）、自动调用超过预算。 */
export type ModelHoldKind = "account" | "breaker" | "budget";

export interface ModelHoldState {
  kind: ModelHoldKind;
  since: number;
  source: ModelHoldSource;
  /** 失败原文（遮住密钥、截短），或者预算暂停的说明。只写进日志和健康状态的技术详情。 */
  error: string;
  /** 熔断、预算：到这个时间放一次自动调用（熔断）或者解除（预算）。账号级的没有。 */
  retryAt: number | null;
}

/** smart-model.ts 用的那一面：能不能调、调完的结果。 */
export interface ModelHoldPort {
  readonly held: boolean;
  /** 现在的暂停（给错误文字用：账号级、熔断还是预算）。没有暂停时是 null。 */
  readonly state?: Pick<ModelHoldState, "kind" | "retryAt"> | null;
  /**
   * 一次模型调用失败。返回调用以后是不是在暂停。
   * alternative：这次失败以后系统换到了另一个模型（model-failover.ts）。账号级的失败这时不进暂停，只算一次连续失败。
   */
  failed(source: ModelHoldSource, error: string, options?: { alternative?: boolean }): boolean;
}

export interface ModelHoldOptions {
  log: (line: string) => void;
  /** 进入或解除时调用（daemon 据此重发健康状态、叫空闲车道停或接着做、放排着的事）。 */
  onChange?: (held: boolean) => void;
  now?: () => number;
  /** 排一个定时器，返回取消它的函数。缺省是不拦着进程退出的 setTimeout。 */
  setTimer?: (run: () => void, ms: number) => () => void;
  /** 免费看一眼模型服务连不连得上（不调模型）。不给时，熔断到点就直接放一次调用。 */
  reachable?: () => Promise<boolean>;
  /** 熔断的参数。缺省：连续 3 次失败，等 5 分钟起，最长 4 小时。 */
  breaker?: Partial<ModelBreakerLimits>;
  /** 暂停或者连续失败的次数变了：daemon 把快照存进库，重启以后交给 restore。 */
  onPersist?: (snapshot: ModelHoldSnapshot) => void;
}

/** 跨重启保留的那一部分（restore 读它）。at 是存的时间。 */
export interface ModelHoldSnapshot {
  version: 1;
  at: number;
  state: ModelHoldState | null;
  failures: number;
  reopens: number;
  lastError: string;
}

const HOLD_KINDS: readonly ModelHoldKind[] = ["account", "breaker", "budget"];
const HOLD_SOURCES: readonly ModelHoldSource[] = ["turn", "compaction", "decision"];

// 读到的快照是不是这个形状。不是时当作没有（旧版本、手改、截断）。
function parseSnapshot(raw: unknown): ModelHoldSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const count = (key: string) => (typeof value[key] === "number" && Number.isSafeInteger(value[key]) && (value[key] as number) >= 0 ? value[key] as number : null);
  const failures = count("failures");
  const reopens = count("reopens");
  if (value.version !== 1 || typeof value.at !== "number" || failures === null || reopens === null) return null;
  let state: ModelHoldState | null = null;
  if (value.state !== null && value.state !== undefined) {
    const s = value.state as Record<string, unknown>;
    if (typeof s !== "object" || !HOLD_KINDS.includes(s.kind as ModelHoldKind) || !HOLD_SOURCES.includes(s.source as ModelHoldSource)) return null;
    if (typeof s.since !== "number" || typeof s.error !== "string" || !(s.retryAt === null || typeof s.retryAt === "number")) return null;
    // 熔断和预算一定有时间；账号级的没有。
    if ((s.kind === "account") !== (s.retryAt === null)) return null;
    state = { kind: s.kind as ModelHoldKind, since: s.since, source: s.source as ModelHoldSource, error: s.error, retryAt: s.retryAt as number | null };
  }
  return { version: 1, at: value.at, state, failures, reopens, lastError: typeof value.lastError === "string" ? value.lastError : "" };
}

export interface ModelBreakerLimits {
  threshold: number;
  firstWaitMs: number;
  maxWaitMs: number;
}

export const DEFAULT_MODEL_BREAKER: ModelBreakerLimits = { threshold: 3, firstWaitMs: 5 * 60_000, maxWaitMs: 4 * 60 * 60_000 };
// 等待里隔多久免费看一眼模型服务连不连得上。
const REACHABLE_CHECK_MS = 60_000;

/** 熔断的参数可以用环境变量改（测试把时间缩短）：PLC_MODEL_BREAKER_FAILURES、PLC_MODEL_BREAKER_WAIT_MS、PLC_MODEL_BREAKER_MAX_WAIT_MS。 */
export function modelBreakerLimitsFromEnv(env: Record<string, string | undefined> = process.env): ModelBreakerLimits {
  const positive = (raw: string | undefined, fallback: number) => {
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  };
  return {
    threshold: positive(env.PLC_MODEL_BREAKER_FAILURES, DEFAULT_MODEL_BREAKER.threshold),
    firstWaitMs: positive(env.PLC_MODEL_BREAKER_WAIT_MS, DEFAULT_MODEL_BREAKER.firstWaitMs),
    maxWaitMs: positive(env.PLC_MODEL_BREAKER_MAX_WAIT_MS, DEFAULT_MODEL_BREAKER.maxWaitMs),
  };
}

const MAX_ERROR_CHARS = 200;
// 上一次失败是没连上模型服务（连接被拒、超时、连接断开）。连本机的模型代理被拒也算。
const UNREACHABLE = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|timed? ?out|connection error/i;

function defaultTimer(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export class ModelHold implements ModelHoldPort {
  #state: ModelHoldState | null = null;
  // 熔断放出去的那一次调用还没有结果（半开）：不拦，它失败了再停。
  #probing = false;
  // 连续失败的次数（答上一次就清零），和熔断已经重新停过几次（决定等多久）。
  #failures = 0;
  #reopens = 0;
  #lastError = "";
  // 这一次停下以后，免费的那一眼看到过连不上：之后一看到连得上就放调用。
  #sawDown = false;
  #cancelTimer: (() => void) | null = null;
  readonly #log: (line: string) => void;
  readonly #onChange: ((held: boolean) => void) | undefined;
  readonly #now: () => number;
  readonly #setTimer: (run: () => void, ms: number) => () => void;
  readonly #reachable: (() => Promise<boolean>) | undefined;
  readonly #limits: ModelBreakerLimits;
  readonly #onPersist: ((snapshot: ModelHoldSnapshot) => void) | undefined;

  constructor(options: ModelHoldOptions) {
    this.#log = options.log;
    this.#onChange = options.onChange;
    this.#now = options.now ?? Date.now;
    this.#setTimer = options.setTimer ?? defaultTimer;
    this.#reachable = options.reachable;
    this.#limits = { ...DEFAULT_MODEL_BREAKER, ...options.breaker };
    this.#onPersist = options.onPersist;
  }

  /** 现在的暂停和连续失败的次数，给 daemon 存进库。 */
  snapshot(): ModelHoldSnapshot {
    return {
      version: 1, at: this.#now(), state: this.#state ? { ...this.#state } : null,
      failures: this.#failures, reopens: this.#reopens, lastError: this.#brief(this.#lastError),
    };
  }

  /**
   * daemon 启动时接着上一个进程的暂停（raw 是上一个进程存的 snapshot）。返回恢复以后是不是在暂停。
   *   · 账号级的：照旧暂停到用户的下一条消息答上。
   *   · 熔断：时间不变。还没到点就接着等；已经到点就放一次调用去试（能免费看一眼时先看）。重新停过几次也接着算，
   *     所以放出去的那一次失败了，等待照样加倍。
   *   · 预算：时间窗还没结束就接着暂停；结束了就不恢复。
   *   · 没有暂停时只恢复连续失败的次数；它比熔断最长的等待还旧时不算（那几次失败和现在没有关系了）。
   * 只在启动时调一次，在任何模型调用以前。读到的不是快照时什么都不做。
   */
  restore(raw: unknown): boolean {
    const saved = parseSnapshot(raw);
    if (!saved) return false;
    const now = this.#now();
    const state = saved.state;
    if (!state) {
      if (now - saved.at <= this.#limits.maxWaitMs) {
        this.#failures = saved.failures;
        this.#lastError = saved.lastError;
      }
      return false;
    }
    if (state.kind === "budget" && (state.retryAt ?? 0) <= now) return false;
    this.#clearTimer();
    this.#failures = saved.failures;
    this.#reopens = saved.reopens;
    this.#lastError = saved.lastError;
    this.#probing = false;
    this.#sawDown = false;
    this.#state = { ...state };
    this.#log(schedulerLine("model.hold", {
      action: "restored", kind: state.kind, failures: this.#failures,
      ...(state.retryAt === null ? {} : { retry_in_s: Math.max(0, Math.round((state.retryAt - now) / 1000)) }), error: state.error,
    }));
    if (state.kind === "breaker") this.#schedule();
    if (state.kind === "budget") this.#cancelTimer = this.#setTimer(() => this.resume("window_end"), Math.max(0, state.retryAt! - now));
    this.#notify(true);
    return true;
  }

  #persist(): void {
    if (!this.#onPersist) return;
    try {
      this.#onPersist(this.snapshot());
    } catch (error) {
      this.#log(`model hold: saving the state failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  get held(): boolean {
    return this.#state !== null && !this.#probing;
  }

  get state(): ModelHoldState | null {
    return this.#state;
  }

  /** 连续失败了几次（答上一次就清零）。daemon 据此不让 pi 在已经失败过的时候一轮里再试。 */
  get failures(): number {
    return this.#failures;
  }

  /** 系统下一次自己调模型的时间（熔断放调用、预算的时间窗结束）。没有暂停、或者是账号级的暂停时为 null。 */
  nextAttemptAt(): number | null {
    return this.held ? this.#state!.retryAt : null;
  }

  failed(source: ModelHoldSource, error: string, options: { alternative?: boolean } = {}): boolean {
    const held = this.#failed(source, error, options);
    this.#persist();
    return held;
  }

  #failed(source: ModelHoldSource, error: string, options: { alternative?: boolean }): boolean {
    const text = this.#brief(error);
    if (isLeadAccountFailure(error) && !options.alternative) {
      if (this.#state?.kind === "account") return true;
      this.#clearTimer();
      this.#probing = false;
      this.#state = { kind: "account", since: this.#now(), source, error: text, retryAt: null };
      this.#log(schedulerLine("model.hold", {
        action: "entered", source, kind: classifyLeadModelError(error), error: text,
        until: "the user's next message succeeds",
      }));
      this.#notify(true);
      return true;
    }
    if (this.#state?.kind === "account") return true;
    // 本机断网：网络探测管着（daemon 的 network.ts），不算模型服务的失败。
    if (classifyLeadModelError(error) === "network") return this.held;
    this.#failures += 1;
    this.#lastError = error;
    if (this.#state?.kind === "budget") return true;
    if (this.#state?.kind === "breaker") {
      // 放出去的那一次失败了：重新停下，等待加倍。已经停着时（用户自己的一轮也失败了）不改时间。
      if (this.#probing) {
        this.#reopens += 1;
        this.#open(source, error, text, "reopened");
      }
      return this.held;
    }
    if (this.#failures >= this.#limits.threshold) this.#open(source, error, text, "opened");
    return this.held;
  }

  /** 一次模型调用答上了：连续失败重新数；账号级的暂停和熔断解除。预算的暂停不解除（模型是好的，是调得太多）。 */
  lift(by: string): void {
    const changed = this.#failures !== 0 || this.#reopens !== 0 || (this.#state !== null && this.#state.kind !== "budget");
    this.#lift(by);
    // 每一次成功的调用都会到这里：只有真的变了才写库。
    if (changed) this.#persist();
  }

  #lift(by: string): void {
    this.#failures = 0;
    this.#reopens = 0;
    const state = this.#state;
    if (!state || state.kind === "budget") return;
    this.#clearTimer();
    const wasHeld = this.held;
    this.#state = null;
    this.#probing = false;
    this.#log(schedulerLine("model.hold", { action: "lifted", by, source: state.source, heldMs: this.#now() - state.since }));
    if (wasHeld) this.#notify(false);
  }

  /** 自动调用超过预算：暂停到 until。账号级的暂停更强，不被它盖掉。 */
  pause(until: number, detail: string): void {
    if (this.#state?.kind === "account" || this.#state?.kind === "budget") return;
    this.#clearTimer();
    const wasHeld = this.held;
    this.#probing = false;
    this.#state = { kind: "budget", since: this.#now(), source: "turn", error: detail, retryAt: until };
    this.#log(schedulerLine("model.hold", {
      action: "paused", kind: "budget", detail, resume_in_s: Math.max(0, Math.round((until - this.#now()) / 1000)),
    }));
    this.#cancelTimer = this.#setTimer(() => this.resume("window_end"), Math.max(0, until - this.#now()));
    this.#persist();
    if (!wasHeld) this.#notify(true);
  }

  /** 预算的暂停结束：时间窗到了，或者用户说继续。不在预算的暂停里时什么都不做。 */
  resume(by: string): void {
    const state = this.#state;
    if (state?.kind !== "budget") return;
    this.#clearTimer();
    this.#state = null;
    this.#log(schedulerLine("model.hold", { action: "resumed", kind: "budget", by, heldMs: this.#now() - state.since }));
    this.#persist();
    this.#notify(false);
  }

  #open(source: ModelHoldSource, error: string, text: string, action: "opened" | "reopened"): void {
    this.#clearTimer();
    const wasHeld = this.held;
    const wait = Math.min(this.#limits.maxWaitMs, this.#limits.firstWaitMs * 2 ** this.#reopens);
    const now = this.#now();
    this.#probing = false;
    this.#sawDown = false;
    this.#state = { kind: "breaker", since: this.#state?.kind === "breaker" ? this.#state.since : now, source, error: text, retryAt: now + wait };
    this.#log(schedulerLine("model.hold", {
      action, failures: this.#failures, kind: classifyLeadModelError(error), retry_in_s: Math.round(wait / 1000), error: text,
    }));
    this.#schedule();
    if (!wasHeld) this.#notify(true);
  }

  // 熔断里的下一个定时器：上一次失败是连不上、又有免费的那一眼时，每分钟看一次；不然等到点。
  #schedule(): void {
    const state = this.#state;
    if (state?.kind !== "breaker" || state.retryAt === null) return;
    const left = Math.max(0, state.retryAt - this.#now());
    const checks = this.#reachable !== undefined && UNREACHABLE.test(this.#lastError);
    this.#cancelTimer = this.#setTimer(() => { void this.#tick(); }, checks ? Math.min(left, REACHABLE_CHECK_MS) : left);
  }

  // 定时器到了。能免费看一眼时：连不上就接着等（一直不放调用）；从连不上变成连得上，马上放一次调用；
  // 一直连得上（失败不是因为连不上了）就等到点再放。不能看时：到点放一次调用。
  async #tick(): Promise<void> {
    this.#cancelTimer = null;
    const state = this.#state;
    if (state?.kind !== "breaker" || this.#probing || state.retryAt === null) return;
    const due = this.#now() >= state.retryAt;
    if (this.#reachable && UNREACHABLE.test(this.#lastError)) {
      let up = false;
      try {
        up = await this.#reachable();
      } catch {
        up = false;
      }
      // 等这一眼的时候暂停变了（用户的一轮答上了、换成了账号级的暂停）：不管了。
      if (this.#state !== state) return;
      if (!up) {
        if (!this.#sawDown) this.#log(schedulerLine("model.hold", { action: "unreachable", check_every_s: REACHABLE_CHECK_MS / 1000 }));
        this.#sawDown = true;
        // 到点了还连不上：不放调用，时间往后挪，接着每分钟看。
        if (due) state.retryAt = this.#now() + REACHABLE_CHECK_MS;
        this.#schedule();
        return;
      }
      if (!this.#sawDown && !due) {
        this.#schedule();
        return;
      }
    } else if (!due) {
      this.#schedule();
      return;
    }
    this.#probing = true;
    this.#log(schedulerLine("model.hold", {
      action: "probing", failures: this.#failures, heldMs: this.#now() - state.since, ...(this.#sawDown ? { why: "reachable_again" } : {}),
    }));
    this.#notify(false);
  }

  #brief(error: string): string {
    const clean = redactSecretText(error).replace(/\s+/g, " ").trim();
    return clean.length > MAX_ERROR_CHARS ? `${clean.slice(0, MAX_ERROR_CHARS)}…` : clean;
  }

  #clearTimer(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
  }

  #notify(held: boolean): void {
    try {
      this.#onChange?.(held);
    } catch (error) {
      this.#log(`model hold: onChange failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
