// Lead 的订阅账号（模型配置方案 C 的 S2，.scratch/model-config-c/spec.md D2、D4、D5）。
//
// 订阅只有 GitHub Copilot 和 Codex，都经过 pi-multi-pass（github.com/hjanuschka/pi-multi-pass，下面写 MS）：
//   - 第一个账号是 pi 自带的 provider（<base>），第 n 个账号是 MS 注册的 <base>-<n>（MS 的 subProviderName）；
//   - 凭据在 pi 的 agentDir 的 auth.json（按 provider 名），MS 的配置在同一个目录的 multi-pass.json（D2，和用户自己的 pi 共用）；
//   - 一种订阅有两个以上账号时，MS 的 pool 在一个账号限流时换下一个账号（MS 的 PoolManager，agent_end 里 setModel）。
// 这里是不碰会话的部分：multi-pass.json 的读写（按 MS 的格式，保留不认识的字段）、pool 的成员、按时间段的顺序（照 MS 的
// getScheduledMemberOrder），以及 Lead 自己记的账号失败（SubscriptionAccountTracker，D5：pool 里还有没试过、不在冷却的
// 账号时，Lead 的模型切换不换格子）。
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import {
  SUBSCRIPTION_BASES, subscriptionAccountName, subscriptionAccountOf,
  type SubscriptionBase, type SubscriptionDay, type SubscriptionRole, type SubscriptionStrategy, type SubscriptionWindow,
} from "@pi-lead-child/protocol";

export { SUBSCRIPTION_BASES, subscriptionAccountName, subscriptionAccountOf, subscriptionSlotSpec } from "@pi-lead-child/protocol";

// ── pi 的 agentDir 和登录用的 ModelRuntime（D2、D3）────────────────────────────────

/** pi 自己的 agentDir（auth.json、multi-pass.json）：Lead 的 ModelRuntime 读的同一个，和用户自己的 pi 共用。 */
export function piAgentDir(): string {
  return getAgentDir();
}

// 登录、退出、列凭据要用的那部分 ModelRuntime（daemon 的 subscriptions.ts；测试用假的）。
export type SubscriptionLoginRuntime = Pick<ModelRuntime, "getProvider" | "registerNativeProvider" | "login" | "logout" | "listCredentials">;

/** 只为登录建的 ModelRuntime：auth.json 是 agentDir 里的那一份（pi 的文件锁），不读写 models.json，不联网。 */
export function createSubscriptionLoginRuntime(agentDir: string): Promise<SubscriptionLoginRuntime> {
  return ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
}

// auth.json 里一个账号的凭据（只读这几项：access 只用来查 Codex 的额度）。
export interface StoredSubscriptionCredential {
  type?: string;
  access?: string;
  expires?: number;
  accountId?: string;
  email?: string;
}

export function readSubscriptionCredential(agentDir: string, provider: string): StoredSubscriptionCredential | undefined {
  try {
    return readStoredCredential(provider, join(agentDir, "auth.json")) as StoredSubscriptionCredential | undefined;
  } catch {
    return undefined;
  }
}

/** D7：Lead 只用这两种订阅的 OAuth 登录（openai-codex*、github-copilot*）。别的 OAuth 订阅登录（例如 anthropic）不用。 */
export function isLeadSubscriptionProvider(provider: string): boolean {
  return subscriptionAccountOf(provider) !== null;
}

// ── multi-pass.json（MS:2281-2419）──────────────────────────────────────────────

export interface MultiPassSubscription {
  provider: string;
  index: number;
  label?: string;
}

export interface MultiPassMemberSchedule {
  windows?: SubscriptionWindow[];
  role?: "preferred" | "overflow";
}

export interface MultiPassPool {
  name: string;
  baseProvider: string;
  members: string[];
  enabled: boolean;
  strategy?: SubscriptionStrategy | "custom";
  memberSchedule?: Record<string, MultiPassMemberSchedule>;
  selectorScript?: string;
  [key: string]: unknown;
}

// MS 的 MultiPassConfig。别的字段（chains、presets、statusBar、tokenKeeper……）原样保留：这份文件和用户自己的 pi 共用。
export interface MultiPassConfig {
  subscriptions: MultiPassSubscription[];
  pools: MultiPassPool[];
  chains: unknown[];
  presets: unknown[];
  [key: string]: unknown;
}

export function multiPassConfigPath(piAgentDir: string): string {
  return join(piAgentDir, "multi-pass.json");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** 读 multi-pass.json。没有时是空的；坏了时抛错（不能当作空的写回去，那会删掉用户的配置）。 */
export function readMultiPassConfig(piAgentDir: string): MultiPassConfig {
  const path = multiPassConfigPath(piAgentDir);
  if (!existsSync(path)) return { subscriptions: [], pools: [], chains: [], presets: [] };
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(raw)) throw new Error(`${path} is not a JSON object`);
  const subscriptions = (Array.isArray(raw.subscriptions) ? raw.subscriptions : []).filter((entry): entry is MultiPassSubscription =>
    isRecord(entry) && typeof entry.provider === "string" && typeof entry.index === "number");
  const pools = (Array.isArray(raw.pools) ? raw.pools : []).filter((pool): pool is MultiPassPool =>
    isRecord(pool) && typeof pool.name === "string" && typeof pool.baseProvider === "string" && Array.isArray(pool.members));
  return {
    ...raw,
    subscriptions,
    pools,
    chains: Array.isArray(raw.chains) ? raw.chains : [],
    presets: Array.isArray(raw.presets) ? raw.presets : [],
  };
}

/** 写 multi-pass.json：先写临时文件再改名（和 MS 的 saveJsonConfig 一样），读到一半的人看不到写了一半的文件。 */
export function writeMultiPassConfig(piAgentDir: string, config: MultiPassConfig): void {
  const path = multiPassConfigPath(piAgentDir);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, JSON.stringify(config, null, 2), "utf8");
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // 临时文件没写出来。
    }
    throw error;
  }
}

/** 一种订阅的账号（provider 名），按序号排：<base> 在最前面，然后是 multi-pass.json 里的 <base>-<n>。 */
export function subscriptionAccounts(config: MultiPassConfig, base: SubscriptionBase): Array<{ provider: string; index: number; label: string | null }> {
  const extra = config.subscriptions
    .filter((entry) => entry.provider === base && Number.isInteger(entry.index) && entry.index >= 2)
    .sort((a, b) => a.index - b.index)
    .map((entry) => ({ provider: subscriptionAccountName(base, entry.index), index: entry.index, label: entry.label?.trim() || null }));
  return [{ provider: base, index: 1, label: null }, ...extra];
}

/** 下一个空着的序号（从 2 起）。reserved 是正在登录、还没写进文件的。 */
export function nextSubscriptionIndex(config: MultiPassConfig, base: SubscriptionBase, reserved: Iterable<number> = []): number {
  const used = new Set([...config.subscriptions.filter((entry) => entry.provider === base).map((entry) => entry.index), ...reserved]);
  let index = 2;
  while (used.has(index)) index += 1;
  return index;
}

/** 这种订阅的 pool：baseProvider 是它的第一个（用户自己在 pi 里建的也算）。 */
export function subscriptionPool(config: MultiPassConfig, base: SubscriptionBase): MultiPassPool | null {
  const pools = config.pools.filter((pool) => pool.baseProvider === base);
  return pools.find((pool) => pool.enabled) ?? pools[0] ?? null;
}

/**
 * 让 pool 的成员跟上账号（加了、删了账号以后）。两个以上账号、还没有 pool 时建一个（名字是 <base>，round-robin）。
 * 已有的成员顺序不变，新账号排在后面；删掉的账号也从时间段里删掉。返回新的配置，不改传进来的。
 */
export function syncSubscriptionPool(config: MultiPassConfig, base: SubscriptionBase): MultiPassConfig {
  const accounts = subscriptionAccounts(config, base).map((account) => account.provider);
  const existing = subscriptionPool(config, base);
  if (!existing) {
    if (accounts.length < 2) return config;
    const name = config.pools.some((pool) => pool.name === base) ? `${base}-accounts` : base;
    return { ...config, pools: [...config.pools, { name, baseProvider: base, members: accounts, enabled: true, strategy: "round-robin" }] };
  }
  const kept = existing.members.filter((member) => accounts.includes(member));
  const members = [...kept, ...accounts.filter((account) => !kept.includes(account))];
  const schedule = existing.memberSchedule
    ? Object.fromEntries(Object.entries(existing.memberSchedule).filter(([member]) => members.includes(member)))
    : undefined;
  const next: MultiPassPool = { ...existing, members, ...(schedule ? { memberSchedule: schedule } : {}) };
  return { ...config, pools: config.pools.map((pool) => (pool === existing ? next : pool)) };
}

// ── 按时间段换号（MS:3016-3130 的 getScheduledMemberOrder）────────────────────────

const JS_DAYS: readonly SubscriptionDay[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function inHours(hour: number, [start, end]: readonly [number, number]): boolean {
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function inSubscriptionWindow(window: SubscriptionWindow, now: Date): boolean {
  if (window.days?.length && !window.days.includes(JS_DAYS[now.getDay()]!)) return false;
  if (window.hours && !inHours(now.getHours(), window.hours)) return false;
  if (window.dateRange?.from && localDate(now) < window.dateRange.from) return false;
  if (window.dateRange?.to && localDate(now) > window.dateRange.to) return false;
  return true;
}

function windowRemainingMs(window: SubscriptionWindow, now: Date): number {
  if (!window.hours) return Infinity;
  const end = new Date(now);
  end.setHours(window.hours[1], 0, 0, 0);
  const remaining = end.getTime() - now.getTime();
  return remaining <= 0 ? remaining + 24 * 3_600_000 : remaining;
}

export function memberRole(pool: MultiPassPool | null, provider: string): SubscriptionRole {
  return pool?.memberSchedule?.[provider]?.role ?? "default";
}

/**
 * MS 的 scheduled 顺序：在自己时间段里的 preferred（时间段剩得少的在前），然后 default，最后 overflow。
 * 不在时间段里的 preferred 整个跳过。
 */
export function scheduledOrder(pool: MultiPassPool | null, available: readonly string[], now: Date): string[] {
  const states = available.map((provider) => {
    const schedule = pool?.memberSchedule?.[provider];
    const role = schedule?.role ?? "default";
    const windows = schedule?.windows ?? [];
    if (role === "overflow" || windows.length === 0) return { provider, role, active: true, remaining: Infinity };
    const active = windows.filter((window) => inSubscriptionWindow(window, now));
    return { provider, role, active: active.length > 0, remaining: Math.min(...active.map((window) => windowRemainingMs(window, now))) };
  });
  return [
    ...states.filter((state) => state.role === "preferred" && state.active).sort((a, b) => a.remaining - b.remaining),
    ...states.filter((state) => state.role === "default"),
    ...states.filter((state) => state.role === "overflow"),
  ].map((state) => state.provider);
}

// ── Lead 记的账号失败（D5）────────────────────────────────────────────────────

// MS 的 PoolState.cooldownMs：限流的账号 5 分钟以内不再试。
export const SUBSCRIPTION_COOLDOWN_MS = 5 * 60_000;

// 换账号的理由：限流、额度用完、授权失败。别的（模型服务不可用、上下文溢出、网络）换哪个账号都一样。
const ACCOUNT_FAILURE = /usage.?limit|rate.?limit|limit.*reached|too many requests|\b429\b|quota|insufficient[_ ]quota|\b401\b|\b403\b|unauthori[sz]ed|invalid[_ ]?(?:api[_ ]?key|token|grant)|refresh token|authentication/i;

export function isSubscriptionAccountFailure(error: string): boolean {
  return ACCOUNT_FAILURE.test(error);
}

/**
 * Lead 会话里每次请求的结果（plc-subscription-accounts 扩展记，每次重试都算一次）。daemon 在 Lead 的一轮失败以后问
 * nextAccount：同一种订阅里还有没试过、不在冷却的账号时，换账号，不换分工的格子。
 */
export class SubscriptionAccountTracker {
  private readonly failedAt = new Map<string, number>();
  // 这次故障里失败过的账号。有一次成功就清空。
  private readonly tried = new Set<string>();
  // 最近一次失败的请求用的账号。pi-multi-pass 可能已经在同一个 agent_end 里换了账号，会话现在用的不一定是失败的那个。
  private lastFailed: string | null = null;

  constructor(private readonly options: { cooldownMs?: number; now?: () => number } = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private cooldown(): number {
    return this.options.cooldownMs ?? SUBSCRIPTION_COOLDOWN_MS;
  }

  /** 一次请求失败了。只记订阅账号、只记限流、额度和授权这几类。 */
  failed(provider: string, error: string): void {
    if (!isSubscriptionAccountFailure(error) || !subscriptionAccountOf(provider)) return;
    this.failedAt.set(provider, this.now());
    this.tried.add(provider);
    this.lastFailed = provider;
  }

  /** 这次故障里最近一次失败的账号。成功以后为 null。 */
  lastFailedAccount(): string | null {
    return this.lastFailed;
  }

  /** 这个账号这次故障里没试过，也不在冷却。 */
  usable(provider: string): boolean {
    return !this.tried.has(provider) && this.coolingUntil(provider) === null;
  }

  /** 一次请求成功了：这个账号不再冷却，这次故障结束。 */
  succeeded(provider: string): void {
    this.failedAt.delete(provider);
    this.tried.clear();
    this.lastFailed = null;
  }

  /** 账号在冷却时，到什么时候（毫秒时间戳）；不在冷却时为 null。 */
  coolingUntil(provider: string): number | null {
    const at = this.failedAt.get(provider);
    if (at === undefined) return null;
    const until = at + this.cooldown();
    if (until <= this.now()) {
      this.failedAt.delete(provider);
      return null;
    }
    return until;
  }

  /**
   * current 失败以后同一种订阅下一个能试的账号：candidates 是登录了的账号，按换号方式排好的顺序；从 current 后面一个开始找，
   * 跳过这次故障里试过的和在冷却的。没有时为 null：这时 Lead 的模型切换换格子。
   */
  nextAccount(current: string, candidates: readonly string[]): string | null {
    const start = candidates.indexOf(current);
    const ordered = start < 0 ? candidates : [...candidates.slice(start + 1), ...candidates.slice(0, start)];
    return ordered.find((provider) => provider !== current && this.usable(provider)) ?? null;
  }
}

/** 一种订阅的 provider（不是账号名）。 */
export function isSubscriptionBase(value: string): value is SubscriptionBase {
  return (SUBSCRIPTION_BASES as readonly string[]).includes(value);
}
