// 后台任务的健康（.scratch/background-models spec D3）：后台模型、通道记忆、Hindsight 的失败和恢复交给 Lead，但不成风暴
// （用户：「别出现事件风暴」）。
//
// 调用方每做完一次后台调用就报一次结果（report）。这里只在状态变化时写事件：
//   · 连续 3 次失败、跨度至少 5 分钟，任务转为失败：写 system.background_failing（tell，叫醒 Lead）；
//   · 成功了一次，并且 10 分钟没有失败，任务恢复：写 system.background_recovered（record，不叫醒），
//     只在这一段失败告诉过 Lead 时写；
//   · 同一任务、同一类原因 6 小时内最多一条失败事件，到时还在失败的再写；
//   · 所有任务合计每小时最多 4 条失败事件；超出时等着，下一条写出时把等着的都折进去（「另外还有 N 个」）；
//   · 模型暂停（held）期间什么也不写：暂停本身已经告诉了用户。暂停解除（holdLifted）以后还在失败的才写。
// 状态都在 kv 里（不建新表），和事件在同一笔事务里写；事件带 source_ref，重启以后不会重发。
// 设置页用 states() 读每个任务的状态和今天（本地日期）的调用、失败次数。
import {
  BACKGROUND_FAILING_KIND, BACKGROUND_HEALTH_ENTITY_PREFIX, BACKGROUND_RECOVERED_KIND, redactAndCap, type BackgroundJobState,
} from "@pi-lead-child/protocol";
import { appendEventGuarded, type Db } from "@pi-lead-child/store";

/** 已知的后台任务。别的名字也能报（小写字母开头的单词），类型留着口子。 */
export const BACKGROUND_JOBS = ["background_model", "channel_memory", "hindsight"] as const;
export type BackgroundJob = typeof BACKGROUND_JOBS[number] | (string & {});

export const BACKGROUND_HEALTH_LIMITS = {
  // 转为失败：连续失败几次，并且第一次到这一次至少隔多久。
  failuresToFail: 3,
  failSpanMs: 5 * 60_000,
  // 恢复：成功以后多久没有失败。
  quietToRecoverMs: 10 * 60_000,
  // 同一任务、同一类原因的失败事件最多多久一条。
  perReasonWindowMs: 6 * 3_600_000,
  // 所有任务合计：每个窗口最多几条失败事件。
  globalWindowMs: 3_600_000,
  globalMax: 4,
} as const;

// 模型的问题 Lead 能用的操作（spec「The background model setting」）。
export const BACKGROUND_MODEL_OPERATION = "background_model.set";

export type BackgroundCallResult =
  | { ok: true }
  | {
    ok: false;
    // 原因的类别（机器文字，例如 quota、auth、unknown_model、timeout）。同一类 6 小时内只告诉 Lead 一次。
    reasonClass: string;
    // 原因的原话。写进事件以前脱敏、截断。
    reason: string;
    // 系统已经做了什么（例如「换到了模型 X」）。
    action?: string | null;
    // Lead 能用的操作。不给时：background_model 任务是 background_model.set，别的没有。给 null 表示没有。
    operation?: string | null;
  };

/** 设置页上一个后台任务的状态。 */
export interface BackgroundJobHealth {
  job: string;
  state: "ok" | "failing";
  // 这一段失败从什么时候开始（ISO）；ok 时是 null。
  since: string | null;
  reasonClass: string | null;
  reason: string | null;
  action: string | null;
  // 这一段失败一共失败了几次；ok 时是 0。
  failures: number;
  // 这一段失败告诉过 Lead 没有（写过或者折进过失败事件）。
  told: boolean;
  // 今天（本地日期）的调用次数和失败次数。
  day: string;
  callsToday: number;
  failuresToday: number;
}

/** The settings page's view of one job (protocol's BackgroundJobState): without the internal fields. */
export function backgroundJobState(health: BackgroundJobHealth): BackgroundJobState {
  return {
    job: health.job, state: health.state, since: health.since, reasonClass: health.reasonClass, reason: health.reason,
    action: health.action, callsToday: health.callsToday, failuresToday: health.failuresToday,
  };
}

export interface BackgroundHealth {
  /** 报一次后台调用的结果。不抛错：出错时写日志。 */
  report(job: BackgroundJob, result: BackgroundCallResult): void;
  /** 模型暂停解除了：写暂停期间压着的事件（还在失败的任务、恢复了的任务）。 */
  holdLifted(): void;
  /** 不等下一次调用：结算到时的恢复，写到时可以写的事件。可以定时调（例如每分钟）。 */
  tick(): void;
  /** 每个任务现在的状态（已知的任务总在里面）。只读。 */
  states(): BackgroundJobHealth[];
}

export interface BackgroundHealthOptions {
  db: Db;
  now?: () => Date;
  log?: (line: string) => void;
  // 模型暂停（model hold）开着时返回 true。
  held?: () => boolean;
}

// ── kv 里存的形状 ──────────────────────────────────────────────────────────────────

const JOB_KEY_PREFIX = "background_health.job.";
// 范围查询的上界：「.」后面的下一个字符是「/」。用范围不用 LIKE：任务名里的「_」在 LIKE 里是通配符。
const JOB_KEY_END = "background_health.job/";
const GLOBAL_KEY = "background_health.global";

const JOB_PATTERN = /^[a-z][a-z0-9_]{0,39}$/u;
const OPERATION_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u;
const REASON_MAX = 300;
const ACTION_MAX = 200;

interface FailureDetail {
  reasonClass: string;
  reason: string;
  action: string | null;
  operation: string | null;
}

interface FailingEpisode extends FailureDetail {
  since: string;
  count: number;
  told: boolean;
  // 等着告诉 Lead 的时候碰上过模型暂停。
  heldOver: boolean;
}

interface PendingRecovery {
  reasonClass: string;
  since: string;
  recoveredAt: string;
  failures: number;
}

interface StoredJob {
  // 连续失败（成功一次就清掉）。
  streak: { firstAt: string; count: number } | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  failing: FailingEpisode | null;
  // 恢复了、还没写恢复事件（恢复时模型在暂停）。
  recovery: PendingRecovery | null;
  day: { date: string; calls: number; failures: number };
}

interface StoredGlobal {
  // 窗口里写过的失败事件的时间（最多 globalMax 条）。
  sent: string[];
  // 任务|原因类别 → 上一次告诉 Lead 的时间。超过 6 小时的删掉。
  told: Record<string, string>;
  // 折进别的事件的次数（累计，排查用）。
  foldedTotal: number;
}

const emptyJob = (date: string): StoredJob => ({
  streak: null, lastFailureAt: null, lastSuccessAt: null, failing: null, recovery: null, day: { date, calls: 0, failures: 0 },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);

function parseDetail(value: Record<string, unknown>): FailureDetail {
  return {
    reasonClass: str(value.reasonClass) ?? "unknown",
    reason: str(value.reason) ?? "",
    action: str(value.action),
    operation: str(value.operation),
  };
}

// 存坏了的字段按缺省算，不抛错。
function parseJob(raw: string | undefined, date: string): StoredJob {
  if (!raw) return emptyJob(date);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return emptyJob(date);
  }
  if (!isRecord(value)) return emptyJob(date);
  const streak = isRecord(value.streak) && str(value.streak.firstAt) && num(value.streak.count) > 0
    ? { firstAt: str(value.streak.firstAt)!, count: num(value.streak.count) } : null;
  const failing = isRecord(value.failing) && str(value.failing.since)
    ? {
      ...parseDetail(value.failing), since: str(value.failing.since)!, count: Math.max(1, num(value.failing.count)),
      told: value.failing.told === true, heldOver: value.failing.heldOver === true,
    }
    : null;
  const recovery = isRecord(value.recovery) && str(value.recovery.since) && str(value.recovery.recoveredAt)
    ? {
      reasonClass: str(value.recovery.reasonClass) ?? "unknown", since: str(value.recovery.since)!,
      recoveredAt: str(value.recovery.recoveredAt)!, failures: Math.max(1, num(value.recovery.failures)),
    }
    : null;
  const day = isRecord(value.day) && str(value.day.date)
    ? { date: str(value.day.date)!, calls: num(value.day.calls), failures: num(value.day.failures) }
    : { date, calls: 0, failures: 0 };
  return {
    streak, failing, recovery, day,
    lastFailureAt: str(value.lastFailureAt), lastSuccessAt: str(value.lastSuccessAt),
  };
}

function parseGlobal(raw: string | undefined): StoredGlobal {
  const empty: StoredGlobal = { sent: [], told: {}, foldedTotal: 0 };
  if (!raw) return empty;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return empty;
    const sent = Array.isArray(value.sent) ? value.sent.filter((at): at is string => typeof at === "string") : [];
    const told: Record<string, string> = {};
    if (isRecord(value.told)) for (const [key, at] of Object.entries(value.told)) if (typeof at === "string") told[key] = at;
    return { sent, told, foldedTotal: num(value.foldedTotal) };
  } catch {
    return empty;
  }
}

// 本地日期（设置页的「今天」）。
function localDate(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function capped(text: string, limit: number): string {
  const result = redactAndCap(text, limit);
  return result.truncated ? `${result.text}…` : result.text;
}

// 原因类别是机器文字：小写、只留字母数字和 _.-，最长 40。
function cleanReasonClass(value: unknown): string {
  const text = typeof value === "string" ? value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/gu, "_").slice(0, 40) : "";
  return /^[a-z0-9]/u.test(text) ? text : "unknown";
}

function cleanDetail(job: string, result: Extract<BackgroundCallResult, { ok: false }>): FailureDetail {
  const action = typeof result.action === "string" && result.action.trim() ? capped(result.action.trim(), ACTION_MAX) : null;
  const operation = result.operation === undefined
    ? (job === "background_model" ? BACKGROUND_MODEL_OPERATION : null)
    : typeof result.operation === "string" && OPERATION_PATTERN.test(result.operation) ? result.operation : null;
  return {
    reasonClass: cleanReasonClass(result.reasonClass),
    reason: capped(typeof result.reason === "string" ? result.reason.trim() : "", REASON_MAX),
    action,
    operation,
  };
}

const ms = (iso: string | null): number => (iso ? Date.parse(iso) : Number.NaN);
const toldKey = (job: string, reasonClass: string) => `${job}|${reasonClass}`;

// ── 模块 ──────────────────────────────────────────────────────────────────────────

export function createBackgroundHealth(options: BackgroundHealthOptions): BackgroundHealth {
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((line: string) => console.error(line));
  const limits = BACKGROUND_HEALTH_LIMITS;

  const isHeld = (): boolean => {
    try {
      return options.held?.() === true;
    } catch (error) {
      log(`[background-health] held() threw, treating as not held: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const readJob = (job: string, date: string): StoredJob => {
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(`${JOB_KEY_PREFIX}${job}`) as { value: string } | undefined;
    return parseJob(row?.value, date);
  };
  const readJobs = (date: string): Map<string, StoredJob> => {
    const rows = db.prepare("SELECT key, value FROM kv WHERE key >= ? AND key < ?").all(JOB_KEY_PREFIX, JOB_KEY_END) as
      Array<{ key: string; value: string }>;
    const jobs = new Map<string, StoredJob>();
    for (const row of rows) {
      const job = row.key.slice(JOB_KEY_PREFIX.length);
      if (JOB_PATTERN.test(job)) jobs.set(job, parseJob(row.value, date));
    }
    return jobs;
  };
  const writeKv = (key: string, value: unknown): void => {
    db.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, JSON.stringify(value));
  };
  const writeJob = (job: string, state: StoredJob) => writeKv(`${JOB_KEY_PREFIX}${job}`, state);
  const readGlobal = (): StoredGlobal => {
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(GLOBAL_KEY) as { value: string } | undefined;
    return parseGlobal(row?.value);
  };

  // 成功以后 10 分钟没有失败：恢复。告诉过 Lead 的，留一条恢复事件等着写。返回有没有改。
  const settleRecovery = (job: string, state: StoredJob, at: Date): boolean => {
    const failing = state.failing;
    if (!failing) return false;
    const lastFailure = ms(state.lastFailureAt);
    const lastSuccess = ms(state.lastSuccessAt);
    if (!(lastSuccess >= lastFailure) || at.getTime() - lastFailure < limits.quietToRecoverMs) return false;
    state.failing = null;
    state.streak = null;
    if (failing.told) {
      state.recovery = { reasonClass: failing.reasonClass, since: failing.since, recoveredAt: at.toISOString(), failures: failing.count };
    }
    log(`[background-health] ${job} recovered (failing since ${failing.since}, ${failing.count} failures, told=${failing.told})`);
    return true;
  };

  // 写现在可以写的事件。在调用方的事务里运行。
  const flush = (at: Date): void => {
    const date = localDate(at);
    const jobs = readJobs(date);
    if (isHeld()) {
      // 暂停期间什么也不写。记下哪些失败是压着的：解除以后写出的那一条说明为什么现在才说。
      for (const [job, state] of jobs) {
        if (state.failing && !state.failing.told && !state.failing.heldOver) {
          state.failing.heldOver = true;
          writeJob(job, state);
        }
      }
      return;
    }
    const iso = at.toISOString();
    for (const [job, state] of jobs) {
      if (!state.recovery) continue;
      const recovery = state.recovery;
      appendEventGuarded(db, () => ({
        source: "system",
        sourceRef: `background_recovered:${job}:${recovery.since}`,
        kind: BACKGROUND_RECOVERED_KIND,
        entityKey: `${BACKGROUND_HEALTH_ENTITY_PREFIX}${job}`,
        occurredAt: recovery.recoveredAt,
        level: "record",
        payload: { job, ...recovery },
      }), { receivedAt: at });
      state.recovery = null;
      writeJob(job, state);
    }

    const global = readGlobal();
    const windowStart = at.getTime() - limits.globalWindowMs;
    const reasonStart = at.getTime() - limits.perReasonWindowMs;
    let globalChanged = false;
    const sent = global.sent.filter((time) => ms(time) > windowStart);
    if (sent.length !== global.sent.length) globalChanged = true;
    for (const [key, time] of Object.entries(global.told)) {
      if (!(ms(time) > reasonStart)) {
        delete global.told[key];
        globalChanged = true;
      }
    }
    global.sent = sent;
    // 等着告诉 Lead 的失败：同一类原因 6 小时内说过的，等到窗口过去。
    const waiting = [...jobs]
      .filter(([job, state]) => state.failing && !state.failing.told && !global.told[toldKey(job, state.failing.reasonClass)])
      .sort(([, left], [, right]) => ms(left.failing!.since) - ms(right.failing!.since));
    if (waiting.length && sent.length < limits.globalMax) {
      const [[job, state], ...rest] = waiting as Array<[string, StoredJob & { failing: FailingEpisode }]>;
      const failing = state.failing;
      const folded = rest.map(([other, otherState]) => ({
        job: other, reasonClass: otherState.failing!.reasonClass, reason: otherState.failing!.reason, since: otherState.failing!.since,
      }));
      appendEventGuarded(db, () => ({
        source: "system",
        sourceRef: `background_failing:${job}:${failing.since}`,
        kind: BACKGROUND_FAILING_KIND,
        entityKey: `${BACKGROUND_HEALTH_ENTITY_PREFIX}${job}`,
        occurredAt: iso,
        level: "tell",
        payload: {
          job, reasonClass: failing.reasonClass, reason: failing.reason, since: failing.since, failures: failing.count,
          action: failing.action, operation: failing.operation, folded, afterHold: failing.heldOver,
        },
        rootCause: {
          code: failing.reasonClass, scope: "background", message: failing.reason,
          ...(failing.operation ? { next_step: failing.operation } : {}),
        },
      }), { receivedAt: at });
      for (const [toldJob, toldState] of waiting) {
        toldState.failing!.told = true;
        global.told[toldKey(toldJob, toldState.failing!.reasonClass)] = iso;
        writeJob(toldJob, toldState);
      }
      global.sent.push(iso);
      global.foldedTotal += folded.length;
      globalChanged = true;
      log(`[background-health] told Lead: ${job} failing (${failing.reasonClass})${folded.length ? `, folded ${folded.map((entry) => entry.job).join(", ")}` : ""}`);
    }
    if (globalChanged) writeKv(GLOBAL_KEY, global);
  };

  const guarded = (what: string, body: () => void): void => {
    try {
      db.transaction(body)();
    } catch (error) {
      log(`[background-health] ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // 结算到时的恢复，再写现在可以写的事件（holdLifted、tick）。
  const settle = (what: string): void => guarded(what, () => {
    const at = now();
    for (const [job, state] of readJobs(localDate(at))) if (settleRecovery(job, state, at)) writeJob(job, state);
    flush(at);
  });

  return {
    report(job, result) {
      if (typeof job !== "string" || !JOB_PATTERN.test(job)) {
        log(`[background-health] ignored a report for an invalid job name`);
        return;
      }
      guarded(`report(${job})`, () => {
        const at = now();
        const iso = at.toISOString();
        const date = localDate(at);
        const state = readJob(job, date);
        if (state.day.date !== date) state.day = { date, calls: 0, failures: 0 };
        state.day.calls += 1;
        if (result.ok) {
          state.streak = null;
          state.lastSuccessAt = iso;
          settleRecovery(job, state, at);
        } else {
          const detail = cleanDetail(job, result);
          state.day.failures += 1;
          state.lastFailureAt = iso;
          state.streak = state.streak ? { ...state.streak, count: state.streak.count + 1 } : { firstAt: iso, count: 1 };
          if (state.failing) {
            state.failing.count += 1;
            // 还没告诉 Lead 时，原因跟着最近一次走；告诉过以后类别不变（6 小时的窗口按它算），原话照样更新。
            if (state.failing.told) Object.assign(state.failing, { ...detail, reasonClass: state.failing.reasonClass });
            else Object.assign(state.failing, detail);
          } else if (state.streak.count >= limits.failuresToFail && at.getTime() - ms(state.streak.firstAt) >= limits.failSpanMs) {
            state.failing = { ...detail, since: state.streak.firstAt, count: state.streak.count, told: false, heldOver: false };
            log(`[background-health] ${job} is failing (${detail.reasonClass}, ${state.streak.count} failures since ${state.streak.firstAt})`);
          }
        }
        writeJob(job, state);
        flush(at);
      });
    },

    holdLifted: () => settle("holdLifted"),
    tick: () => settle("tick"),

    states() {
      const at = now();
      const date = localDate(at);
      const stored = readJobs(date);
      const names = [...new Set<string>([...BACKGROUND_JOBS, ...stored.keys()])];
      return names.map((job): BackgroundJobHealth => {
        const state = stored.get(job) ?? emptyJob(date);
        const today = state.day.date === date ? state.day : { date, calls: 0, failures: 0 };
        const failing = state.failing;
        return {
          job,
          state: failing ? "failing" : "ok",
          since: failing?.since ?? null,
          reasonClass: failing?.reasonClass ?? null,
          reason: failing?.reason ?? null,
          action: failing?.action ?? null,
          failures: failing?.count ?? 0,
          told: failing?.told ?? false,
          day: date,
          callsToday: today.calls,
          failuresToday: today.failures,
        };
      });
    },
  };
}
