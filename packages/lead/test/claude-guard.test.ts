// The daemon never sends HTTP to Claude-family models: Lead's own model, the provider catalog and the model-change checks.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  assertConfiguredLeadModel, DEFAULT_LEAD_MODEL, isClaudeLeadSpec, leadModelCatalog, normalizeLeadModelConfig, refusedLeadModels,
  registerLeadProviders, selectedLeadModelSpec, usableLeadModels,
} from "../src/model-config.js";
import { createLeadSmartModel } from "../src/smart-model.js";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

// A local HTTP server that counts every request, standing in for a provider endpoint.
async function countingServer(): Promise<{ baseUrl: string; requests: () => number }> {
  let count = 0;
  const server = createServer((_req, res) => {
    count += 1;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "claude-haiku-5-5" }, { id: "deepseek-chat" }] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests: () => count };
}

const config = (models: string[], baseUrl = "http://127.0.0.1:1/v1") => normalizeLeadModelConfig({
  providers: {
    proxy: { baseUrl, discover: false, models: [{ id: "claude-haiku-5-5" }, { id: "deepseek-chat" }] },
    acme: { baseUrl: "https://llm.example.com/v1", discover: false, models: [{ id: "gpt-5.5" }] },
  },
  models,
}, {});

describe("Lead never selects a Claude model as its own", () => {
  it("skips Claude entries in the assignment and takes the first model that is not Claude", () => {
    expect(selectedLeadModelSpec(config(["proxy/claude-haiku-5-5", "acme/gpt-5.5"]), {})).toBe("acme/gpt-5.5");
    expect(usableLeadModels(config(["proxy/claude-haiku-5-5", "acme/gpt-5.5"]))).toEqual(["acme/gpt-5.5"]);
  });

  it("refuses a Claude-only assignment and starts on the default model instead of calling it", () => {
    expect(selectedLeadModelSpec(config(["proxy/claude-haiku-5-5", "claude-code/haiku"]), {})).toBe(DEFAULT_LEAD_MODEL);
    expect(selectedLeadModelSpec(config([]), { PLC_LEAD_MODEL: "proxy/claude-sonnet-5" })).toBe(DEFAULT_LEAD_MODEL);
    expect(selectedLeadModelSpec(config([]), { PLC_LEAD_MODEL: "acme/gpt-5.5" })).toBe("acme/gpt-5.5");
  });

  it("lists the refused entries so plc doctor can report them", () => {
    expect(refusedLeadModels(config(["proxy/claude-haiku-5-5", "acme/gpt-5.5", "claude-code/haiku"]), {}))
      .toEqual(["proxy/claude-haiku-5-5", "claude-code/haiku"]);
    expect(refusedLeadModels(config(["acme/gpt-5.5"]), { PLC_LEAD_MODEL: "proxy/claude-sonnet-5" })).toEqual(["proxy/claude-sonnet-5"]);
    expect(refusedLeadModels(config(["acme/gpt-5.5"]), {})).toEqual([]);
  });

  it("counts a provider whose address is the Anthropic API as Claude, whatever its models are called", () => {
    const anthropic = normalizeLeadModelConfig({ providers: { gateway: { baseUrl: "https://api.anthropic.com", models: [{ id: "gpt-x" }] } }, models: [] }, {});
    expect(isClaudeLeadSpec("gateway/gpt-x", anthropic)).toBe(true);
    expect(isClaudeLeadSpec("acme/gpt-5.5", config([]))).toBe(false);
  });
});

describe("assertConfiguredLeadModel", () => {
  it("refuses a Claude model with a message in the user's language, before it looks at any catalog", async () => {
    const fetchImpl = (() => { throw new Error("no request expected"); }) as unknown as typeof fetch;
    await expect(assertConfiguredLeadModel("proxy/claude-haiku-5-5", config([]), {}, fetchImpl))
      .rejects.toThrow("proxy/claude-haiku-5-5 is a Claude model. This daemon never sends requests to Claude models");
    await expect(assertConfiguredLeadModel("claude-code/haiku", config([]), {}, fetchImpl, { locale: "zh" }))
      .rejects.toThrow("不会向 Claude 模型发请求");
  });

  it("still accepts a model that is not Claude", async () => {
    await expect(assertConfiguredLeadModel("acme/gpt-5.5", config([]), {})).resolves.toBeUndefined();
  });
});

describe("a Claude provider receives no request", () => {
  it("does not ask a provider named anthropic or claude-code for its model list", async () => {
    const server = await countingServer();
    const claude = normalizeLeadModelConfig({
      providers: { anthropic: { baseUrl: server.baseUrl, discover: true }, "claude-code": { baseUrl: server.baseUrl, discover: true } },
      models: [],
    }, {});
    const catalog = await leadModelCatalog(claude, {});
    expect(catalog.models).toEqual([]);
    expect(catalog.notes.join("\n")).toContain("never sends requests to Claude");
    expect(server.requests()).toBe(0);
  });

  it("still asks an ordinary provider for its list (a proxy's Claude models are refused where they are chosen, not hidden)", async () => {
    const server = await countingServer();
    const catalog = await leadModelCatalog(normalizeLeadModelConfig({ providers: { proxy: { baseUrl: server.baseUrl, discover: true } }, models: [] }, {}), {});
    expect(catalog.models.map((model) => model.id)).toEqual(["claude-haiku-5-5", "deepseek-chat"]);
    expect(server.requests()).toBeGreaterThan(0);
  });
});

// A cycle against a real ModelRuntime and a local HTTP server that stands in for an ordinary proxy provider serving both a
// Claude model and another one. Every inference request is recorded with the model it names.
describe("a whole cycle sends no inference request to a Claude model", () => {
  async function inferenceServer(): Promise<{ baseUrl: string; models: () => string[] }> {
    const named: string[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        if (req.method === "POST") {
          try {
            named.push(String((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: unknown }).model));
          } catch {
            named.push("(unreadable)");
          }
          res.statusCode = 500; // the answer does not matter, only who was asked
          res.end("{}");
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "claude-haiku-5-5" }, { id: "deepseek-chat" }] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, models: () => named };
  }

  async function cycle(input: { models: string[]; env: Record<string, string>; llmFallback?: string; leadSpec?: string }) {
    const server = await inferenceServer();
    const config = normalizeLeadModelConfig({
      providers: { proxy: { api: "openai-completions", baseUrl: server.baseUrl, discover: true, apiKey: { value: "local-test" } } },
      models: input.models,
    }, {});
    const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false, authPath: join(tempDir("plc-guard-auth-"), "auth.json") });
    await registerLeadProviders(runtime, config, input.env);
    const built = createLeadSmartModel({
      modelRuntime: runtime, config, leadSpec: input.leadSpec ?? selectedLeadModelSpec(config, input.env), dataDir: tempDir("plc-guard-smart-"), env: input.env,
      ...(input.llmFallback ? { llmFallback: () => input.llmFallback! } : {}),
    });
    const outcomes: unknown[] = [];
    for (const ask of [
      () => built.smartModel?.decide("state", { ok: { type: "yes_no", prompt: "Is it fine?" } }),
      () => built.complete?.("summarise", { purpose: "channel_memory" }),
    ]) {
      await Promise.resolve(ask()).then((value) => outcomes.push(value), (error) => outcomes.push(error));
    }
    return { built, asked: server.models(), outcomes };
  }

  it("asks only the model that is not Claude when Claude is chosen everywhere else", async () => {
    const { built, asked } = await cycle({
      models: ["proxy/claude-haiku-5-5", "proxy/deepseek-chat"],
      env: { PLC_SMART_MODEL: "proxy/claude-haiku-5-5" }, llmFallback: "proxy/claude-haiku-5-5",
    });
    expect(built.llmSpec).toBe("proxy/deepseek-chat");
    expect(asked.length).toBeGreaterThan(0); // the instrument works: the other model was asked
    expect(new Set(asked)).toEqual(new Set(["deepseek-chat"]));
  });

  it("asks nobody when every model Lead and the smart model could use is Claude", async () => {
    // leadSpec is given outright: Lead itself would not start on this model, but the smart model must not take it either.
    const { built, asked } = await cycle({
      models: ["proxy/claude-haiku-5-5"], env: { PLC_SMART_MODEL: "proxy/claude-haiku-5-5" }, llmFallback: "proxy/claude-haiku-5-5",
      leadSpec: "proxy/claude-haiku-5-5",
    });
    expect(built.llmSpec).toBeNull();
    expect(built.smartModel).toBeNull();
    expect(asked).toEqual([]);
  });
});
