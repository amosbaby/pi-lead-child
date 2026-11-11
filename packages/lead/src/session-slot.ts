// Lead 的会话槽（.scratch/tool-occupancy/spec.md L3，p4-spike.md）：一步中止以后还停不下时，daemon 在进程里换掉 Lead 的 pi 会话。
//
// daemon 不直接拿着 pi 会话，而是拿着这个槽给的转发对象（session）和转发函数（result()）。槽换了会话，daemon 的闭包自动用新的。
// 换会话（replace）按这个顺序做，每一步都是同步的，只有建新会话要等：
//   1. 切断旧会话的写入：sessionManager.persist = false（pi 写会话文件只有 _persist 和 _rewriteFile 两个出口，都先看它），
//      再 dispose()（中止模型流、断开 agent 的事件、让扩展的 ctx 失效）。旧会话以后醒过来也写不进会话文件、推不到 daemon。
//   2. 收下旧会话队列里排着的插话和排队消息。从这时到换好，新来的插话和排队消息也先收在槽里：旧会话的 steer 要经过扩展的
//      input 钩子，扩展可能就是挂住的那个。daemon 下一次 clearQueue() 时把它们交出去，转成下一轮。
//   3. 建新会话（工厂从会话文件续接，SessionManager.continueRecent），有时限。监听挂到新会话上。
//   4. 在旧会话上还没结束的 prompt() 和 compact() 以 LeadSessionReleasedError 结束：daemon 的这一轮照常收尾，单元挂起。
// 建新会话失败：在旧会话上等着的调用照样结束（Lead 不再被占住），槽记下失败。下一次 prompt() 先再建一次，还失败就报这个错。
import type { LeadEngine, LeadEngineFactoryResult } from "./engine.js";

/** 旧会话上的调用被释放了：这一步停不下，daemon 换掉了会话。 */
export class LeadSessionReleasedError extends Error {
  constructor() {
    super("Lead's step did not stop after an abort; the daemon replaced the session");
    this.name = "LeadSessionReleasedError";
  }
}

export function isLeadSessionReleased(error: unknown): boolean {
  return error instanceof LeadSessionReleasedError;
}

export const LEAD_SESSION_REBUILD_TIMEOUT_MS = 60_000;

type Listener = Parameters<LeadEngine["subscribe"]>[0];
type Images = Parameters<LeadEngine["steer"]>[1];

/** 换会话的结果，写进日志和给 Lead 的事件。 */
export interface LeadSessionReplacement {
  // 从旧会话的队列和换的那几秒里收下的插话、排队消息的条数。
  held: number;
  // 被释放的调用（prompt、compact）个数。
  released: number;
  // 建新会话用了多少毫秒。
  buildMs: number;
  modelName: string;
}

// 切断一个 pi 会话的写入，再 dispose。测试的替身没有 sessionManager：只 dispose。
function retire(session: LeadEngine): void {
  const manager = (session as { sessionManager?: unknown }).sessionManager;
  if (manager && typeof manager === "object" && "persist" in manager) (manager as { persist: boolean }).persist = false;
  try {
    (session as Partial<LeadEngine>).dispose?.();
  } catch { /* dispose 本来就不该抛；抛了也照样换 */ }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`building a new Lead session took over ${Math.round(ms / 1_000)}s`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

export class LeadSessionSlot {
  #current: LeadEngineFactoryResult;
  readonly #initial: LeadEngineFactoryResult;
  #listeners = new Map<Listener, () => void>();
  // 在当前会话上还没结束的 prompt()、compact()：换会话时让它们以 LeadSessionReleasedError 结束。
  #inFlight = new Set<(error: Error) => void>();
  #replacing: Promise<unknown> | null = null;
  #held = { steering: [] as string[], followUp: [] as string[] };
  // 上一次建新会话失败了：下一次 prompt() 先再建一次。
  #broken: { error: Error; build: () => Promise<LeadEngineFactoryResult> } | null = null;
  #generation = 0;
  readonly session: LeadEngine;

  constructor(initial: LeadEngineFactoryResult) {
    this.#initial = initial;
    this.#current = initial;
    this.session = this.#forwarder();
  }

  /** 现在的会话（测试和日志用）。daemon 用 session。 */
  get current(): LeadEngine {
    return this.#current.session;
  }

  /** 换过几次会话。 */
  get generation(): number {
    return this.#generation;
  }

  /** 正在换会话。 */
  get replacing(): boolean {
    return this.#replacing !== null;
  }

  /** 工厂结果的转发版：函数调现在那个会话的，值用第一次建会话时的（模型列表、SmartModel 不随会话变）。 */
  result(): LeadEngineFactoryResult {
    const initial = this.#initial;
    const forward = <K extends keyof LeadEngineFactoryResult>(key: K) => {
      if (typeof initial[key] !== "function") return {};
      return { [key]: (...args: unknown[]) => (this.#current[key] as unknown as ((...a: unknown[]) => unknown) | undefined)?.(...args) };
    };
    return {
      ...initial,
      session: this.session,
      ...forward("syncToolAccess"),
      ...forward("reloadExtensions"),
      ...forward("switchModel"),
      ...forward("interruptStep"),
      ...forward("refreshProviders"),
      ...forward("brainReady"),
    } as LeadEngineFactoryResult;
  }

  /**
   * 换掉会话：先切断旧会话的写入，再建新会话（build，从会话文件续接），然后让旧会话上的调用以 LeadSessionReleasedError 结束。
   * 建新会话失败或超时：旧会话上的调用照样结束，抛出这个错误。
   */
  async replace(
    build: () => Promise<LeadEngineFactoryResult>,
    // settled：换好（true）或者没建出来（false），在旧会话上的调用结束以前调。daemon 据此在那一轮的收尾里写对的话。
    options: { timeoutMs?: number; now?: () => number; settled?: (replaced: boolean) => void } = {},
  ): Promise<LeadSessionReplacement> {
    if (this.#replacing) throw new Error("the Lead session is already being replaced");
    const now = options.now ?? Date.now;
    const old = this.#current.session;
    // 1–2：切断，收下排着的消息，解开监听。
    retire(old);
    const queued = old.clearQueue?.();
    this.#held.steering.push(...(queued?.steering ?? []));
    this.#held.followUp.push(...(queued?.followUp ?? []));
    for (const [listener, unsubscribe] of this.#listeners) {
      try { unsubscribe(); } catch { /* 旧会话已经 dispose */ }
      this.#listeners.set(listener, () => {});
    }
    const released = [...this.#inFlight];
    this.#inFlight.clear();
    const started = now();
    let finish!: () => void;
    this.#replacing = new Promise<void>((resolve) => { finish = resolve; });
    let replaced = false;
    try {
      const next = await withTimeout(build(), options.timeoutMs ?? LEAD_SESSION_REBUILD_TIMEOUT_MS);
      this.#install(next);
      this.#broken = null;
      replaced = true;
      return { held: this.#heldCount(), released: released.length, buildMs: now() - started, modelName: next.modelName };
    } catch (error) {
      this.#broken = { error: error instanceof Error ? error : new Error(String(error)), build };
      throw this.#broken.error;
    } finally {
      this.#replacing = null;
      finish();
      try { options.settled?.(replaced); } catch { /* 调用方的事，不影响换会话 */ }
      // 4：换好以后（或者建不出来）再结束旧会话上的调用。daemon 收尾时 clearQueue() 拿到的是收下的消息。
      for (const reject of released) reject(new LeadSessionReleasedError());
    }
  }

  #install(next: LeadEngineFactoryResult): void {
    this.#current = next;
    this.#generation += 1;
    for (const listener of this.#listeners.keys()) {
      this.#listeners.set(listener, next.session.subscribe(listener));
    }
  }

  #heldCount(): number {
    return this.#held.steering.length + this.#held.followUp.length;
  }

  // 让一个调用可以被释放：和「换会话」赛跑。
  #releasable<T>(call: () => Promise<T>): Promise<T> {
    let rejectRelease!: (error: Error) => void;
    const releasedCall = new Promise<never>((_, reject) => { rejectRelease = reject; });
    this.#inFlight.add(rejectRelease);
    let running: Promise<T>;
    try {
      running = call();
    } catch (error) {
      running = Promise.reject(error);
    }
    return Promise.race([running, releasedCall]).finally(() => { this.#inFlight.delete(rejectRelease); });
  }

  // 正在换会话时等它换好；上次没建出来时再建一次。
  async #ready(): Promise<void> {
    if (this.#replacing) await this.#replacing;
    const broken = this.#broken;
    if (!broken) return;
    try {
      const next = await withTimeout(broken.build(), LEAD_SESSION_REBUILD_TIMEOUT_MS);
      this.#install(next);
      this.#broken = null;
    } catch (error) {
      this.#broken = { error: error instanceof Error ? error : new Error(String(error)), build: broken.build };
      throw this.#broken.error;
    }
  }

  #forwarder(): LeadEngine {
    const overrides: Record<string, unknown> = {
      // 平常同步登记（换会话随时可能开始）；正在换或者上次没建出来时，先等新会话。
      prompt: (...args: Parameters<LeadEngine["prompt"]>) => {
        if (!this.#replacing && !this.#broken) return this.#releasable(() => this.#current.session.prompt(...args));
        return this.#ready().then(() => this.#releasable(() => this.#current.session.prompt(...args)));
      },
      steer: (text: string, images?: Images) => {
        if (this.#replacing || this.#broken) {
          this.#held.steering.push(text);
          return Promise.resolve("queued");
        }
        return images ? this.#current.session.steer(text, images) : this.#current.session.steer(text);
      },
      followUp: (text: string, images?: Images) => {
        if (this.#replacing || this.#broken) {
          this.#held.followUp.push(text);
          return Promise.resolve("queued");
        }
        return images ? this.#current.session.followUp(text, images) : this.#current.session.followUp(text);
      },
      subscribe: (listener: Listener) => {
        this.#listeners.set(listener, this.#replacing ? () => {} : this.#current.session.subscribe(listener));
        return () => {
          const unsubscribe = this.#listeners.get(listener);
          this.#listeners.delete(listener);
          unsubscribe?.();
        };
      },
      // 停机时 daemon 调它：只 dispose 现在的会话，不释放在跑的调用。那一轮照常按「被重启打断」收尾，不是「已释放」。
      // 测试的替身可能没有 dispose（daemon 用 session.dispose?.()）。
      dispose: () => {
        (this.#current.session as Partial<LeadEngine>).dispose?.();
      },
    };
    // 会话有 clearQueue、compact、abort 时才有（daemon 按有没有决定怎么做）。
    const optional: Record<string, (session: LeadEngine) => unknown> = {
      clearQueue: (session) => () => {
        const held = this.#held;
        this.#held = { steering: [], followUp: [] };
        const fresh = this.#replacing || this.#broken ? { steering: [], followUp: [] } : session.clearQueue!();
        return { steering: [...held.steering, ...fresh.steering], followUp: [...held.followUp, ...fresh.followUp] };
      },
      compact: (session) => (...args: Parameters<NonNullable<LeadEngine["compact"]>>) =>
        this.#releasable(() => session.compact!(...args)),
      // 正在换会话时，旧会话已经中止过、断开了：不再叫它。
      abort: (session) => () => (this.#replacing ? Promise.resolve() : session.abort!()),
    };
    return new Proxy({} as LeadEngine, {
      get: (_target, key) => {
        if (typeof key === "string" && key in overrides) return overrides[key];
        const session = this.#current.session;
        if (typeof key === "string" && key in optional) {
          return typeof (session as Record<string, unknown>)[key] === "function" ? optional[key]!(session) : undefined;
        }
        const value = Reflect.get(session as object, key);
        return typeof value === "function" ? value.bind(session) : value;
      },
      has: (_target, key) => key in overrides || key in (this.#current.session as object),
    });
  }
}
