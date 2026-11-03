// 历史放不进一次摘要请求时分段压缩（compaction-chunks.ts，2026-11-01）：分段的规则和滚动摘要。
// 完整的一跳（真实的 pi 会话、模型拒绝超长请求）在 compaction-chunks-session.test.ts。
import { describe, expect, it, vi } from "vitest";
import {
  chunkTokenBudget, compactInChunks, messageTokens, planCompactionChunks, shrinkMessage,
} from "../src/compaction-chunks.js";

const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 0 });
const assistant = (text: string) => ({
  role: "assistant" as const, content: [{ type: "text" as const, text }], api: "openai-completions", provider: "stub", model: "m",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop" as const, timestamp: 0,
});
// 测试用的估算：每个字符 1 个 token。
const chars = (message: unknown) => JSON.stringify(message).length;

describe("planCompactionChunks", () => {
  it("keeps the order and puts as many messages in a part as fit under the budget", () => {
    const messages = [user("a".repeat(300)), assistant("b".repeat(300)), user("c".repeat(300)), assistant("d".repeat(300))];
    const budget = chars(messages[0]) + chars(messages[1]) + 10;
    const chunks = planCompactionChunks(messages as never, budget, chars as never);
    expect(chunks.map((chunk) => chunk.length)).toEqual([2, 2]);
    expect(chunks.flat()).toEqual(messages);
    for (const chunk of chunks) expect(chunk.reduce((total, message) => total + chars(message), 0)).toBeLessThanOrEqual(budget);
  });

  it("shrinks a single message that is larger than a part, and gives it a part of its own", () => {
    const huge = user("x".repeat(20_000));
    const chunks = planCompactionChunks([user("before"), huge, user("after")] as never, 2_000, chars as never);
    expect(chunks).toHaveLength(3);
    const shrunk = chunks[1]![0] as { role: string; content: string };
    expect(shrunk.role).toBe("user");
    expect(chars(shrunk)).toBeLessThanOrEqual(2_000);
    expect(shrunk.content).toMatch(/压缩时省略了 \d+ 字/);
  });
});

describe("shrinkMessage", () => {
  it("keeps the message's shape and both ends of its text", () => {
    const message = assistant(`开头${"y".repeat(10_000)}结尾`);
    const shrunk = shrinkMessage(message as never, 1_500, chars as never) as unknown as typeof message;
    expect(shrunk.role).toBe("assistant");
    expect(shrunk.content[0]!.text.startsWith("开头")).toBe(true);
    expect(shrunk.content[0]!.text.endsWith("结尾")).toBe(true);
    expect(chars(shrunk)).toBeLessThanOrEqual(1_500);
  });
});

describe("chunkTokenBudget", () => {
  it("is half the model window less the summary's reserve, and never below a floor", () => {
    expect(chunkTokenBudget(500_000, 20_480)).toBe(229_520);
    expect(chunkTokenBudget(16_000, 20_480)).toBe(2_000);
  });
});

describe("compactInChunks", () => {
  const ctx = (contextWindow: number) => ({
    model: { contextWindow, maxTokens: 2_000, provider: "stub", id: "m" },
    modelRegistry: { getApiKeyAndHeaders: vi.fn(async () => ({ apiKey: "test-key", headers: { "x-test": "1" } })) },
  });
  const event = (messages: unknown[]) => ({
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "keep-1", messagesToSummarize: messages, turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 123_456,
      previousSummary: "上一次的摘要", fileOps: { read: new Set(["a.ts", "b.ts"]), written: new Set(["b.ts"]), edited: new Set<string>() },
      settings: { enabled: true, reserveTokens: 20_480, keepRecentTokens: 20_000 },
    },
    branchEntries: [], reason: "manual", willRetry: false, signal: new AbortController().signal, customInstructions: "最多 8000 字",
  });

  it("leaves a history that fits in one request to pi", async () => {
    const summarize = vi.fn();
    const result = await compactInChunks(event([user("短的")]) as never, ctx(500_000) as never, { summarize: summarize as never });
    expect(result).toBeUndefined();
    expect(summarize).not.toHaveBeenCalled();
  });

  // 2026-11-02：pi 自己触发的压缩不带任何要求，上一份摘要里「pending 的检查会拦 APPROVE」「不能改 Slack 消息」这类旧结论
  // 一次次被抄进新摘要，代码早改了，Lead 还照着拒绝。没有要求的压缩由这里来写，带上 instructions。
  it("writes pi's own compaction itself when it has instructions for it, even when the history fits in one request", async () => {
    const seen: Array<string | undefined> = [];
    const summarize = vi.fn(async (_chunk: unknown[], _model: unknown, _reserve: number, _apiKey: unknown, _headers: unknown,
      _signal: unknown, instructions: string | undefined) => {
      seen.push(instructions);
      return { text: "新摘要" };
    });
    const automatic = { ...event([user("短的")]), customInstructions: undefined };
    const result = await compactInChunks(automatic as never, ctx(500_000) as never, { summarize: summarize as never, instructions: "能力不写成规则" });
    expect(seen).toEqual(["能力不写成规则"]);
    expect(result!.compaction).toMatchObject({ firstKeptEntryId: "keep-1", tokensBefore: 123_456, details: { chunks: 1 } });
    expect(result!.compaction.summary.startsWith("新摘要")).toBe(true);
    // daemon 自己发起、带了要求的压缩，放得进一次请求时照旧交给 pi。
    expect(await compactInChunks(event([user("短的")]) as never, ctx(500_000) as never, { summarize: summarize as never, instructions: "能力不写成规则" }))
      .toBeUndefined();
  });

  it("summarizes a long history part by part, each part carrying the summary so far, and reports each part", async () => {
    const messages = Array.from({ length: 12 }, (_, index) => (index % 2 ? assistant : user)(`第 ${index} 条 ${"内容".repeat(600)}`));
    const budget = chunkTokenBudget(16_000, 20_480);
    const expected = planCompactionChunks(messages as never, budget).length;
    expect(expected).toBeGreaterThan(1);
    const seen: Array<{ size: number; previous: string | undefined; instructions: string | undefined; apiKey: string | undefined }> = [];
    const summarize = vi.fn(async (chunk: unknown[], _model: unknown, _reserve: number, apiKey: string | undefined, _headers: unknown,
      _signal: unknown, instructions: string | undefined, previous: string | undefined) => {
      seen.push({ size: chunk.reduce<number>((total, message) => total + messageTokens(message as never), 0), previous, instructions, apiKey });
      return { text: `第 ${seen.length} 段的摘要`, usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    });
    const progress: Array<{ done: number; total: number }> = [];
    const result = await compactInChunks(event(messages) as never, ctx(16_000) as never, {
      summarize: summarize as never, onProgress: (step) => progress.push({ done: step.done, total: step.total }),
    });

    expect(summarize).toHaveBeenCalledTimes(expected);
    expect(seen.every((call) => call.size <= budget)).toBe(true);
    expect(seen.map((call) => call.previous)).toEqual(["上一次的摘要", ...seen.slice(0, -1).map((_, index) => `第 ${index + 1} 段的摘要`)]);
    expect(seen.every((call) => call.instructions === "最多 8000 字" && call.apiKey === "test-key")).toBe(true);
    expect(progress).toEqual(Array.from({ length: expected }, (_, index) => ({ done: index + 1, total: expected })));
    expect(result!.compaction).toMatchObject({
      firstKeptEntryId: "keep-1", tokensBefore: 123_456,
      details: { readFiles: ["a.ts"], modifiedFiles: ["b.ts"], chunks: expected },
      usage: { input: 10 * expected, totalTokens: 11 * expected },
    });
    expect(result!.compaction.summary).toBe(`第 ${expected} 段的摘要\n\n<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\n</modified-files>`);
  });

  it("stops when the compaction is cancelled", async () => {
    const messages = Array.from({ length: 12 }, (_, index) => user(`第 ${index} 条 ${"内容".repeat(600)}`));
    const controller = new AbortController();
    const summarize = vi.fn(async () => {
      controller.abort();
      return { text: "摘要", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    });
    const cancelled = { ...event(messages), signal: controller.signal };
    await expect(compactInChunks(cancelled as never, ctx(16_000) as never, { summarize: summarize as never })).rejects.toThrow("Compaction cancelled");
    expect(summarize).toHaveBeenCalledTimes(1);
  });
});
