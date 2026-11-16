// 设置 → 模型的订阅（模型配置方案 C 的 S2，.scratch/model-config-c/spec.md D1–D7）。操作层的 SubscriptionsService 在 daemon
// 里的实现：页面（GET /v1/models/settings?grouping=1 的 subscriptions、POST /v1/actions/model_settings/models/<操作>）和
// Lead（perform_action）用的是同一个对象。
//
// - 订阅只有 GitHub Copilot（github-copilot）和 Codex（openai-codex）。第一个账号是 pi 自带的 provider，第 n 个是
//   pi-multi-pass（下面写 MS）注册的 <base>-<n>（D4）。账号的名字：第 2 个以后的写进 multi-pass.json 的 label（MS 的格式）；
//   第一个账号 MS 没有地方放名字，存在 daemon 的 kv（BASE_LABELS_KEY）。
// - 凭据在 pi 的 agentDir 的 auth.json，和 Lead、用户自己的 pi 共用（D2）。登录（D3）用一个只为登录建的 ModelRuntime：
//   第 n 个账号在它里面注册成 pi 自带的 <base> 的一份副本（同一个 OAuth 流程，换一个 id），pi 的 login 把凭据按 <base>-<n>
//   存进 auth.json（带 pi 的文件锁）。这样登录不用等 Lead 空下来重新加载扩展；登录好以后再让 Lead 重新加载扩展，MS 注册新的账号。
// - 额度（D6）：只有 Codex 能查（chatgpt.com/backend-api/wham/usage，照 MS:1829-1863 写的小函数）。Copilot 没有额度查询。
// - 一个账号的模型在大脑的分工里时不能删（像删服务商一样）。删掉的账号从 Lead 的 ModelRuntime 里注销。
import { randomUUID } from "node:crypto";
import {
  SUBSCRIPTION_BASES, subscriptionAccountName, subscriptionAccountOf, subscriptionSlotSpec, type Locale,
  type CancelSubscriptionLoginRequest, type RemoveSubscriptionAccountRequest, type RenameSubscriptionAccountRequest,
  type SetSubscriptionScheduleRequest, type SetSubscriptionStrategyRequest, type StartSubscriptionLoginRequest,
  type SubmitSubscriptionLoginCodeRequest, type Subscription, type SubscriptionAccount, type SubscriptionBase,
  type SubscriptionLogin, type SubscriptionQuota, type SubscriptionsDto, type SubscriptionWindow,
} from "@pi-lead-child/protocol";
import {
  createSubscriptionLoginRuntime, leadSubscriptionModels, memberRole, nextSubscriptionIndex, piAgentDir, readMultiPassConfig,
  readSubscriptionCredential, scheduledOrder, subscriptionAccounts, subscriptionPool, syncSubscriptionPool, writeMultiPassConfig,
  type MultiPassConfig, type StoredSubscriptionCredential, type SubscriptionLoginRuntime,
} from "@pi-lead-child/lead";
import {
  UiActionError, type SubscriptionsChange, type SubscriptionsService, type SubscriptionsSummary,
} from "@pi-lead-child/engine";
import { getLocale, leadDisplayName, type Db } from "@pi-lead-child/store";
import { subscriptionMessages } from "./subscriptions.messages.js";

const BASE_LABELS_KEY = "subscriptions.base_labels";
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const QUOTA_TTL_MS = 5 * 60_000;
const QUOTA_TIMEOUT_MS = 15_000;
// 浏览器登录一直等回调：等这么久还没完成就停下。
const LOGIN_TIMEOUT_MS = 15 * 60_000;
// 结束了的登录在 DTO 里再留这么久，页面能显示「登录好了」或者错误。
const FINISHED_LOGIN_TTL_MS = 10 * 60_000;

// 登录要用的那部分 ModelRuntime（测试用假的，规则和真的一样：login 把凭据按 providerId 存下，logout 删掉）。
export type SubscriptionAccountRuntime = SubscriptionLoginRuntime;
export type { StoredSubscriptionCredential };

export interface SubscriptionsLead {
  // 重新加载 Lead 的扩展（server.ts 的 reloadLeadExtensions：Lead 空闲时马上做，正在回答时这一轮结束再做）：MS 按新的
  // multi-pass.json 注册账号、读 pool。
  reloadExtensions(reason: string): void;
  // 账号登录、退出以后：Lead 的 ModelRuntime 重读这些 provider 的凭据。
  refreshAuth(providers: readonly string[]): Promise<void>;
  // 删掉的第 n 个账号从 Lead 的 ModelRuntime 里注销。
  forgetProvider(provider: string): void;
  // pi-multi-pass 装好了（multi-pass-package.ts 设了入口）。
  multiPassLoaded(): boolean;
  // 大脑的分工和「都用不了时问大脑的哪个模型」：删账号时看它们用没用这个账号。
  modelsInUse(): string[];
  // Lead 记的账号冷却（SubscriptionAccountTracker）。
  coolingUntil(provider: string): number | null;
  // Lead 正在回答（新账号要等这一轮结束才注册上）。
  busy(): boolean;
}

export interface SubscriptionsOptions {
  db: Db;
  log: (line: string) => void;
  // 订阅变了：网关发 snapshot.required（resource model-settings）。
  publish: () => void;
  lead: SubscriptionsLead;
  // pi 的 agentDir（auth.json、multi-pass.json）。缺省是 pi 的 getAgentDir()，和 Lead 的 ModelRuntime 读的同一个。
  piAgentDir?: string;
  // 测试注入。缺省是只为登录建的 ModelRuntime（auth.json 同一份，不读写 models.json）。
  runtime?: () => Promise<SubscriptionAccountRuntime>;
  // 测试注入。缺省读 auth.json（pi 的 readStoredCredential）。
  readCredential?: (provider: string) => StoredSubscriptionCredential | undefined;
  fetch?: typeof fetch;
  now?: () => number;
  loginTimeoutMs?: number;
}

interface LoginRecord {
  dto: SubscriptionLogin;
  index: number;
  method: "browser" | "device_code";
  controller: AbortController;
  // 等用户粘贴回调地址（manual_code）。
  waiter: { resolve: (code: string) => void; reject: (error: Error) => void } | null;
  finishedAt: number | null;
  cancelled: boolean;
}

interface QuotaEntry {
  quota: SubscriptionQuota;
  plan: string | null;
  email: string | null;
  at: number;
}

function invalid(message: string): never {
  throw new UiActionError("invalid_input", message);
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Codex 的 access token 里的账号信息（MS 的 getCodexTokenMetadata）。 */
export function codexTokenMetadata(access: string): { accountId: string | null; plan: string | null; email: string | null } {
  const payload = decodeJwtPayload(access);
  const auth = record(payload["https://api.openai.com/auth"]);
  const profile = record(payload["https://api.openai.com/profile"]);
  return {
    accountId: typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : null,
    plan: typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : null,
    email: typeof profile?.email === "string" ? profile.email : null,
  };
}

function windowLabel(seconds: number): string {
  if (Math.abs(seconds - 5 * 3600) <= 120) return "5h";
  if (Math.abs(seconds - 7 * 86_400) <= 120) return "7d";
  if (seconds >= 86_400) return `${Math.round(seconds / 86_400)}d`;
  return `${Math.max(1, Math.round(seconds / 3600))}h`;
}

/** wham/usage 的回答（MS 的 parseCodexUsageSnapshot）：rate_limit 的主、次两个窗口。 */
export function parseCodexUsage(data: unknown): { windows: SubscriptionQuota["windows"]; plan: string | null; email: string | null } {
  const raw = record(data);
  const rateLimit = record(raw?.rate_limit);
  const windows: SubscriptionQuota["windows"] = [];
  for (const key of ["primary_window", "secondary_window"]) {
    const window = record(rateLimit?.[key]);
    if (!window) continue;
    const used = typeof window.used_percent === "number" ? window.used_percent : null;
    const seconds = typeof window.limit_window_seconds === "number" ? window.limit_window_seconds : 0;
    const resetAt = typeof window.reset_at === "number" ? new Date(window.reset_at * 1000).toISOString() : null;
    windows.push({
      label: windowLabel(seconds),
      remainingPercent: used === null ? null : Math.max(0, Math.min(100, 100 - used)),
      resetAt,
    });
  }
  return {
    windows,
    plan: typeof raw?.plan_type === "string" && raw.plan_type !== "unknown" ? raw.plan_type : null,
    email: typeof raw?.email === "string" && raw.email ? raw.email : null,
  };
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

export class Subscriptions implements SubscriptionsService {
  private readonly piAgentDir: string;
  private readonly logins = new Map<string, LoginRecord>();
  private readonly quotas = new Map<string, QuotaEntry>();
  private readonly quotaInFlight = new Set<string>();
  private runtimePromise: Promise<SubscriptionAccountRuntime> | null = null;
  private credentials = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SubscriptionsOptions) {
    this.piAgentDir = options.piAgentDir ?? piAgentDir();
  }

  private locale(): Locale {
    return getLocale(this.options.db);
  }

  private m() {
    return subscriptionMessages(this.locale());
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private runtime(): Promise<SubscriptionAccountRuntime> {
    this.runtimePromise ??= this.options.runtime?.() ?? createSubscriptionLoginRuntime(this.piAgentDir);
    this.runtimePromise.catch(() => { this.runtimePromise = null; });
    return this.runtimePromise;
  }

  private readCredential(provider: string): StoredSubscriptionCredential | undefined {
    if (this.options.readCredential) return this.options.readCredential(provider);
    return readSubscriptionCredential(this.piAgentDir, provider);
  }

  private config(): MultiPassConfig {
    try {
      return readMultiPassConfig(this.piAgentDir);
    } catch (error) {
      invalid(this.m().configUnreadable(shortError(error)));
    }
  }

  private baseLabels(): Partial<Record<SubscriptionBase, string>> {
    const row = this.options.db.prepare("SELECT value FROM kv WHERE key = ?").get(BASE_LABELS_KEY) as { value: string } | undefined;
    try {
      return row ? JSON.parse(row.value) as Partial<Record<SubscriptionBase, string>> : {};
    } catch {
      return {};
    }
  }

  private setBaseLabel(base: SubscriptionBase, label: string | null): void {
    const labels = this.baseLabels();
    if (label) labels[base] = label;
    else delete labels[base];
    this.options.db.prepare(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(BASE_LABELS_KEY, JSON.stringify(labels));
  }

  private async loadCredentials(): Promise<Map<string, string>> {
    try {
      const runtime = await this.runtime();
      this.credentials = new Map((await runtime.listCredentials()).map((entry) => [entry.providerId, entry.type]));
    } catch (error) {
      this.options.log(`[subscriptions] credentials not listed: ${shortError(error)}`);
    }
    return this.credentials;
  }

  private loggedIn(provider: string, credentials = this.credentials): boolean {
    return credentials.get(provider) === "oauth";
  }

  // 一种订阅要列出的账号：登录了的、multi-pass.json 里有的（第 2 个以后），以及起过名字的第一个账号。
  private accountsOf(config: MultiPassConfig, base: SubscriptionBase, credentials = this.credentials) {
    const labels = this.baseLabels();
    return subscriptionAccounts(config, base)
      .map((account) => (account.index === 1 ? { ...account, label: labels[base] ?? null } : account))
      .filter((account) => account.index >= 2 || this.loggedIn(account.provider, credentials) || account.label !== null);
  }

  /** 有账号登录了的订阅（模型目录列出它们的模型，model-config.ts 的 setLeadSubscriptionSource）。 */
  async connectedBases(): Promise<SubscriptionBase[]> {
    const credentials = await this.loadCredentials();
    let config: MultiPassConfig;
    try {
      config = readMultiPassConfig(this.piAgentDir);
    } catch {
      config = { subscriptions: [], pools: [], chains: [], presets: [] };
    }
    return SUBSCRIPTION_BASES.filter((base) =>
      subscriptionAccounts(config, base).some((account) => this.loggedIn(account.provider, credentials)));
  }

  /**
   * D5：current 失败以后这种订阅能换的账号，按换号方式排好（登录了的；不查网络）。MS 在 pi 的重试里自己换账号，
   * daemon 在一轮失败以后用它兜底（server.ts 的 noteLeadModelFailure），再交给 Lead 的 SubscriptionAccountTracker 挑。
   */
  async accountCandidates(base: SubscriptionBase): Promise<string[]> {
    const credentials = await this.loadCredentials();
    let config: MultiPassConfig;
    try {
      config = readMultiPassConfig(this.piAgentDir);
    } catch {
      return [];
    }
    const pool = subscriptionPool(config, base);
    const accounts = subscriptionAccounts(config, base).map((account) => account.provider)
      .filter((provider) => this.loggedIn(provider, credentials));
    const ordered = pool ? [...pool.members.filter((member) => accounts.includes(member)), ...accounts.filter((a) => !pool.members.includes(a))] : accounts;
    if (pool?.strategy === "scheduled") return scheduledOrder(pool, ordered, new Date(this.now()));
    if (pool?.strategy === "quota-first") {
      const worst = (provider: string) => {
        const values = this.quotas.get(provider)?.quota.windows.flatMap((window) => (window.remainingPercent === null ? [] : [window.remainingPercent])) ?? [];
        return values.length ? Math.min(...values) : -1;
      };
      return [...ordered].sort((a, b) => worst(b) - worst(a));
    }
    return ordered;
  }

  // ── 概要（Lead 的 list_actions）和整份 ─────────────────────────────────────────

  summary(): SubscriptionsSummary {
    let config: MultiPassConfig;
    try {
      config = readMultiPassConfig(this.piAgentDir);
    } catch {
      config = { subscriptions: [], pools: [], chains: [], presets: [] };
    }
    return {
      subscriptions: SUBSCRIPTION_BASES.map((base) => ({
        base,
        accounts: this.accountsOf(config, base).map((account) => ({
          provider: account.provider, label: account.label, loggedIn: this.loggedIn(account.provider),
        })),
        strategy: subscriptionPool(config, base)?.strategy ?? "round-robin",
      })),
      logins: [...this.logins.values()].filter((login) => login.finishedAt === null)
        .map((login) => ({ id: login.dto.id, provider: login.dto.provider, state: login.dto.state })),
    };
  }

  async get(): Promise<SubscriptionsDto> {
    this.pruneLogins();
    const credentials = await this.loadCredentials();
    let config: MultiPassConfig;
    try {
      config = readMultiPassConfig(this.piAgentDir);
    } catch (error) {
      this.options.log(`[subscriptions] multi-pass.json unreadable: ${shortError(error)}`);
      config = { subscriptions: [], pools: [], chains: [], presets: [] };
    }
    const inUse = this.options.lead.modelsInUse();
    const subscriptions: Subscription[] = SUBSCRIPTION_BASES.map((base) => {
      const pool = subscriptionPool(config, base);
      const accounts = this.accountsOf(config, base, credentials);
      const loggedInAccounts = accounts.filter((account) => this.loggedIn(account.provider, credentials));
      const dtoAccounts: SubscriptionAccount[] = accounts.map((account) => {
        const loggedIn = this.loggedIn(account.provider, credentials);
        const identity = loggedIn ? this.identity(base, account.provider) : { plan: null, email: null };
        const quota = loggedIn && base === "openai-codex" ? this.quotaFor(account.provider) : null;
        const cooling = this.options.lead.coolingUntil(account.provider);
        return {
          provider: account.provider, index: account.index, label: account.label, loggedIn,
          email: quota?.email ?? identity.email, plan: quota?.plan ?? identity.plan, quota: quota?.quota ?? null,
          coolingUntil: cooling === null ? null : new Date(cooling).toISOString(),
          role: memberRole(pool, account.provider),
          windows: pool?.memberSchedule?.[account.provider]?.windows ?? [],
          inUse: this.usedBy(account.provider, loggedInAccounts.map((candidate) => candidate.provider), inUse).length > 0,
        };
      });
      return {
        base,
        accounts: dtoAccounts,
        strategy: pool?.strategy ?? "round-robin",
        quotaSupported: base === "openai-codex",
        models: loggedInAccounts.length === 0 ? [] : leadSubscriptionModels(base).map((model) => ({
          model: `${model.provider}/${model.id}`, id: model.id, name: model.name, image: model.input.includes("image"),
          contextWindow: model.contextWindow, efforts: model.efforts,
        })),
      };
    });
    return {
      subscriptions,
      logins: [...this.logins.values()].map((login) => ({ ...login.dto })),
      multiPass: this.options.lead.multiPassLoaded(),
    };
  }

  // 账号的套餐和邮箱：Codex 的 access token 里有（不联网）。Copilot 没有。
  private identity(base: SubscriptionBase, provider: string): { plan: string | null; email: string | null } {
    const credential = this.readCredential(provider);
    if (base !== "openai-codex" || typeof credential?.access !== "string") {
      return { plan: null, email: typeof credential?.email === "string" ? credential.email : null };
    }
    const meta = codexTokenMetadata(credential.access);
    return { plan: meta.plan, email: typeof credential.email === "string" ? credential.email : meta.email };
  }

  // 这个账号在分工里的模型：直接写了它的（<base>-<n>/<id>），以及它是这种订阅最后一个登录了的账号时写 <base>/<id> 的。
  private usedBy(provider: string, loggedInAccounts: readonly string[], specs: readonly string[]): string[] {
    const account = subscriptionAccountOf(provider);
    if (!account) return [];
    const others = loggedInAccounts.filter((candidate) => candidate !== provider);
    return specs.filter((spec) => {
      const slash = spec.indexOf("/");
      const specProvider = slash > 0 ? spec.slice(0, slash) : spec;
      if (specProvider === provider) return true;
      return others.length === 0 && subscriptionSlotSpec(spec).startsWith(`${account.base}/`);
    });
  }

  // ── 额度（D6，只有 Codex）──────────────────────────────────────────────────────

  private quotaFor(provider: string): QuotaEntry | null {
    const cached = this.quotas.get(provider) ?? null;
    if (!cached || this.now() - cached.at > QUOTA_TTL_MS) this.refreshQuota(provider);
    return cached;
  }

  private refreshQuota(provider: string): void {
    if (this.quotaInFlight.has(provider)) return;
    this.quotaInFlight.add(provider);
    void this.checkCodexQuota(provider).then((entry) => {
      if (entry) {
        this.quotas.set(provider, entry);
        this.options.publish();
      }
    }).catch((error) => this.options.log(`[subscriptions] quota of ${provider} not read: ${shortError(error)}`))
      .finally(() => this.quotaInFlight.delete(provider));
  }

  /** 查一个 Codex 账号的额度（MS:1829-1863）。没登录时为 null。出错时 problem 写原因，不抛错。 */
  async checkCodexQuota(provider: string): Promise<QuotaEntry | null> {
    const credential = this.readCredential(provider);
    if (credential?.type !== "oauth" || typeof credential.access !== "string" || !credential.access) return null;
    const meta = codexTokenMetadata(credential.access);
    const at = this.now();
    const checkedAt = new Date(at).toISOString();
    const fallback = { plan: meta.plan, email: typeof credential.email === "string" ? credential.email : meta.email };
    if (typeof credential.expires === "number" && credential.expires <= at + 60_000) {
      return { quota: { windows: [], checkedAt, problem: this.m().tokenExpired }, ...fallback, at };
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credential.access}`, Accept: "application/json", "User-Agent": "pi-lead-child",
    };
    const accountId = credential.accountId ?? meta.accountId;
    if (accountId) headers["chatgpt-account-id"] = accountId;
    try {
      const response = await (this.options.fetch ?? fetch)(CODEX_USAGE_URL, {
        method: "GET", headers, signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS),
      });
      if (!response.ok) {
        return { quota: { windows: [], checkedAt, problem: this.m().quotaFailed(`HTTP ${response.status}`) }, ...fallback, at };
      }
      const usage = parseCodexUsage(await response.json());
      return {
        quota: { windows: usage.windows, checkedAt, problem: null },
        plan: usage.plan ?? fallback.plan, email: usage.email ?? fallback.email, at,
      };
    } catch (error) {
      return { quota: { windows: [], checkedAt, problem: this.m().quotaFailed(shortError(error)) }, ...fallback, at };
    }
  }

  // ── 登录（D3）──────────────────────────────────────────────────────────────────

  private pruneLogins(): void {
    const now = this.now();
    for (const [id, login] of this.logins) {
      if (login.finishedAt !== null && now - login.finishedAt > FINISHED_LOGIN_TTL_MS) this.logins.delete(id);
    }
  }

  private activeLogin(predicate: (login: LoginRecord) => boolean): LoginRecord | undefined {
    return [...this.logins.values()].find((login) => login.finishedAt === null && predicate(login));
  }

  private finish(login: LoginRecord, state: SubscriptionLogin["state"], error: string | null = null): void {
    if (login.finishedAt !== null) return;
    login.finishedAt = this.now();
    login.dto = { ...login.dto, state, awaitingCode: false, error };
    login.waiter?.reject(new Error(state));
    login.waiter = null;
  }

  // 第 n 个账号在登录用的 ModelRuntime 里是 pi 自带的 <base> 的一份副本：同一个 OAuth 流程，凭据按 <base>-<n> 存。
  private async accountRuntime(provider: string): Promise<SubscriptionAccountRuntime> {
    const runtime = await this.runtime();
    const account = subscriptionAccountOf(provider);
    if (account && account.index >= 2 && !runtime.getProvider(provider)) {
      const base = runtime.getProvider(account.base);
      if (!base) throw new Error(`pi has no built-in provider ${account.base}`);
      runtime.registerNativeProvider({ ...base, id: provider, name: `${base.name} #${account.index}` });
    }
    return runtime;
  }

  startLogin(request: StartSubscriptionLoginRequest): Promise<SubscriptionsChange> {
    return this.serial(async () => {
      const m = this.m();
      this.pruneLogins();
      const config = this.config();
      const credentials = await this.loadCredentials();
      let index: number;
      if (request.provider) {
        const account = subscriptionAccountOf(request.provider);
        if (!account || account.base !== request.base) invalid(m.wrongBase(request.provider, request.base));
        const known = account.index === 1 || config.subscriptions.some((entry) => entry.provider === request.base && entry.index === account.index);
        if (!known) throw new UiActionError("not_found", m.noAccount(request.provider));
        index = account.index;
      } else {
        const reserved = [...this.logins.values()].filter((login) => login.finishedAt === null && login.dto.base === request.base)
          .map((login) => login.index);
        index = !this.loggedIn(request.base, credentials) && !reserved.includes(1) ? 1 : nextSubscriptionIndex(config, request.base, reserved);
      }
      const notes: string[] = [];
      // 同一种订阅同时只登录一个账号（Codex 的浏览器登录占用本机 1455 端口）。
      const open = this.activeLogin((login) => login.dto.base === request.base);
      if (open) {
        open.cancelled = true;
        open.controller.abort(new Error("replaced"));
        this.finish(open, "cancelled");
        notes.push(m.loginReplaced(open.dto.provider));
      }
      if (index >= 2 && !this.options.lead.multiPassLoaded()) notes.push(m.multiPassMissing);
      const provider = subscriptionAccountName(request.base, index);
      const label = request.label?.trim() || null;
      const login: LoginRecord = {
        dto: {
          id: randomUUID(), base: request.base, provider, label, state: "starting", authUrl: null, deviceCode: null,
          awaitingCode: false, progress: null, error: null, startedAt: new Date(this.now()).toISOString(),
        },
        index, method: request.method ?? "browser", controller: new AbortController(), waiter: null, finishedAt: null, cancelled: false,
      };
      this.logins.set(login.dto.id, login);
      void this.runLogin(login);
      this.options.publish();
      this.options.log(`[subscriptions] login started for ${provider}`);
      return { summary: m.loginStarted(provider), note: notes.length ? notes.join(" ") : null, login: login.dto.id };
    });
  }

  private async runLogin(login: LoginRecord): Promise<void> {
    const m = this.m();
    const signal = login.controller.signal;
    const timeout = setTimeout(() => login.controller.abort(new Error("timeout")), this.options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS);
    timeout.unref?.();
    const update = (patch: Partial<SubscriptionLogin>) => {
      if (login.finishedAt !== null) return;
      login.dto = { ...login.dto, ...patch };
      this.options.publish();
    };
    try {
      const runtime = await this.accountRuntime(login.dto.provider);
      await runtime.login(login.dto.provider, "oauth", {
        signal,
        notify: (event) => {
          if (event.type === "auth_url") update({ state: "waiting", authUrl: event.url });
          else if (event.type === "device_code") {
            update({
              state: "waiting",
              deviceCode: {
                code: event.userCode, uri: event.verificationUri,
                expiresAt: event.expiresInSeconds ? new Date(this.now() + event.expiresInSeconds * 1000).toISOString() : null,
              },
            });
          } else if (event.type === "progress" || event.type === "info") update({ progress: event.message.slice(0, 300) });
        },
        prompt: async (prompt) => {
          // Codex 先问登录方式：缺省浏览器登录（D3），手机上可以选设备码。
          if (prompt.type === "select") {
            return prompt.options.find((option) => option.id === login.method)?.id ?? prompt.options[0]?.id ?? "";
          }
          // Copilot 先问 GitHub Enterprise 的地址：空的是 github.com。
          if (prompt.type === "text") return "";
          if (prompt.type === "manual_code") {
            return new Promise<string>((resolve, reject) => {
              const abort = () => reject(new Error("aborted"));
              signal.addEventListener("abort", abort, { once: true });
              prompt.signal?.addEventListener("abort", () => {
                // 浏览器的回调先到了：不再等粘贴。
                if (login.waiter) {
                  login.waiter = null;
                  update({ awaitingCode: false });
                }
                abort();
              }, { once: true });
              login.waiter = { resolve, reject };
              update({ state: "waiting", awaitingCode: true });
            });
          }
          throw new Error(m.unexpectedPrompt(prompt.message));
        },
      });
      await this.loginSucceeded(login);
    } catch (error) {
      if (login.cancelled) this.finish(login, "cancelled");
      else if (signal.aborted && (signal.reason as Error | undefined)?.message === "timeout") this.finish(login, "error", m.loginTimedOut);
      else this.finish(login, "error", shortError(error));
      this.options.log(`[subscriptions] login for ${login.dto.provider} ended: ${login.dto.state}`);
      this.options.publish();
    } finally {
      clearTimeout(timeout);
    }
  }

  private async loginSucceeded(login: LoginRecord): Promise<void> {
    const { base, provider, label } = login.dto;
    await this.serial(async () => {
      if (login.index >= 2) {
        const config = readMultiPassConfig(this.piAgentDir);
        const existing = config.subscriptions.find((entry) => entry.provider === base && entry.index === login.index);
        const subscriptions = existing
          ? config.subscriptions.map((entry) => (entry === existing && label ? { ...entry, label } : entry))
          : [...config.subscriptions, { provider: base, index: login.index, ...(label ? { label } : {}) }];
        writeMultiPassConfig(this.piAgentDir, syncSubscriptionPool({ ...config, subscriptions }, base as SubscriptionBase));
      } else if (label) {
        this.setBaseLabel(base as SubscriptionBase, label);
      }
    });
    this.quotas.delete(provider);
    this.finish(login, "done");
    this.options.log(`[subscriptions] ${provider} logged in`);
    try {
      await this.options.lead.refreshAuth([provider]);
    } catch (error) {
      this.options.log(`[subscriptions] Lead did not reread the credentials of ${provider}: ${shortError(error)}`);
    }
    // 第 2 个以后的账号：MS 在 Lead 重新加载扩展时注册它，pool 也重新读。
    if (login.index >= 2) this.options.lead.reloadExtensions(`subscription account ${provider} added`);
    await this.loadCredentials();
    this.options.publish();
  }

  async submitLoginCode(request: SubmitSubscriptionLoginCodeRequest): Promise<SubscriptionsChange> {
    const m = this.m();
    const login = this.activeLogin((candidate) => candidate.dto.id === request.login);
    if (!login) throw new UiActionError("not_found", m.noLogin(request.login));
    if (!login.waiter) invalid(m.notWaitingForCode);
    const waiter = login.waiter;
    login.waiter = null;
    login.dto = { ...login.dto, awaitingCode: false, progress: null };
    waiter.resolve(request.code.trim());
    this.options.publish();
    return { summary: m.codeSubmitted(login.dto.provider) };
  }

  async cancelLogin(request: CancelSubscriptionLoginRequest): Promise<SubscriptionsChange> {
    const m = this.m();
    const login = this.activeLogin((candidate) => candidate.dto.id === request.login);
    if (!login) throw new UiActionError("not_found", m.noLogin(request.login));
    login.cancelled = true;
    login.controller.abort(new Error("cancelled"));
    this.finish(login, "cancelled");
    this.options.publish();
    return { summary: m.loginCancelled(login.dto.provider) };
  }

  // ── 账号 ────────────────────────────────────────────────────────────────────

  private knownAccount(config: MultiPassConfig, provider: string): { base: SubscriptionBase; index: number } {
    const account = subscriptionAccountOf(provider);
    const known = account && (account.index === 1
      ? this.loggedIn(provider) || this.baseLabels()[account.base] !== undefined
      : config.subscriptions.some((entry) => entry.provider === account.base && entry.index === account.index));
    if (!account || !known) throw new UiActionError("not_found", this.m().noAccount(provider));
    return account;
  }

  removeAccount(request: RemoveSubscriptionAccountRequest): Promise<SubscriptionsChange> {
    return this.serial(async () => {
      const m = this.m();
      const credentials = await this.loadCredentials();
      const config = this.config();
      const account = this.knownAccount(config, request.provider);
      const loggedIn = subscriptionAccounts(config, account.base).map((candidate) => candidate.provider)
        .filter((provider) => this.loggedIn(provider, credentials));
      const used = this.usedBy(request.provider, loggedIn, this.options.lead.modelsInUse());
      if (used.length) invalid(m.accountInUse(used));
      const open = this.activeLogin((login) => login.dto.provider === request.provider);
      if (open) {
        open.cancelled = true;
        open.controller.abort(new Error("cancelled"));
        this.finish(open, "cancelled");
      }
      if (this.loggedIn(request.provider, credentials)) {
        const runtime = await this.accountRuntime(request.provider);
        await runtime.logout(request.provider);
      }
      if (account.index >= 2) {
        const subscriptions = config.subscriptions.filter((entry) => !(entry.provider === account.base && entry.index === account.index));
        writeMultiPassConfig(this.piAgentDir, syncSubscriptionPool({ ...config, subscriptions }, account.base));
        this.options.lead.forgetProvider(request.provider);
        this.options.lead.reloadExtensions(`subscription account ${request.provider} removed`);
      } else {
        this.setBaseLabel(account.base, null);
      }
      this.quotas.delete(request.provider);
      try {
        await this.options.lead.refreshAuth([request.provider]);
      } catch (error) {
        this.options.log(`[subscriptions] Lead did not reread the credentials of ${request.provider}: ${shortError(error)}`);
      }
      await this.loadCredentials();
      this.options.publish();
      this.options.log(`[subscriptions] ${request.provider} removed`);
      return { summary: m.accountRemoved(request.provider) };
    });
  }

  renameAccount(request: RenameSubscriptionAccountRequest): Promise<SubscriptionsChange> {
    return this.serial(async () => {
      const m = this.m();
      await this.loadCredentials();
      const config = this.config();
      const account = this.knownAccount(config, request.provider);
      const label = request.label.trim();
      if (!label) invalid(m.emptyLabel);
      if (account.index >= 2) {
        writeMultiPassConfig(this.piAgentDir, {
          ...config,
          subscriptions: config.subscriptions.map((entry) =>
            (entry.provider === account.base && entry.index === account.index ? { ...entry, label } : entry)),
        });
      } else {
        this.setBaseLabel(account.base, label);
      }
      this.options.publish();
      return { summary: m.renamed(request.provider, label) };
    });
  }

  setStrategy(request: SetSubscriptionStrategyRequest): Promise<SubscriptionsChange> {
    return this.serial(async () => {
      const m = this.m();
      let config = this.config();
      if (!subscriptionPool(config, request.base)) {
        config = syncSubscriptionPool(config, request.base);
        if (!subscriptionPool(config, request.base)) invalid(m.strategyNeedsAccounts(request.base));
      }
      const pool = subscriptionPool(config, request.base)!;
      writeMultiPassConfig(this.piAgentDir, {
        ...config, pools: config.pools.map((candidate) => (candidate === pool ? { ...pool, strategy: request.strategy } : candidate)),
      });
      this.options.lead.reloadExtensions(`subscription strategy of ${request.base} changed`);
      this.options.publish();
      return { summary: m.strategySet(request.base, request.strategy), note: this.afterTurnNote() };
    });
  }

  setSchedule(request: SetSubscriptionScheduleRequest): Promise<SubscriptionsChange> {
    return this.serial(async () => {
      const m = this.m();
      await this.loadCredentials();
      let config = this.config();
      const account = this.knownAccount(config, request.provider);
      for (const window of request.windows) {
        if (!window.hours && !window.days?.length && !window.dateRange?.from && !window.dateRange?.to) invalid(m.badWindow);
      }
      if (!subscriptionPool(config, account.base)) config = syncSubscriptionPool(config, account.base);
      const pool = subscriptionPool(config, account.base);
      if (!pool) invalid(m.strategyNeedsAccounts(account.base));
      const schedule = { ...pool.memberSchedule };
      if (request.role === "default" && request.windows.length === 0) delete schedule[request.provider];
      else {
        schedule[request.provider] = {
          ...(request.role === "default" ? {} : { role: request.role }),
          windows: request.windows.map((window): SubscriptionWindow => ({ ...window })),
        };
      }
      writeMultiPassConfig(this.piAgentDir, {
        ...config, pools: config.pools.map((candidate) => (candidate === pool ? { ...pool, memberSchedule: schedule } : candidate)),
      });
      this.options.lead.reloadExtensions(`subscription schedule of ${request.provider} changed`);
      this.options.publish();
      const notes = [this.afterTurnNote(), pool.strategy === "scheduled" ? null : m.scheduleNeedsStrategy].filter(Boolean);
      return { summary: m.scheduleSet(request.provider, request.role, request.windows.length), note: notes.length ? notes.join(" ") : null };
    });
  }

  private afterTurnNote(): string | null {
    return this.options.lead.busy() ? this.m().afterTurn(leadDisplayName(this.options.db)) : null;
  }

  /** daemon 停下时：取消还没完成的登录（Codex 的回调服务器占着端口）。 */
  stop(): void {
    for (const login of this.logins.values()) {
      if (login.finishedAt !== null) continue;
      login.cancelled = true;
      login.controller.abort(new Error("cancelled"));
      this.finish(login, "cancelled");
    }
  }
}
