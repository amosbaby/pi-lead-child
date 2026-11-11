// Hindsight's summary model is never a Claude model: the daemon sends no request to Claude. Memory store and recall
// keep working (the service runs without an LLM, so it recalls but does not extract new facts).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  ensureHindsightService, hindsightDir, hindsightEnvironment, pg0Url, readServiceFile, HINDSIGHT_RESOLVED_BEFORE, HINDSIGHT_VERSION,
  type EnsureHindsightOptions, type HindsightEmbedding, type HindsightLlmTarget, type HindsightServiceFile,
} from "../src/deploy/hindsight.js";

const EMBEDDING: HindsightEmbedding = { provider: "openai", baseUrl: "https://embed.example.com/v1", model: "embed-small", dimensions: null };
const CLAUDE_CODE_HAIKU: HindsightLlmTarget = { provider: "claude-code", baseUrl: "http://127.0.0.1:1/v1", model: "haiku" };
const PROXIED_CLAUDE: HindsightLlmTarget = { provider: "acme", baseUrl: "http://127.0.0.1:8317/v1", model: "claude-haiku-5-5" };
const ANTHROPIC_HOST: HindsightLlmTarget = { provider: "gateway", baseUrl: "https://api.anthropic.com", model: "gpt-x" };
const FINE: HindsightLlmTarget = { provider: "acme", baseUrl: "https://llm.example.com/v1", model: "deepseek-chat" };

function options(llm: HindsightLlmTarget | null, extra: Partial<EnsureHindsightOptions> = {}) {
  const dataDir = tempDir("plc-hindsight-guard-");
  const lines: string[] = [];
  const base: EnsureHindsightOptions = {
    dataDir, env: {}, log: (line) => lines.push(line), uvx: "/Users/alice/.local/bin/uvx",
    programArguments: ["/usr/local/bin/node", "/repo/apps/daemon/dist/hindsight.mjs"],
    embedding: EMBEDDING, reranker: { provider: "none" }, llm, observations: true, secretsVersion: 1,
    findPostgres: async () => ({ found: null, reasons: [] }),
    launchctl: async () => ({ ok: false, out: "" }), plistPath: join(dataDir, "none.plist"), sleep: async () => {},
    ...extra,
  };
  return { dataDir, lines, base };
}

describe("ensureHindsightService with a Claude summary model", () => {
  it.each([["claude-code provider", CLAUDE_CODE_HAIKU], ["a proxy's Claude model", PROXIED_CLAUDE], ["the Anthropic host", ANTHROPIC_HOST]])(
    "writes llm: null for %s, keeps the service up and says why",
    async (_name, target) => {
      const { dataDir, lines, base } = options(target, { consolidationLlm: FINE });
      expect(await ensureHindsightService(base)).toMatchObject({ url: "http://127.0.0.1:47188" });
      const service = readServiceFile(dataDir)!;
      expect(service.llm).toBeNull();
      expect(service.consolidationLlm).toBeNull();
      expect(service.observations).toBe(false);
      expect(service.missions).toBeNull();
      expect(lines.join("\n")).toContain("Claude model");
      // The file on disk carries no trace of the refused target.
      expect(readFileSync(join(hindsightDir(dataDir), "service.json"), "utf8")).not.toMatch(/haiku|claude-code|api\.anthropic\.com/);
    },
  );

  it("keeps a summary model that is not Claude, and drops only a Claude consolidation model", async () => {
    const kept = options(FINE, { consolidationLlm: PROXIED_CLAUDE });
    await ensureHindsightService(kept.base);
    expect(readServiceFile(kept.dataDir)).toMatchObject({ llm: FINE, consolidationLlm: null, observations: true });
    const both = options(FINE, { consolidationLlm: { provider: "other", baseUrl: "https://llm2.example.com/v1", model: "gpt-5.5" } });
    await ensureHindsightService(both.base);
    expect(readServiceFile(both.dataDir)?.consolidationLlm).toMatchObject({ model: "gpt-5.5" });
  });
});

describe("hindsightEnvironment reading a service.json that an older daemon wrote", () => {
  const service = (llm: HindsightLlmTarget | null, consolidationLlm?: HindsightLlmTarget): HindsightServiceFile => ({
    version: HINDSIGHT_VERSION, resolvedBefore: HINDSIGHT_RESOLVED_BEFORE, port: 47188, database: { kind: "pg0" },
    databaseUrl: pg0Url("ab12cd34"), embedding: EMBEDDING, reranker: { provider: "none" }, llm,
    ...(consolidationLlm ? { consolidationLlm } : {}), observations: true,
    secretsVersion: 1, tuning: { logLevel: null, logFormat: null }, uvx: "/u/uvx",
  });
  const secrets = { apiKey: "k", databasePassword: "p", llmApiKey: "llm-key" };

  it("gives Hindsight no LLM and no observations when the file still names a Claude model", () => {
    const { env, notes } = hindsightEnvironment({ service: service(CLAUDE_CODE_HAIKU, PROXIED_CLAUDE), secrets, env: {} });
    expect(env).toMatchObject({ HINDSIGHT_API_LLM_PROVIDER: "none", HINDSIGHT_API_ENABLE_OBSERVATIONS: "false" });
    expect(Object.keys(env).filter((name) => /LLM_(BASE_URL|MODEL|API_KEY)$/.test(name))).toEqual([]);
    expect(notes.join("\n")).toContain("Claude model");
  });

  it("still passes a model that is not Claude", () => {
    const { env } = hindsightEnvironment({ service: service(FINE), secrets, env: {} });
    expect(env).toMatchObject({ HINDSIGHT_API_LLM_PROVIDER: "openai", HINDSIGHT_API_LLM_MODEL: "deepseek-chat" });
  });
});

