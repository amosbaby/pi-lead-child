import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { collectClaudeModelTargets } from "../src/claude-targets.js";

function dataDirWith(config: unknown, service?: unknown): string {
  const dir = tempDir("plc-claude-targets-");
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  if (service) {
    mkdirSync(join(dir, "hindsight"), { recursive: true });
    writeFileSync(join(dir, "hindsight", "service.json"), JSON.stringify(service));
  }
  return dir;
}

describe("collectClaudeModelTargets (what plc doctor reports)", () => {
  it("finds a Claude Lead model, a Claude provider, the smart-model fallback and Hindsight's summary models", () => {
    const dir = dataDirWith({
      lead: {
        providers: {
          proxy: { baseUrl: "http://127.0.0.1:8317/v1", discover: false, models: [{ id: "claude-haiku-5-5" }, { id: "deepseek-chat" }] },
          anthropic: { baseUrl: "http://127.0.0.1:9/v1", discover: false, models: [{ id: "x" }] },
        },
        models: ["proxy/claude-haiku-5-5", "proxy/deepseek-chat"],
      },
      decision: {
        llmFallback: "proxy/claude-haiku-5-5",
        models: [
          { id: "named", name: "named", baseUrl: "https://decide.example.com", model: "claude-haiku-5-5" },
          { id: "host", name: "host", baseUrl: "https://api.anthropic.com", model: "decision-1" },
          { id: "fine", name: "fine", baseUrl: "https://decide2.example.com", model: "decision-1" },
        ],
        chain: ["named", "host", "fine"],
      },
      memory: { llm: { default: "claude-code/haiku", consolidation: "proxy/deepseek-chat" } },
    }, {
      database: { kind: "pg0" }, embedding: { provider: "openai" }, databaseUrl: "x",
      llm: { provider: "claude-code", baseUrl: "http://127.0.0.1:1/v1", model: "haiku" },
    });
    const found = collectClaudeModelTargets(dir, { PLC_SMART_MODEL: "proxy/claude-sonnet-5", PLC_HINDSIGHT_LLM: "proxy/claude-haiku-5-5" });
    expect(found).toEqual([
      { where: "Lead model", spec: "proxy/claude-haiku-5-5" },
      { where: "lead.providers.anthropic", spec: "http://127.0.0.1:9/v1" },
      { where: "PLC_SMART_MODEL", spec: "proxy/claude-sonnet-5" },
      { where: "decision.llmFallback", spec: "proxy/claude-haiku-5-5" },
      { where: "decision.models.named", spec: "claude-haiku-5-5 (https://decide.example.com)" },
      { where: "decision.models.host", spec: "decision-1 (https://api.anthropic.com)" },
      { where: "memory.llm.default", spec: "claude-code/haiku" },
      { where: "PLC_HINDSIGHT_LLM", spec: "proxy/claude-haiku-5-5" },
      { where: "hindsight service.json llm", spec: "claude-code/haiku" },
    ]);
  });

  it("reports nothing for a configuration without Claude", () => {
    const dir = dataDirWith({
      lead: { providers: { acme: { baseUrl: "https://llm.example.com/v1", discover: false, models: [{ id: "gpt-5.5" }] } }, models: ["acme/gpt-5.5"] },
      memory: { llm: { default: "acme/gpt-5.5" } },
    });
    expect(collectClaudeModelTargets(dir, {})).toEqual([]);
  });
});
