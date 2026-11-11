import { describe, expect, it } from "vitest";
import { isClaudeTarget } from "../src/index.js";

describe("isClaudeTarget", () => {
  it.each([
    [{ provider: "claude-code", model: "haiku" }, true],
    [{ provider: "anthropic" }, true],
    [{ provider: "Anthropic " }, true],
    // a proxy that forwards to Claude is still Claude
    [{ provider: "openai-compatible", model: "claude-haiku-5-5", baseUrl: "http://127.0.0.1:8317" }, true],
    [{ provider: "proxy", model: "as4/claude-sonnet-5(high)" }, true],
    [{ model: "opus-5" }, true],
    [{ model: "fable-1" }, true],
    [{ provider: "x", model: "gpt-5", baseUrl: "https://api.anthropic.com" }, true],
    [{ baseUrl: "https://API.Anthropic.com/v1" }, true],
    [{ baseUrl: "api.anthropic.com" }, true],
    [{ provider: "openai-compatible", model: "deepseek-chat", baseUrl: "https://api.example.com" }, false],
    [{ provider: "openai", model: "gpt-5.5" }, false],
    // hostnames, not substrings of the whole URL
    [{ provider: "x", model: "deepseek-chat", baseUrl: "https://api.example.com/?next=api.anthropic.com" }, false],
    [{ provider: "x", model: "deepseek-chat", baseUrl: "https://api.anthropic.com.example.com" }, false],
    [{ baseUrl: "http://127.0.0.1:8317" }, false],
    [{}, false],
    [{ baseUrl: "not a url" }, false],
  ])("isClaudeTarget(%o) = %s", (target, want) => expect(isClaudeTarget(target)).toBe(want));
});
