// 1 小时提示缓存（服务商配置 lead.providers.<name>.cacheRetention，prompt-cache.ts 的 cacheRetentionExtension）。
// 缺省关闭，保持服务商的 5 分钟缓存：1 小时档写入是 2 倍价，Lead 清闲的日子省一半，最忙的日子多花三成。
import { describe, expect, it } from "vitest";
import { cacheRetentionOf, normalizeLeadModelConfig } from "../src/model-config.js";
import { cacheRetentionExtension, isCacheRetentionRejection, withLongCacheRetention } from "../src/prompt-cache.js";

describe("the cacheRetention provider setting", () => {
  it("is short unless the provider config says long", () => {
    const config = normalizeLeadModelConfig({
      providers: { a: { baseUrl: "https://a.example.com" }, b: { baseUrl: "https://b.example.com", cacheRetention: "long" } },
      models: [],
    });
    expect(cacheRetentionOf(config, "a")).toBe("short");
    expect(cacheRetentionOf(config, "b")).toBe("long");
    expect(cacheRetentionOf(config, "missing")).toBe("short");
    expect(config.providers.a).not.toHaveProperty("cacheRetention");
  });

  it("rejects any other value", () => {
    expect(() => normalizeLeadModelConfig({ providers: { a: { baseUrl: "https://a.example.com", cacheRetention: "1h" } }, models: [] }))
      .toThrow(/cacheRetention/);
  });
});

describe("withLongCacheRetention", () => {
  it("asks for the 1-hour TTL on every Anthropic cache breakpoint", () => {
    const payload = {
      model: "claude",
      system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "t" }, { name: "u", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: "plain" },
        { role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] },
      ],
    };
    const result = withLongCacheRetention(payload, { api: "anthropic-messages", id: "claude" }) as typeof payload;
    expect(result.system[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(result.tools[1]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect((result.messages[1]!.content as any)[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(result.tools[0]).not.toHaveProperty("cache_control");
    expect(result).not.toHaveProperty("prompt_cache_retention");
    // 原来的 payload 不变。
    expect(payload.system[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("asks an OpenAI-compatible endpoint for extended retention, and sets the TTL on Anthropic-style breakpoints it carries", () => {
    const payload = { model: "m", messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] }] };
    const result = withLongCacheRetention(payload, { api: "openai-completions", id: "m" }) as any;
    expect(result.prompt_cache_retention).toBe("24h");
    expect(result.messages[0].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(withLongCacheRetention({ model: "m", input: [] }, { api: "openai-responses", id: "m" })).toMatchObject({ prompt_cache_retention: "24h" });
  });

  it("keeps the payload when it does not apply", () => {
    expect(withLongCacheRetention({ model: "m" }, { api: "google-generative-ai", id: "m" })).toBeUndefined();
    expect(withLongCacheRetention({ model: "other" }, { api: "openai-completions", id: "m" })).toBeUndefined();
    expect(withLongCacheRetention({ model: "m", prompt_cache_retention: "in_memory" }, { api: "openai-completions", id: "m" })).toBeUndefined();
    expect(withLongCacheRetention("not an object", { api: "anthropic-messages", id: "m" })).toBeUndefined();
  });

  it("recognizes a provider error about the retention fields", () => {
    expect(isCacheRetentionRejection("Unrecognized request argument supplied: prompt_cache_retention")).toBe(true);
    expect(isCacheRetentionRejection("cache_control.ttl: Extra inputs are not permitted")).toBe(true);
    expect(isCacheRetentionRejection("rate limited")).toBe(false);
    expect(isCacheRetentionRejection(undefined)).toBe(false);
  });
});

describe("cacheRetentionExtension", () => {
  function fakePi() {
    const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    return {
      api: { on: (name: string, handler: (event: any, ctx: any) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } },
      emit: (name: string, event: unknown, ctx: unknown) => (handlers.get(name) ?? []).map((handler) => handler(event, ctx))[0],
    };
  }
  const ctxOf = (provider: string) => ({ model: { provider, id: "m", api: "openai-completions" } });

  it("changes requests only for providers set to long, and stops after the provider rejects the field", () => {
    const pi = fakePi();
    const logs: string[] = [];
    cacheRetentionExtension({ retention: (provider) => (provider === "long-gw" ? "long" : "short"), log: (line) => logs.push(line) })(pi.api as never);
    const payload = { model: "m", messages: [] };
    expect(pi.emit("before_provider_request", { payload }, ctxOf("short-gw"))).toBeUndefined();
    expect(pi.emit("before_provider_request", { payload }, ctxOf("long-gw"))).toMatchObject({ prompt_cache_retention: "24h" });
    pi.emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "unknown field prompt_cache_retention" } }, ctxOf("long-gw"));
    expect(pi.emit("before_provider_request", { payload }, ctxOf("long-gw"))).toBeUndefined();
    expect(logs).toEqual([expect.stringContaining("long-gw rejected")]);
  });
});
