import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  DEFAULT_LEAD_MODEL,
  assertConfiguredLeadModel,
  discoverOpenAICompatibleModels,
  knownContextWindow,
  listConfiguredLeadModelSpecs,
  loadLeadModelConfig,
  normalizeLeadModelConfig,
  registerLeadProviders,
  selectedLeadModelSpec,
  setLeadModelInConfig,
} from "../src/model-config.js";

let dir: string;
beforeEach(() => { dir = tempDir("plc-lead-model-"); });

describe("lead model config", () => {
  it("keeps PLC_LEAD_MODEL when lead.models is empty", () => {
    const config = normalizeLeadModelConfig({}, { PLC_LEAD_MODEL: "acme/gpt-4.1" });
    expect(selectedLeadModelSpec(config, { PLC_LEAD_MODEL: "acme/gpt-4.1" }))
      .toBe("acme/gpt-4.1");
  });

  it("lets config.json lead.models win over PLC_LEAD_MODEL", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      lead: { models: ["vibeproxy/gemini-3.7-flash-high"] },
    }));
    const config = loadLeadModelConfig(dir, { PLC_LEAD_MODEL: "openai/gpt-5.5" });
    expect(selectedLeadModelSpec(config, { PLC_LEAD_MODEL: "openai/gpt-5.5" }))
      .toBe("vibeproxy/gemini-3.7-flash-high");
  });

  it("falls back to the built-in default when nothing is configured", () => {
    expect(selectedLeadModelSpec({ providers: {}, models: [] }, {})).toBe(DEFAULT_LEAD_MODEL);
  });

  it("accepts a vibeproxy OpenAI-compatible provider", () => {
    const config = normalizeLeadModelConfig({
      providers: {
        vibeproxy: {
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:8317/v1",
          apiKey: { value: "vibeproxy" },
          discover: true,
        },
      },
      models: ["vibeproxy/claude-sonnet-4-5-20250929"],
    });
    expect(config.providers.vibeproxy.baseUrl).toBe("http://127.0.0.1:8317/v1");
    expect(config.providers.vibeproxy.api).toBe("openai-completions");
    expect(config.models).toEqual(["vibeproxy/claude-sonnet-4-5-20250929"]);
  });

  it("parses an OpenAI-compatible /v1/models catalog", async () => {
    const ids = await discoverOpenAICompatibleModels("http://127.0.0.1:8317/v1", "dummy", async () =>
      new Response(JSON.stringify({
        data: [
          { id: "claude-sonnet-4-5-20250929", owned_by: "anthropic" },
          { id: "gemini-3-flash", owned_by: "antigravity" },
        ],
      })),
    );
    expect(ids).toEqual(["claude-sonnet-4-5-20250929", "gemini-3-flash"]);
  });

  it("registers discovered models onto the runtime", async () => {
    const registered: Array<{ name: string; models: string[] }> = [];
    await registerLeadProviders(
      {
        registerProvider(name: string, input: { models?: Array<{ id: string }> }) {
          registered.push({ name, models: (input.models ?? []).map((model) => model.id) });
        },
      } as never,
      normalizeLeadModelConfig({
        providers: {
          vibeproxy: {
            baseUrl: "http://127.0.0.1:8317/v1",
            apiKey: { value: "vibeproxy" },
            discover: true,
          },
        },
      }),
      {},
      async () => new Response(JSON.stringify({
        data: [{ id: "claude-haiku-4-5-20251001" }, { id: "gemini-3-flash" }],
      })),
    );
    expect(registered).toEqual([{
      name: "vibeproxy",
      models: ["claude-haiku-4-5-20251001", "gemini-3-flash"],
    }]);
  });

  it("writes the selected Lead model without dropping other config", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      env: { PLC_GATEWAY_PORT: { value: "47130" } },
      lead: {
        providers: { vibeproxy: { baseUrl: "http://127.0.0.1:8317/v1" } },
        models: ["vibeproxy/old"],
      },
    }));
    setLeadModelInConfig("vibeproxy/claude-sonnet-5", dir);
    const written = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    expect(written.env.PLC_GATEWAY_PORT).toEqual({ value: "47130" });
    expect(written.lead.models).toEqual(["vibeproxy/claude-sonnet-5", "vibeproxy/old"]);
    expect(written.lead.providers.vibeproxy.baseUrl).toBe("http://127.0.0.1:8317/v1");
  });

  it("keeps other preferred models when promoting a new Lead default", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      lead: {
        models: [
          "vibeproxy/claude-sonnet-5",
          "vibeproxy/gemini-3.7-flash-high",
        ],
      },
    }));
    setLeadModelInConfig("vibeproxy/gemini-3.7-flash-high", dir);
    const written = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    expect(written.lead.models).toEqual([
      "vibeproxy/gemini-3.7-flash-high",
      "vibeproxy/claude-sonnet-5",
    ]);
  });

  it("lists preferred models plus a configured provider catalog", async () => {
    const specs = await listConfiguredLeadModelSpecs(
      normalizeLeadModelConfig({
        providers: {
          vibeproxy: {
            baseUrl: "http://127.0.0.1:8317/v1",
            discover: true,
            models: ["claude-sonnet-5"],
          },
        },
        models: ["vibeproxy/gemini-3.7-flash-high"],
      }),
      {},
      async () => new Response(JSON.stringify({
        data: [
          { id: "claude-sonnet-5" },
          { id: "gemini-3.7-flash-high" },
        ],
      })),
    );
    expect(specs).toEqual([
      "vibeproxy/gemini-3.7-flash-high",
      "vibeproxy/claude-sonnet-5",
    ]);
  });

  it("rejects a model that is not in the configured Lead catalog", async () => {
    await expect(assertConfiguredLeadModel(
      "vibeproxy/grok-4.6",
      normalizeLeadModelConfig({
        providers: {
          vibeproxy: {
            baseUrl: "http://127.0.0.1:8317/v1",
            discover: false,
            models: ["claude-sonnet-5", "gemini-3.7-flash-high"],
          },
        },
        models: ["vibeproxy/gemini-3.7-flash-high"],
      }),
    )).rejects.toThrow(/vibeproxy\/claude-sonnet-5/);
  });
  // 2026-11-12 回归：网关目录没写 DeepSeek 的窗口，Lead 按 128K 注册，压缩反复触发，提示缓存几乎打不中。
  it("uses the documented window for DeepSeek V4 models when neither config nor catalog gives one", async () => {
    const registered: Array<{ id: string; contextWindow: number }> = [];
    await registerLeadProviders(
      {
        registerProvider(_name: string, input: { models?: Array<{ id: string; contextWindow: number }> }) {
          registered.push(...(input.models ?? []).map(({ id, contextWindow }) => ({ id, contextWindow })));
        },
      } as never,
      normalizeLeadModelConfig({
        providers: {
          gateway: { baseUrl: "http://127.0.0.1:8317/v1", apiKey: { value: "test" }, discover: true },
        },
      }),
      {},
      async () => new Response(JSON.stringify({
        data: [{ id: "deepseek-v4.1-flash" }, { id: "deepseek-flash(high)" }, { id: "some-other-model" }],
      })),
    );
    expect(registered).toEqual([
      { id: "deepseek-v4.1-flash", contextWindow: 500_000 },
      { id: "deepseek-flash(high)", contextWindow: 500_000 },
      { id: "some-other-model", contextWindow: 128_000 },
    ]);
  });

  it("knows the DeepSeek V4 family but not the older 128K models", () => {
    expect(knownContextWindow("deepseek-flash")).toBe(1_000_000);
    expect(knownContextWindow("deepseek-v4-pro")).toBe(1_000_000);
    expect(knownContextWindow("deepseek-chat")).toBeNull();
    expect(knownContextWindow("gpt-4.1-mini")).toBeNull();
  });
});
