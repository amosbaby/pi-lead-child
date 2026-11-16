// 自动调用的预算（2026-11-16）。系统自己发起的模型调用（事件叫醒的一轮、空闲车道的活）以前没有上限：
// 2026-11-05 一张工单的预算提示叫醒了 Lead 6,923 轮；2026-11-14 起模型不可用的两天里自动调了 7,028 次。
// 熔断（model-hold.ts）管「一直失败」；这里管「每一次都成功，可是停不下来」：数量超过预算就暂停，告诉用户。
// 用户本人的消息不算、也不受限制。
//
// 缺省值按 2026-11-10 到 11-13 四天正常日子的实测定：系统发起的调用每小时中位数 14 次、最多 88 次，每天 211–523 次；
// 没命中缓存的输入每天 320 万–3,160 万 token。
//   · 每小时 120 次：比正常的最高值多三分之一；
//   · 每天 1,500 次：约是最忙一天的 3 倍；
//   · 每天没命中缓存的输入 5,000 万 token：比最忙一天多一半。
// config.json 的 lead.autoBudget 可以改（callsPerHour、callsPerDay、uncachedTokensPerDay；0 是不限）。
// 记录只在 daemon 的内存里：重启以后从零开始数。风暴要几个小时才成形，重启不会让它躲过去。

export interface AutoCallBudgetLimits {
  callsPerHour: number;
  callsPerDay: number;
  uncachedTokensPerDay: number;
}

export const DEFAULT_AUTO_CALL_BUDGET: AutoCallBudgetLimits = { callsPerHour: 120, callsPerDay: 1_500, uncachedTokensPerDay: 50_000_000 };

export interface AutoCallBudgetExceeded {
  /** 超了哪一条。 */
  limit: keyof AutoCallBudgetLimits;
  /** 暂停到什么时候：到那时这个时间窗里的用量降到上限的八成以下。 */
  until: number;
  /** 一句话（写进日志和给用户的说明）。 */
  detail: string;
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
// 暂停到用量降到上限的这个比例：不然窗口里最老的一次调用一出去，下一次调用马上又超。
const RESUME_RATIO = 0.8;

/** config.json 的 lead.autoBudget：只取写对的数字（非负整数），别的用缺省。 */
/** The input of one model call that the provider did not serve from its cache: pi's usage.input plus usage.cacheWrite. */
export function uncachedTokens(usage: unknown): number {
  if (!usage || typeof usage !== "object") return 0;
  const used = (key: string) => {
    const value = (usage as Record<string, unknown>)[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  };
  return used("input") + used("cacheWrite");
}

export function autoCallBudgetLimits(configured: unknown): AutoCallBudgetLimits {
  const limits = { ...DEFAULT_AUTO_CALL_BUDGET };
  if (!configured || typeof configured !== "object") return limits;
  for (const key of Object.keys(limits) as Array<keyof AutoCallBudgetLimits>) {
    const value = (configured as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) limits[key] = value;
  }
  return limits;
}

export class AutoCallBudget {
  readonly #limits: AutoCallBudgetLimits;
  readonly #now: () => number;
  // 最近 24 小时里的自动调用，按时间排。
  #calls: Array<{ at: number; uncached: number }> = [];

  constructor(options: { limits?: AutoCallBudgetLimits; now?: () => number } = {}) {
    this.#limits = options.limits ?? DEFAULT_AUTO_CALL_BUDGET;
    this.#now = options.now ?? Date.now;
  }

  /** 记一次自动的模型调用（成功、失败都算）。uncachedTokens：没命中缓存的输入（input + cacheWrite）。超了预算时返回超的那一条。 */
  record(uncachedTokens: number): AutoCallBudgetExceeded | null {
    const now = this.#now();
    this.#calls.push({ at: now, uncached: Math.max(0, uncachedTokens) });
    return this.exceeded();
  }

  usage(): { callsLastHour: number; callsLastDay: number; uncachedTokensLastDay: number } {
    const now = this.#now();
    this.#calls = this.#calls.filter((call) => call.at > now - DAY);
    return {
      callsLastHour: this.#calls.filter((call) => call.at > now - HOUR).length,
      callsLastDay: this.#calls.length,
      uncachedTokensLastDay: this.#calls.reduce((total, call) => total + call.uncached, 0),
    };
  }

  exceeded(): AutoCallBudgetExceeded | null {
    const used = this.usage();
    const { callsPerHour, callsPerDay, uncachedTokensPerDay } = this.#limits;
    if (callsPerHour > 0 && used.callsLastHour >= callsPerHour) {
      const inHour = this.#calls.filter((call) => call.at > this.#now() - HOUR);
      return {
        limit: "callsPerHour", until: this.#untilCount(inHour, callsPerHour, HOUR),
        detail: `${used.callsLastHour} automatic model calls in the last hour (limit ${callsPerHour})`,
      };
    }
    if (callsPerDay > 0 && used.callsLastDay >= callsPerDay) {
      return {
        limit: "callsPerDay", until: this.#untilCount(this.#calls, callsPerDay, DAY),
        detail: `${used.callsLastDay} automatic model calls in the last 24 hours (limit ${callsPerDay})`,
      };
    }
    if (uncachedTokensPerDay > 0 && used.uncachedTokensLastDay >= uncachedTokensPerDay) {
      // 从最老的开始去掉，到剩下的降到八成以下：那一次调用离开窗口的时间。
      let left = used.uncachedTokensLastDay;
      let until = this.#now() + DAY;
      for (const call of this.#calls) {
        left -= call.uncached;
        if (left < uncachedTokensPerDay * RESUME_RATIO) {
          until = call.at + DAY;
          break;
        }
      }
      return {
        limit: "uncachedTokensPerDay", until,
        detail: `${used.uncachedTokensLastDay} uncached input tokens in automatic calls in the last 24 hours (limit ${uncachedTokensPerDay})`,
      };
    }
    return null;
  }

  // 窗口里的调用降到上限的八成以下的时间：第 (现在的数量 - 八成) 个最老的调用离开窗口的时候。
  #untilCount(calls: Array<{ at: number }>, limit: number, window: number): number {
    const keep = Math.max(0, Math.floor(limit * RESUME_RATIO) - 1);
    const leaving = calls[Math.max(0, calls.length - keep - 1)]!;
    return leaving.at + window;
  }
}
