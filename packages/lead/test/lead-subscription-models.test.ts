// 订阅的模型在 Lead 的目录里（模型配置方案 C 的 D3、D5），以及 D7：Lead 不用 pi 自带的别的订阅登录。
import { afterEach, describe, expect, it } from "vitest";
import {
  assertConfiguredLeadModel, assertLeadOAuthProviderAllowed, leadModelCatalog, leadSubscriptionModels, resolveLeadModel,
  setLeadSubscriptionSource, type LeadModelConfig,
} from "../src/model-config.js";

// pi 自带目录里 Codex 的第一个模型。不写死 id：pi 升级时目录会换（1.5.2 没有 gpt-5.5）。
const CODEX = leadSubscriptionModels("openai-codex")[0]!.id;
const config: LeadModelConfig = { providers: {}, models: [`openai-codex/${CODEX}`] };
const noFetch = (async () => { throw new Error("no network in this test"); }) as unknown as typeof fetch;

afterEach(() => setLeadSubscriptionSource(null));

describe("subscription models in Lead's catalog", () => {
  it("lists pi's built-in models of every subscription that has a logged-in account", async () => {
    expect(leadSubscriptionModels("openai-codex").map((model) => model.id)).toContain(CODEX);
    expect(leadSubscriptionModels("anthropic")).toEqual([]);
    setLeadSubscriptionSource(async () => ["openai-codex"]);
    const { models } = await leadModelCatalog(config, {}, noFetch);
    expect(models.length).toBeGreaterThan(0);
    expect(new Set(models.map((model) => model.provider))).toEqual(new Set(["openai-codex"]));
    expect(models.find((model) => model.id === CODEX)).toMatchObject({ provider: "openai-codex", group: null, efforts: [] });
  });

  it("lists no subscription when none is connected or the source is not connected", async () => {
    expect((await leadModelCatalog(config, {}, noFetch)).models).toEqual([]);
    setLeadSubscriptionSource(async () => { throw new Error("auth.json is locked"); });
    const { models, notes } = await leadModelCatalog(config, {}, noFetch);
    expect(models).toEqual([]);
    expect(notes.join("\n")).toContain("auth.json is locked");
  });

  it("accepts the n-th account of a subscription as the same chain slot (D5)", async () => {
    setLeadSubscriptionSource(async () => ["openai-codex"]);
    const chain: LeadModelConfig = { providers: {}, models: [] };
    await expect(assertConfiguredLeadModel(`openai-codex/${CODEX}`, chain, {}, noFetch)).resolves.toBeUndefined();
    await expect(assertConfiguredLeadModel(`openai-codex-2/${CODEX}`, chain, {}, noFetch)).resolves.toBeUndefined();
    await expect(assertConfiguredLeadModel(`github-copilot/${CODEX}`, chain, {}, noFetch)).rejects.toThrow(/不在已配置/);
  });
});

describe("Lead refuses other OAuth subscription logins (D7)", () => {
  // 和 pi 的 ModelRuntime 一样：listCredentials 只给 provider 和凭据的种类，不给凭据本身。
  const runtime = (credentials: Array<{ providerId: string; type: "oauth" | "api_key" }>) => ({
    listCredentials: async () => credentials,
    getModel: (provider: string, id: string) => ({ provider, id }),
    getAvailable: async () => [],
  });

  it("refuses a model whose provider is logged in with OAuth and is not Copilot or Codex", async () => {
    const fake = runtime([{ providerId: "anthropic", type: "oauth" }, { providerId: "openai-codex-2", type: "oauth" }]);
    await expect(assertLeadOAuthProviderAllowed(fake, "anthropic")).rejects.toThrow(/OAuth/);
    await expect(resolveLeadModel(fake as never, "anthropic/claude-sonnet-5")).rejects.toThrow(/只用 GitHub Copilot 和 Codex/);
    await expect(resolveLeadModel(fake as never, `openai-codex-2/${CODEX}`)).resolves.toMatchObject({ provider: "openai-codex-2" });
  });

  it("keeps the same provider usable with an API key", async () => {
    const fake = runtime([{ providerId: "anthropic", type: "api_key" }]);
    await expect(resolveLeadModel(fake as never, "anthropic/claude-sonnet-5")).resolves.toMatchObject({ id: "claude-sonnet-5" });
  });
});
