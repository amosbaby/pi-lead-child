// 设置 → 模型的订阅（模型配置方案 C 的 S2，src/subscriptions.ts）：登录（Codex 浏览器登录和粘贴回调地址、Copilot 设备码）、
// 账号的增删改、换号方式和时间段（pi-multi-pass 的 multi-pass.json），以及 Codex 的额度（D6）。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { tempDir } from "@pi-lead-child/core/testing";
import { UiActionError } from "@pi-lead-child/engine";
import { leadSubscriptionModels } from "@pi-lead-child/lead";
import { SubscriptionsDtoSchema, type SubscriptionsDto } from "@pi-lead-child/protocol";
import { openDb } from "@pi-lead-child/store";
import {
  CODEX_USAGE_URL, codexTokenMetadata, parseCodexUsage, Subscriptions, type StoredSubscriptionCredential,
  type SubscriptionAccountRuntime,
} from "../src/subscriptions.js";

// 假的 Codex access token（JWT 的形状，签名是假的）。
function fakeCodexToken(claims: { email?: string; plan?: string; account?: string } = {}): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [encode({ alg: "none" }), encode({
    "https://api.openai.com/auth": { chatgpt_account_id: claims.account ?? "acct-1", chatgpt_plan_type: claims.plan ?? "plus" },
    "https://api.openai.com/profile": { email: claims.email ?? "alice@example.com" },
  }), "sig"].join(".");
}

type Interaction = Parameters<SubscriptionAccountRuntime["login"]>[2];

// 和 pi 的 ModelRuntime 同样的规则：login 要 provider 已经注册（pi 的 Models.login 报 Unknown provider），
// 凭据按 providerId 存下；listCredentials 只给 provider 和种类；logout 删掉。流程照 pi-ai 的 openai-codex、github-copilot：
// Codex 先问登录方式（select），浏览器登录给 auth_url，再等回调或者粘贴（manual_code）；Copilot 先问 Enterprise 地址（text），再给设备码。
function fakeRuntime() {
  const providers = new Set(["openai-codex", "github-copilot"]);
  const store = new Map<string, StoredSubscriptionCredential>();
  const copilotApprovals: Array<() => void> = [];
  const prompts: string[] = [];
  const runtime: SubscriptionAccountRuntime = {
    getProvider: (id) => (providers.has(id) ? ({ id, name: id === "openai-codex" ? "OpenAI (ChatGPT Plus/Pro)" : "GitHub Copilot", auth: {} } as never) : undefined),
    registerNativeProvider: (provider) => { providers.add((provider as { id: string }).id); },
    login: async (providerId, _type, interaction: Interaction) => {
      if (!providers.has(providerId)) throw new Error(`Unknown provider: ${providerId}`);
      const signal = interaction.signal!;
      const aborted = () => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true }));
      if (providerId.startsWith("openai-codex")) {
        const method = await interaction.prompt({
          type: "select", message: "Select OpenAI Codex login method:",
          options: [{ id: "browser", label: "Browser login (default)" }, { id: "device_code", label: "Device code login (headless)" }],
        });
        prompts.push(`select:${method}`);
        interaction.notify({ type: "auth_url", url: "https://auth.example.com/oauth/authorize?state=s1", instructions: "Open it" });
        const pasted = await Promise.race([
          interaction.prompt({ type: "manual_code", message: "Paste the authorization code", placeholder: "http://localhost:1455/auth/callback" }),
          aborted(),
        ]);
        if (!pasted.includes("code=")) throw new Error("Missing authorization code");
        const credential = { type: "oauth", access: fakeCodexToken(), refresh: "r", expires: Date.now() + 3_600_000 };
        store.set(providerId, credential);
        return credential as never;
      }
      const domain = await interaction.prompt({ type: "text", message: "GitHub Enterprise URL/domain (blank for github.com)" });
      prompts.push(`text:${JSON.stringify(domain)}`);
      interaction.notify({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresInSeconds: 900 });
      await Promise.race([new Promise<void>((resolve) => copilotApprovals.push(resolve)), aborted()]);
      interaction.notify({ type: "progress", message: "Enabling models..." });
      const credential = { type: "oauth", access: "copilot-token", refresh: "r", expires: Date.now() + 3_600_000 };
      store.set(providerId, credential);
      return credential as never;
    },
    logout: async (providerId) => { store.delete(providerId); },
    listCredentials: async () => [...store.entries()].map(([providerId, credential]) => ({
      providerId, type: credential.type === "api_key" ? "api_key" as const : "oauth" as const,
    })),
  };
  return { runtime, store, providers, prompts, approveCopilot: () => copilotApprovals.shift()?.() };
}

// pi 自带目录里 Codex 的第一个模型。不写死 id：pi 升级时目录会换（1.5.2 没有 gpt-5.5）。
const CODEX = leadSubscriptionModels("openai-codex")[0]!.id;
const instances: Subscriptions[] = [];
afterEach(() => {
  for (const instance of instances.splice(0)) instance.stop();
});

function setup(options: { chain?: string[]; busy?: boolean; fetch?: typeof fetch; config?: unknown } = {}) {
  const dir = tempDir("plc-subscriptions-");
  const piAgentDir = join(dir, "pi-agent");
  const db = openDb(join(dir, "plc.db"));
  if (options.config) {
    mkdirSync(piAgentDir, { recursive: true });
    writeFileSync(join(piAgentDir, "multi-pass.json"), JSON.stringify(options.config));
  }
  const fake = fakeRuntime();
  const calls = { reload: [] as string[], refresh: [] as string[][], forget: [] as string[], publish: 0 };
  const service = new Subscriptions({
    db, log: () => {}, publish: () => { calls.publish += 1; }, piAgentDir,
    runtime: async () => fake.runtime,
    readCredential: (provider) => fake.store.get(provider),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    lead: {
      reloadExtensions: (reason) => { calls.reload.push(reason); },
      refreshAuth: async (providers) => { calls.refresh.push([...providers]); },
      forgetProvider: (provider) => { calls.forget.push(provider); },
      multiPassLoaded: () => true,
      modelsInUse: () => options.chain ?? [],
      coolingUntil: () => null,
      busy: () => options.busy ?? false,
    },
  });
  instances.push(service);
  const multiPass = () => JSON.parse(readFileSync(join(piAgentDir, "multi-pass.json"), "utf8"));
  return { service, fake, calls, piAgentDir, multiPass, db };
}

async function loginOf(service: Subscriptions, id: string) {
  return (await service.get()).logins.find((login) => login.id === id)!;
}

function check(dto: SubscriptionsDto): SubscriptionsDto {
  expect(Value.Check(SubscriptionsDtoSchema, dto), JSON.stringify([...Value.Errors(SubscriptionsDtoSchema, dto)].slice(0, 3))).toBe(true);
  return dto;
}

describe("logging in to a Codex account in the browser (D3)", () => {
  it("shows the login address, takes the pasted redirect address, stores the credential and names the account", async () => {
    const { service, fake, calls } = setup();
    const started = await service.startLogin({ base: "openai-codex", label: "Work" });
    expect(started.login).toBeTruthy();
    await vi.waitFor(async () => expect((await loginOf(service, started.login!)).awaitingCode).toBe(true));
    const waiting = await loginOf(service, started.login!);
    expect(waiting).toMatchObject({
      provider: "openai-codex", state: "waiting", authUrl: "https://auth.example.com/oauth/authorize?state=s1", label: "Work",
    });
    expect(fake.prompts).toEqual(["select:browser"]);

    await service.submitLoginCode({ login: started.login!, code: "http://localhost:1455/auth/callback?code=abc&state=s1" });
    await vi.waitFor(async () => expect((await loginOf(service, started.login!)).state).toBe("done"));
    expect(fake.store.has("openai-codex")).toBe(true);
    expect(calls.refresh).toEqual([["openai-codex"]]);
    // 第一个账号是 pi 自带的 provider：不用 pi-multi-pass 重新注册。
    expect(calls.reload).toEqual([]);
    const dto = check(await service.get());
    const codex = dto.subscriptions.find((subscription) => subscription.base === "openai-codex")!;
    expect(codex.accounts).toMatchObject([{
      provider: "openai-codex", index: 1, label: "Work", loggedIn: true, email: "alice@example.com", plan: "plus", inUse: false,
    }]);
    expect(codex.models.some((model) => model.model === `openai-codex/${CODEX}`)).toBe(true);
    expect(codex.quotaSupported).toBe(true);
    expect(dto.subscriptions.find((subscription) => subscription.base === "github-copilot")).toMatchObject({ accounts: [], models: [] });
  });

  it("adds a second account as <base>-2 in multi-pass.json with a pool, and has Lead reload pi-multi-pass", async () => {
    const { service, fake, calls, multiPass } = setup();
    fake.store.set("openai-codex", { type: "oauth", access: fakeCodexToken(), expires: Date.now() + 3_600_000 });
    const started = await service.startLogin({ base: "openai-codex", label: "Home", method: "device_code" });
    await vi.waitFor(async () => expect((await loginOf(service, started.login!)).awaitingCode).toBe(true));
    expect(fake.prompts).toEqual(["select:device_code"]);
    // 登录用的 ModelRuntime 里注册了 pi 自带的 openai-codex 的副本，凭据按 openai-codex-2 存。
    expect(fake.providers.has("openai-codex-2")).toBe(true);
    await service.submitLoginCode({ login: started.login!, code: "code=xyz" });
    await vi.waitFor(async () => expect((await loginOf(service, started.login!)).state).toBe("done"));
    expect(fake.store.has("openai-codex-2")).toBe(true);
    expect(multiPass()).toMatchObject({
      subscriptions: [{ provider: "openai-codex", index: 2, label: "Home" }],
      pools: [{ name: "openai-codex", baseProvider: "openai-codex", members: ["openai-codex", "openai-codex-2"], enabled: true, strategy: "round-robin" }],
    });
    expect(calls.reload).toEqual(["subscription account openai-codex-2 added"]);
    expect(calls.refresh).toEqual([["openai-codex-2"]]);
    const codex = check(await service.get()).subscriptions[0]!;
    expect(codex.accounts.map((account) => [account.provider, account.label])).toEqual([["openai-codex", null], ["openai-codex-2", "Home"]]);
  });

  it("refuses a pasted address while the login does not wait for one, and a login that does not exist", async () => {
    const { service } = setup();
    await expect(service.submitLoginCode({ login: "nope", code: "code=1" })).rejects.toMatchObject({ code: "not_found" });
    const started = await service.startLogin({ base: "github-copilot" });
    await vi.waitFor(async () => expect((await loginOf(service, started.login!)).deviceCode).not.toBeNull());
    await expect(service.submitLoginCode({ login: started.login!, code: "code=1" })).rejects.toBeInstanceOf(UiActionError);
  });
});

describe("logging in to a Copilot account with a device code", () => {
  it("answers the Enterprise question with github.com and shows the code until GitHub approves it", async () => {
    const { service, fake } = setup();
    const started = await service.startLogin({ base: "github-copilot", label: "Personal" });
    await vi.waitFor(async () => expect((await loginOf(service, started.login!)).deviceCode).not.toBeNull());
    const waiting = await loginOf(service, started.login!);
    expect(fake.prompts).toEqual(['text:""']);
    expect(waiting.deviceCode).toMatchObject({ code: "ABCD-1234", uri: "https://github.com/login/device" });
    expect(Date.parse(waiting.deviceCode!.expiresAt!)).toBeGreaterThan(Date.now());
    fake.approveCopilot();
    await vi.waitFor(async () => expect((await loginOf(service, started.login!)).state).toBe("done"));
    const copilot = check(await service.get()).subscriptions.find((subscription) => subscription.base === "github-copilot")!;
    expect(copilot).toMatchObject({ quotaSupported: false, accounts: [{ provider: "github-copilot", label: "Personal", loggedIn: true, quota: null }] });
  });
});

describe("cancelling a login", () => {
  it("stops the flow without a credential, and a new login for the same subscription replaces an open one", async () => {
    const { service, fake } = setup();
    const first = await service.startLogin({ base: "openai-codex" });
    await vi.waitFor(async () => expect((await loginOf(service, first.login!)).awaitingCode).toBe(true));
    const second = await service.startLogin({ base: "openai-codex" });
    expect(second.note).toContain("openai-codex");
    expect((await loginOf(service, first.login!)).state).toBe("cancelled");
    await vi.waitFor(async () => expect((await loginOf(service, second.login!)).awaitingCode).toBe(true));
    await service.cancelLogin({ login: second.login! });
    await vi.waitFor(async () => expect((await loginOf(service, second.login!)).state).toBe("cancelled"));
    expect(fake.store.size).toBe(0);
    await expect(service.cancelLogin({ login: second.login! })).rejects.toMatchObject({ code: "not_found" });
  });

  it("ends a login that takes too long", async () => {
    const dir = tempDir("plc-subscriptions-");
    const fake = fakeRuntime();
    const service = new Subscriptions({
      db: openDb(join(dir, "plc.db")), log: () => {}, publish: () => {}, piAgentDir: join(dir, "pi"), loginTimeoutMs: 30,
      runtime: async () => fake.runtime, readCredential: (provider) => fake.store.get(provider),
      lead: {
        reloadExtensions: () => {}, refreshAuth: async () => {}, forgetProvider: () => {}, multiPassLoaded: () => true,
        modelsInUse: () => [], coolingUntil: () => null, busy: () => false,
      },
    });
    instances.push(service);
    const started = await service.startLogin({ base: "github-copilot" });
    await vi.waitFor(async () => expect((await loginOf(service, started.login!)).state).toBe("error"));
    expect((await loginOf(service, started.login!)).error).toMatch(/too long/);
  });
});

describe("removing, renaming and pooling accounts", () => {
  const twoAccounts = {
    subscriptions: [{ provider: "openai-codex", index: 2, label: "Home" }],
    pools: [{ name: "openai-codex", baseProvider: "openai-codex", members: ["openai-codex", "openai-codex-2"], enabled: true }],
    chains: [], presets: [], statusBar: false,
  };

  it("refuses to remove the last logged-in account of a subscription whose models are in the chain", async () => {
    const { service, fake } = setup({ chain: [`openai-codex/${CODEX}`] });
    fake.store.set("openai-codex", { type: "oauth", access: fakeCodexToken() });
    await service.get();
    await expect(service.removeAccount({ provider: "openai-codex" })).rejects.toThrow(new RegExp(CODEX.replace(/[.]/g, "\\.")));
    expect(fake.store.has("openai-codex")).toBe(true);
    expect(check(await service.get()).subscriptions[0]!.accounts[0]!.inUse).toBe(true);
  });

  it("removes a second account: logs it out, drops it from multi-pass.json and the pool, and unregisters it in Lead", async () => {
    const { service, fake, calls, multiPass } = setup({ chain: [`openai-codex/${CODEX}`], config: twoAccounts });
    fake.store.set("openai-codex", { type: "oauth", access: fakeCodexToken() });
    fake.store.set("openai-codex-2", { type: "oauth", access: fakeCodexToken({ email: "bob@example.com" }) });
    const result = await service.removeAccount({ provider: "openai-codex-2" });
    expect(result.summary).toContain("openai-codex-2");
    expect(fake.store.has("openai-codex-2")).toBe(false);
    expect(multiPass()).toMatchObject({ subscriptions: [], pools: [{ members: ["openai-codex"] }], statusBar: false });
    expect(calls.forget).toEqual(["openai-codex-2"]);
    expect(calls.reload).toEqual(["subscription account openai-codex-2 removed"]);
    await expect(service.removeAccount({ provider: "openai-codex-5" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("renames accounts, sets the strategy and an account's schedule in multi-pass.json", async () => {
    const { service, fake, multiPass, calls } = setup({ config: twoAccounts, busy: true });
    fake.store.set("openai-codex", { type: "oauth", access: fakeCodexToken() });
    fake.store.set("openai-codex-2", { type: "oauth", access: fakeCodexToken() });
    await service.renameAccount({ provider: "openai-codex-2", label: "Personal" });
    await service.renameAccount({ provider: "openai-codex", label: "Work" });
    expect(multiPass().subscriptions).toEqual([{ provider: "openai-codex", index: 2, label: "Personal" }]);
    const strategy = await service.setStrategy({ base: "openai-codex", strategy: "scheduled" });
    // Lead 正在回答：pi-multi-pass 这一轮结束以后才重新读 pool。
    expect(strategy.note).toBeTruthy();
    await service.setSchedule({ provider: "openai-codex-2", role: "preferred", windows: [{ hours: [9, 18], days: ["mon", "tue"] }] });
    expect(multiPass().pools[0]).toMatchObject({
      strategy: "scheduled", memberSchedule: { "openai-codex-2": { role: "preferred", windows: [{ hours: [9, 18], days: ["mon", "tue"] }] } },
    });
    expect(calls.reload.length).toBe(2);
    await expect(service.setSchedule({ provider: "openai-codex", role: "preferred", windows: [{}] })).rejects.toBeInstanceOf(UiActionError);
    const accounts = check(await service.get()).subscriptions[0]!.accounts;
    expect(accounts.map((account) => [account.label, account.role])).toEqual([["Work", "default"], ["Personal", "preferred"]]);
  });

  it("needs two accounts before it can choose between them", async () => {
    const { service, fake } = setup();
    fake.store.set("openai-codex", { type: "oauth", access: fakeCodexToken() });
    await expect(service.setStrategy({ base: "openai-codex", strategy: "quota-first" })).rejects.toBeInstanceOf(UiActionError);
  });

  it("orders the accounts to fail over to by the pool's strategy, logged-in accounts only", async () => {
    const { service, fake } = setup({
      config: {
        ...twoAccounts,
        subscriptions: [{ provider: "openai-codex", index: 2 }, { provider: "openai-codex", index: 3 }],
        pools: [{ ...twoAccounts.pools[0], members: ["openai-codex-3", "openai-codex", "openai-codex-2"], strategy: "round-robin" }],
      },
    });
    for (const provider of ["openai-codex", "openai-codex-3"]) fake.store.set(provider, { type: "oauth", access: fakeCodexToken() });
    expect(await service.accountCandidates("openai-codex")).toEqual(["openai-codex-3", "openai-codex"]);
    expect(await service.connectedBases()).toEqual(["openai-codex"]);
  });
});

describe("Codex quota (D6)", () => {
  it("parses both rate-limit windows of wham/usage and the token's account data", () => {
    expect(parseCodexUsage({
      plan_type: "pro", email: "alice@example.com",
      rate_limit: {
        primary_window: { used_percent: 30, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
        secondary_window: { used_percent: 120, limit_window_seconds: 604_800 },
      },
    })).toEqual({
      plan: "pro", email: "alice@example.com",
      windows: [
        { label: "5h", remainingPercent: 70, resetAt: new Date(1_800_000_000_000).toISOString() },
        { label: "7d", remainingPercent: 0, resetAt: null },
      ],
    });
    expect(codexTokenMetadata(fakeCodexToken({ account: "acct-9", plan: "team" }))).toEqual({
      accountId: "acct-9", plan: "team", email: "alice@example.com",
    });
    expect(codexTokenMetadata("not-a-jwt")).toEqual({ accountId: null, plan: null, email: null });
  });

  it("asks wham/usage with the account's token in the background and shows the windows on the next read", async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchUsage = (async (url: string, init: RequestInit) => {
      requests.push({ url: String(url), headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 18_000, reset_at: 1_900_000_000 } } }));
    }) as unknown as typeof fetch;
    const { service, fake, calls } = setup({ fetch: fetchUsage });
    const token = fakeCodexToken({ account: "acct-7" });
    fake.store.set("openai-codex", { type: "oauth", access: token, expires: Date.now() + 3_600_000 });
    expect((await service.get()).subscriptions[0]!.accounts[0]!.quota).toBeNull();
    await vi.waitFor(() => expect(calls.publish).toBeGreaterThan(0));
    expect(requests).toEqual([{ url: CODEX_USAGE_URL, headers: expect.objectContaining({ Authorization: `Bearer ${token}`, "chatgpt-account-id": "acct-7" }) }]);
    const quota = check(await service.get()).subscriptions[0]!.accounts[0]!.quota;
    expect(quota).toMatchObject({ problem: null, windows: [{ label: "5h", remainingPercent: 60 }] });
    // 五分钟以内不再问。
    expect(requests).toHaveLength(1);
  });

  it("says why the quota is missing instead of failing: an expired login or an HTTP error", async () => {
    const failing = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    const { service, fake } = setup({ fetch: failing });
    fake.store.set("openai-codex", { type: "oauth", access: fakeCodexToken(), expires: Date.now() - 1_000 });
    expect((await service.checkCodexQuota("openai-codex"))!.quota.problem).toMatch(/expired/);
    fake.store.set("openai-codex", { type: "oauth", access: fakeCodexToken(), expires: Date.now() + 3_600_000 });
    expect((await service.checkCodexQuota("openai-codex"))!.quota.problem).toMatch(/HTTP 401/);
    expect(await service.checkCodexQuota("openai-codex-2")).toBeNull();
  });
});
