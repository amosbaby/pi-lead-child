import { describe, expect, it } from "vitest";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { hindsightProgram, summaryModels } from "../src/memory-backend.js";

// Hindsight 的摘要模型（src/memory-backend.ts，spec D16）：缺省槽按 PLC_HINDSIGHT_LLM > 设置选，都没有时不用摘要模型；
// 整理观察槽按设置选，没选时跟缺省一样。daemon 不向 Claude 系的模型发请求：Claude 的选择一律变成「没有模型」。

function configDir(): string {
  const dir = tempDir("plc-memory-backend-");
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    lead: {
      providers: { vibeproxy: { api: "openai-completions", baseUrl: "http://127.0.0.1:8317/v1", discover: true, apiKey: { fromEnv: "VIBE_KEY" } } },
      models: ["vibeproxy/deepseek-chat"],
    },
  }));
  return dir;
}

const VIBE = { provider: "vibeproxy", baseUrl: "http://127.0.0.1:8317/v1" };

describe("summaryModels", () => {
  // 以前缺省槽自动选 Lead 目录里最新的 haiku。现在没有这一步：目录里有 haiku 也不挑它，没选就是没有模型。
  it("has no model by default, even when the Lead providers offer haiku models, so Hindsight runs recall-only", async () => {
    const models = await summaryModels(configDir(), {}, {});
    expect(models.default).toMatchObject({ source: "none", spec: null, llm: null });
    expect(models.consolidation).toMatchObject({ source: "none", llm: null });
  });

  it("uses the settings, with the provider's key resolved in the daemon", async () => {
    // 地址和 key 在 daemon 里解析好（key 进 secrets.sealed），hindsight-main 不读 config.json 和 Keychain。
    const models = await summaryModels(configDir(), { default: "vibeproxy/gemini-3.5-flash-lite", consolidation: "vibeproxy/deepseek-chat" },
      { VIBE_KEY: "vibe-secret" });
    expect(models.default).toMatchObject({ source: "settings", spec: "vibeproxy/gemini-3.5-flash-lite", llm: { ...VIBE, model: "gemini-3.5-flash-lite", apiKey: "vibe-secret" } });
    expect(models.consolidation).toMatchObject({ source: "settings", spec: "vibeproxy/deepseek-chat", llm: { model: "deepseek-chat", apiKey: "vibe-secret" } });
  });

  it("lets PLC_HINDSIGHT_LLM win over the settings and says so; a provider the Lead does not have falls through with the reason", async () => {
    const env = await summaryModels(configDir(), { default: "vibeproxy/deepseek-chat" }, { PLC_HINDSIGHT_LLM: "vibeproxy/gemini-3.5-flash-lite" });
    expect(env.default).toMatchObject({ source: "env", spec: "vibeproxy/gemini-3.5-flash-lite", setting: "vibeproxy/deepseek-chat", problem: expect.stringMatching(/PLC_HINDSIGHT_LLM 盖住了/) });
    const broken = await summaryModels(configDir(), { consolidation: "openrouter/gpt-5.5" }, { PLC_HINDSIGHT_LLM: "openrouter/gpt-5.5" });
    expect(broken.default).toMatchObject({ source: "none", spec: null, problem: expect.stringMatching(/PLC_HINDSIGHT_LLM=openrouter\/gpt-5.5：服务商 openrouter 不在/) });
    expect(broken.consolidation).toMatchObject({ source: "none", setting: "openrouter/gpt-5.5", problem: expect.stringMatching(/服务商 openrouter 不在/) });
  });

  it("turns a Claude model into 'no model' with the reason, whichever way it was chosen", async () => {
    const chosen = await summaryModels(configDir(), { default: "vibeproxy/claude-haiku-5-5", consolidation: "vibeproxy/claude-sonnet-5-5" }, {});
    expect(chosen.default).toMatchObject({ source: "none", spec: null, llm: null, problem: expect.stringContaining("is a Claude model") });
    expect(chosen.consolidation).toMatchObject({ llm: null, problem: expect.stringContaining("is a Claude model") });
    const env = await summaryModels(configDir(), {}, { PLC_HINDSIGHT_LLM: "vibeproxy/claude-haiku-5-5" }, "zh");
    expect(env.default).toMatchObject({ source: "none", llm: null, problem: expect.stringContaining("PLC_HINDSIGHT_LLM=vibeproxy/claude-haiku-5-5：vibeproxy/claude-haiku-5-5 是 Claude 模型") });
    // A Claude choice does not fall through to some other model by itself.
    const settingsOverEnv = await summaryModels(configDir(), { default: "vibeproxy/deepseek-chat" }, { PLC_HINDSIGHT_LLM: "claude-code/haiku" });
    expect(settingsOverEnv.default).toMatchObject({ source: "settings", spec: "vibeproxy/deepseek-chat" });
  });
});

describe("hindsightProgram", () => {
  // 「允许在后台」显示 plist 里程序的文件名：直接写 Node 时显示 lead-agent（用户 2026-11-05）。
  it("starts Hindsight through the Bytezard Lead Memory link next to Node, and through Node when there is no link", () => {
    const bin = join(tempDir("plc-memory-launcher-"), "bin");
    mkdirSync(bin, { recursive: true });
    const node = join(bin, "lead-agent");
    writeFileSync(node, "node");
    expect(hindsightProgram({ PLC_DEV: "1" }, node)[0]).toBe(node);
    symlinkSync("lead-agent", join(bin, "Bytezard Lead Memory"));
    expect(hindsightProgram({ PLC_DEV: "1" }, node)[0]).toBe(join(bin, "Bytezard Lead Memory"));
  });

  it("runs the source through tsx in PLC_DEV", () => {
    const args = hindsightProgram({ PLC_DEV: "1" });
    expect(args[0]).toBe(process.execPath);
    expect(args[1]).toMatch(/tsx\/dist\/cli\.mjs$/);
    expect(args[2]).toMatch(/apps\/daemon\/src\/hindsight-main\.ts$/);
  });
});
