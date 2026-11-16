// 历史放不进一次摘要请求时分段压缩（compaction-chunks.ts，2026-11-01）：分段的规则和滚动摘要。
// 完整的一跳（真实的 pi 会话、模型拒绝超长请求）在 compaction-chunks-session.test.ts。
import { describe, expect, it, vi } from "vitest";
import {
  capToWindow, chooseSummaryRoute, chunkTokenBudget, compactInChunks, dropUnansweredWakes, messageTokens, planCompactionChunks, PREFIX_WARM_LONG_MS, PREFIX_WARM_MS,
  shrinkMessage,
} from "../src/compaction-chunks.js";

const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 0 });
const assistant = (text: string) => ({
  role: "assistant" as const, content: [{ type: "text" as const, text }], api: "openai-completions", provider: "stub", model: "m",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop" as const, timestamp: 0,
});
// 测试用的估算：每个字符 1 个 token。
const chars = (message: unknown) => JSON.stringify(message).length;

// A model call that failed: no content, stopReason error (what pi writes for a provider error).
const failed = () => ({ ...assistant(""), content: [], stopReason: "error" as const, errorMessage: "503 auth_unavailable" });
// What the daemon writes when it wakes Lead: only system events.
const wake = (label: string, size = 0) => user(
  `<system_event kind="clock" source="daemon">\n${label}\n</system_event>\n<system_event kind="situation" source="daemon">\n${"s".repeat(size)}\n</system_event>`,
);
const said = (text: string) => user(`<system_event kind="clock" source="daemon">\n12:00\n</system_event>\n<user_message from="user" via="app" channel="main">\n${text}\n</user_message>`);
const external = (text: string) => user(
  `<system_event kind="message" source="daemon">\n消息事件 #7\n</system_event>\n<untrusted_external_text from="external" source="slack">\n${text}\n</untrusted_external_text>`,
);

describe("dropUnansweredWakes", () => {
  it("keeps only the last wake of a run that got no answer, and every answered turn", () => {
    const answered = [wake("wake-0"), assistant("done")];
    const history = [...answered, wake("wake-1"), failed(), failed(), wake("wake-2"), failed(), wake("wake-3"), failed(), wake("wake-4"), assistant("back")];
    const result = dropUnansweredWakes(history as never);
    expect(result.dropped).toBe(2);
    expect(result.messages).toEqual([...answered, wake("wake-3"), wake("wake-4"), assistant("back")]);
  });

  it("never drops the user's words or external text, also when no call succeeded after them", () => {
    const history = [wake("wake-1"), failed(), said("帮我看一下部署"), failed(), wake("wake-2"), failed(), external("ping"), failed(), wake("wake-3"), failed()];
    const result = dropUnansweredWakes(history as never);
    expect(result.dropped).toBe(0);
    expect(result.messages).toEqual([wake("wake-1"), said("帮我看一下部署"), wake("wake-2"), external("ping"), wake("wake-3")]);
  });

  it("keeps a failed attempt that wrote something, and the messages before the first turn", () => {
    const partial = { ...assistant("写到一半"), stopReason: "aborted" as const };
    const history = [assistant("earlier reply"), wake("wake-1"), partial, wake("wake-2"), assistant("ok")];
    const result = dropUnansweredWakes(history as never);
    expect(result).toEqual({ messages: history, dropped: 0 });
  });
});

describe("capToWindow", () => {
  it("returns the history as it is when it fits", () => {
    const history = [user("a"), assistant("b")];
    expect(capToWindow(history as never, 10_000, chars as never)).toEqual({ messages: history, omitted: 0, omittedTokens: 0 });
  });

  it("keeps the newest messages under the cap and starts them at a user message", () => {
    const history = Array.from({ length: 10 }, (_, index) => (index % 2 ? assistant : user)(`${index}`.padEnd(200, "x")));
    const size = chars(history[0]) + chars(history[1]);
    // Room for two turns and a half: the half turn (an assistant reply without its question) goes too.
    const result = capToWindow(history as never, size * 2 + chars(history[1]) + 5, chars as never);
    expect(result.messages).toEqual(history.slice(6));
    expect(result.omitted).toBe(6);
    expect(result.omittedTokens).toBe(size * 3);
  });

  it("keeps the newest message when it alone is over the cap", () => {
    const history = [user("old"), assistant("x".repeat(5_000))];
    const result = capToWindow(history as never, 100, chars as never);
    expect(result.messages).toEqual([history[1]]);
    expect(result.omitted).toBe(1);
  });
});

describe("chooseSummaryRoute", () => {
  const main = { provider: "gw", id: "big" };
  const cheap = { provider: "gw", id: "small" };
  const prefix = (at?: number) => ({ provider: "gw", model: "big", sessionId: "s", promptCacheKey: false, messages: [], ...(at === undefined ? {} : { at }) });
  const now = 1_000_000;

  it("writes on the session prefix while the provider still holds it", () => {
    const warm = prefix(now - PREFIX_WARM_MS);
    expect(chooseSummaryRoute({ main, cheap, prefix: warm, now })).toEqual({ prefix: warm, model: cheap, reason: "warm_prefix" });
    expect(chooseSummaryRoute({ main, cheap: undefined, prefix: warm, now })).toEqual({ prefix: warm, model: main, reason: "warm_prefix" });
  });

  it("gives a cold or missing prefix to the cheaper model, in a separate request", () => {
    const cold = prefix(now - PREFIX_WARM_MS - 1);
    expect(chooseSummaryRoute({ main, cheap, prefix: cold, now })).toEqual({ prefix: null, model: cheap, reason: "cheap_model" });
    expect(chooseSummaryRoute({ main, cheap, prefix: null, now })).toEqual({ prefix: null, model: cheap, reason: "cheap_model" });
    // A prefix of another model is no prefix.
    expect(chooseSummaryRoute({ main, cheap, prefix: { ...prefix(now), model: "other" }, now }).reason).toBe("cheap_model");
  });

  it("stays as before when there is no cheaper model, or it is Lead's own model", () => {
    const cold = prefix(now - 3_600_000);
    expect(chooseSummaryRoute({ main, cheap: undefined, prefix: cold, now })).toEqual({ prefix: cold, model: main, reason: "main_model" });
    expect(chooseSummaryRoute({ main, cheap: { ...main }, prefix: cold, now })).toEqual({ prefix: cold, model: main, reason: "main_model" });
    expect(chooseSummaryRoute({ main, cheap: undefined, prefix: null, now })).toEqual({ prefix: null, model: main, reason: "main_model" });
  });

  it("takes a longer warm time for a provider that keeps the cache longer", () => {
    const old = prefix(now - 30 * 60_000);
    expect(chooseSummaryRoute({ main, cheap, prefix: old, now }).reason).toBe("cheap_model");
    expect(chooseSummaryRoute({ main, cheap, prefix: old, now, warmMs: PREFIX_WARM_LONG_MS }).reason).toBe("warm_prefix");
  });

  it("counts a prefix without a time as warm", () => {
    expect(chooseSummaryRoute({ main, cheap, prefix: prefix(), now }).reason).toBe("warm_prefix");
  });
});

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

  const usage0 = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const recorder = () => {
    const sent: unknown[][] = [];
    const summarize = vi.fn(async (chunk: unknown[]) => {
      sent.push(chunk);
      return { text: `摘要 ${sent.length}`, usage: usage0 };
    });
    const size = () => sent.flat().reduce<number>((total, message) => total + messageTokens(message as never), 0);
    const text = () => JSON.stringify(sent);
    return { sent, summarize, size, text };
  };

  // Regression (2026-11-16). Every model call failed for two days: 1,838 wake prompts and 7,028 failed attempts went
  // into the session, 3.94M tokens, and no compaction succeeded. With a working model again, the compaction sent all
  // of it in 18 requests on the user's most expensive model.
  it("does not send a backlog of unanswered wakes to the model", async () => {
    const backlog = Array.from({ length: 400 }, (_, index) => [wake(`wake-${index}`, 3_000), failed(), failed(), failed()]).flat();
    const history = [said("先看一下工单"), assistant("看完了"), ...backlog.slice(0, 800), said("你还在吗"), failed(), ...backlog.slice(800)];
    const window = 16_000;
    const before = history.reduce((total, message) => total + messageTokens(message as never), 0);
    expect(before).toBeGreaterThan(window * 10);
    const seen = recorder();
    const logs: string[] = [];

    const result = await compactInChunks(event(history) as never, ctx(window) as never, { summarize: seen.summarize as never, log: (line) => logs.push(line) });

    expect(seen.size()).toBeLessThanOrEqual(window);
    expect(seen.summarize.mock.calls.length).toBeLessThanOrEqual(3);
    // What the user said stays, with and without an answer. So does the last wake of each run.
    expect(seen.text()).toContain("先看一下工单");
    expect(seen.text()).toContain("你还在吗");
    expect(seen.text()).toContain("wake-199");
    expect(seen.text()).toContain("wake-399");
    expect(seen.text()).not.toContain("wake-198");
    expect(seen.text()).toContain("398 轮系统唤醒没有得到回复");
    expect(result!.compaction.details).toMatchObject({ unansweredWakes: 398, omittedMessages: 0 });
    expect(logs.join("\n")).toContain("left out 398 unanswered wakes");
  });

  it("reads at most one model window of history, and says what it left out", async () => {
    const window = 16_000;
    const history = Array.from({ length: 200 }, (_, index) => (index % 2 ? assistant : user)(`第 ${index} 条 ${"内容".repeat(500)}`));
    const before = history.reduce((total, message) => total + messageTokens(message as never), 0);
    expect(before).toBeGreaterThan(window * 5);
    const seen = recorder();

    const result = await compactInChunks(event(history) as never, ctx(window) as never, { summarize: seen.summarize as never });

    // The note is the only thing on top of one window of history.
    expect(seen.size()).toBeLessThanOrEqual(window + 200);
    expect(seen.text()).toContain("第 199 条");
    expect(seen.text()).not.toContain("第 0 条");
    const details = result!.compaction.details as { omittedMessages: number; omittedTokens: number };
    expect(details.omittedMessages).toBeGreaterThan(100);
    expect(seen.text()).toContain(`更早的 ${details.omittedMessages} 条消息（约 ${details.omittedTokens} token）没有读`);
    // The first request still carries the summary of the compaction before this one.
    expect((seen.summarize.mock.calls[0] as unknown[])[7]).toBe("上一次的摘要");
  });

  describe("with a cheaper summary model", () => {
    const small = { contextWindow: 8_000, maxTokens: 2_000, provider: "stub", id: "small" };
    const history = Array.from({ length: 12 }, (_, index) => (index % 2 ? assistant : user)(`第 ${index} 条 ${"内容".repeat(600)}`));
    const models = (calls: unknown[][]) => calls.map((call) => (call[1] as { id: string }).id);

    // The incident: no prefix (the last call had failed), so the whole summary went to Lead's model, the most expensive one.
    it("gives a summary without a prefix to the cheaper model, in parts that fit its window", async () => {
      const seen = recorder();
      const context = ctx(500_000);
      const result = await compactInChunks(event(history) as never, context as never, {
        summarize: seen.summarize as never, summaryModel: () => small as never,
      });
      const calls = seen.summarize.mock.calls as unknown as unknown[][];
      expect(calls.length).toBeGreaterThan(1);
      expect(new Set(models(calls))).toEqual(new Set(["small"]));
      const budget = chunkTokenBudget(small.contextWindow, 20_480);
      for (const chunk of seen.sent) expect(chunk.reduce<number>((total, message) => total + messageTokens(message as never), 0)).toBeLessThanOrEqual(budget);
      // The key is the cheaper model's.
      expect(context.modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledWith(small);
      // The cap on the history follows Lead's window, not the small one: nothing is left out here.
      expect(result!.compaction.details).toMatchObject({ model: "stub/small", chunks: calls.length });
      expect((result!.compaction.details as { omittedMessages?: number }).omittedMessages).toBeUndefined();
    });

    it("uses Lead's model when the cheaper model fails", async () => {
      const calls: string[] = [];
      const summarize = vi.fn(async (_chunk: unknown[], model: { id: string }) => {
        calls.push(model.id);
        if (model.id === "small") throw new Error("404 model not found");
        return { text: "摘要", usage: usage0 };
      });
      const logs: string[] = [];
      // pi's own compaction (no customInstructions): Lead writes it with its instructions.
      const own = { ...event(history), customInstructions: undefined };
      const result = await compactInChunks(own as never, ctx(500_000) as never, {
        summarize: summarize as never, summaryModel: () => small as never, log: (line) => logs.push(line), instructions: "最多 8000 字",
      });
      expect(calls).toEqual(["small", "m"]);
      expect(result!.compaction.summary.startsWith("摘要")).toBe(true);
      expect((result!.compaction.details as { model?: string }).model).toBeUndefined();
      expect(logs.join("\n")).toContain("stub/small did not write the summary (404 model not found); using stub/m");
    });

    it("does not try Lead's model after a cancel", async () => {
      const controller = new AbortController();
      const summarize = vi.fn(async () => {
        controller.abort();
        throw new Error("Compaction cancelled");
      });
      const cancelled = { ...event(history), signal: controller.signal };
      await expect(compactInChunks(cancelled as never, ctx(500_000) as never, { summarize: summarize as never, summaryModel: () => small as never }))
        .rejects.toThrow("Compaction cancelled");
      expect(summarize).toHaveBeenCalledTimes(1);
    });

    it("writes on a warm session prefix with Lead's model, and gives a cold prefix to the cheaper model", async () => {
      const prefix = (at: number) => ({
        provider: "stub", model: "m", sessionId: "s", promptCacheKey: false, at,
        messages: [{ role: "system", content: "prompt" }, { role: "user", content: "hi", timestamp: 0 }],
      });
      const reply = { role: "assistant", content: [{ type: "text", text: "前缀上的摘要" }], stopReason: "stop", usage: usage0 };
      const complete = vi.fn(async () => reply);
      const now = 10_000_000;
      const options = (at: number, seen: ReturnType<typeof recorder>) => ({
        summarize: seen.summarize as never, summaryModel: () => small as never, complete: complete as never, now: () => now,
        prefix: () => prefix(at) as never,
      });

      // A model with room for a summary on the prefix (the output cap must be at least PREFIX_MIN_OUTPUT_TOKENS).
      const big = () => ({ ...ctx(500_000), model: { contextWindow: 500_000, maxTokens: 32_000, provider: "stub", id: "m" } });
      const warm = recorder();
      const onPrefix = await compactInChunks(event(history) as never, big() as never, options(now - 60_000, warm));
      expect(complete).toHaveBeenCalledTimes(1);
      expect((complete.mock.calls[0] as unknown as [{ id: string }])[0].id).toBe("m");
      expect(warm.summarize).not.toHaveBeenCalled();
      expect(onPrefix!.compaction.details).toMatchObject({ prefix: true });

      const cold = recorder();
      const separate = await compactInChunks(event(history) as never, big() as never, options(now - 10 * 60_000, cold));
      expect(complete).toHaveBeenCalledTimes(1);
      expect(new Set(models(cold.summarize.mock.calls as unknown as unknown[][]))).toEqual(new Set(["small"]));
      expect(separate!.compaction.details).toMatchObject({ model: "stub/small" });
    });
  });

  it("writes the compaction itself when it left something out, so that pi does not send it", async () => {
    const history = [wake("wake-1"), failed(), wake("wake-2"), failed(), wake("wake-3"), assistant("好")];
    const seen = recorder();
    // A request from the daemon (customInstructions set) that fits in one request: before, this went back to pi.
    const result = await compactInChunks(event(history) as never, ctx(500_000) as never, { summarize: seen.summarize as never });
    expect(seen.summarize).toHaveBeenCalledTimes(1);
    expect(seen.text()).not.toContain("wake-1");
    expect(result!.compaction.details).toMatchObject({ chunks: 1, unansweredWakes: 1 });
  });
});
