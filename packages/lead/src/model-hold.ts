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
// 暂停只在 daemon 的内存里，重启以后是清的：重启后第一次自动调用碰到同样的错误就重新进入，每次重启最多多一次调用。
// 不存进 kv：存下来就要处理「用户在别处修好了账号、daemon 重启」这一种（一直暂停到用户说话，没人知道为什么事件不处理），
// 而内存里的暂停在重启时自然解开，代价只是那一次调用。
import { classifyLeadModelError, isLeadAccountFailure, redactSecretText } from "@pi-lead-child/protocol";
import { schedulerLine } from "./scheduler/core.js";

/** 暂停期间决策模型的 LLM 后端给调用方的错误。 */
export const MODEL_HOLD_ERROR = "model hold: the Lead model account failed; automatic model calls wait for the user's next message";

/** 谁的失败让系统进入暂停。 */
export type ModelHoldSource = "turn" | "compaction" | "decision";

export interface ModelHoldState {
  since: number;
  source: ModelHoldSource;
  /** 失败原文（遮住密钥、截短），只写进日志。 */
  error: string;
}

/** smart-model.ts 用的那一面：能不能调、调完的结果。 */
export interface ModelHoldPort {
  readonly held: boolean;
  /** 一次模型调用失败。账号级的失败进入暂停；返回调用以后是不是在暂停。 */
  failed(source: ModelHoldSource, error: string): boolean;
}

export interface ModelHoldOptions {
  log: (line: string) => void;
  /** 进入或解除时调用（daemon 据此重发健康状态、叫空闲车道停或接着做、放排着的事）。 */
  onChange?: (held: boolean) => void;
  now?: () => number;
}

const MAX_ERROR_CHARS = 200;

export class ModelHold implements ModelHoldPort {
  #state: ModelHoldState | null = null;
  readonly #log: (line: string) => void;
  readonly #onChange: ((held: boolean) => void) | undefined;
  readonly #now: () => number;

  constructor(options: ModelHoldOptions) {
    this.#log = options.log;
    this.#onChange = options.onChange;
    this.#now = options.now ?? Date.now;
  }

  get held(): boolean {
    return this.#state !== null;
  }

  get state(): ModelHoldState | null {
    return this.#state;
  }

  failed(source: ModelHoldSource, error: string): boolean {
    if (this.#state || !isLeadAccountFailure(error)) return this.held;
    const clean = redactSecretText(error).replace(/\s+/g, " ").trim();
    const text = clean.length > MAX_ERROR_CHARS ? `${clean.slice(0, MAX_ERROR_CHARS)}…` : clean;
    this.#state = { since: this.#now(), source, error: text };
    this.#log(schedulerLine("model.hold", {
      action: "entered", source, kind: classifyLeadModelError(error), error: text,
      until: "the user's next message succeeds",
    }));
    this.#notify(true);
    return true;
  }

  /** 用户本人的一轮答上了：解除暂停。不在暂停时什么都不做。 */
  lift(by: string): void {
    const state = this.#state;
    if (!state) return;
    this.#state = null;
    this.#log(schedulerLine("model.hold", { action: "lifted", by, source: state.source, heldMs: this.#now() - state.since }));
    this.#notify(false);
  }

  #notify(held: boolean): void {
    try {
      this.#onChange?.(held);
    } catch (error) {
      this.#log(`model hold: onChange failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
