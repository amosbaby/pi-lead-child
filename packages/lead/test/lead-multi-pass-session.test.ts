// pi-multi-pass 加载进 Lead 的会话（模型配置方案 C 的 D1、D5）：用真实的 createLeadSession，模型接到本机的 OpenAI 兼容桩上。
// 入口（engine 的 multi-pass-lead.ts）每次加载都现读 PLC_MULTI_PASS_ENTRY：daemon 运行中第一次装好时，重新加载扩展就用上。
// 假的 pi-multi-pass 和真的一样用 pi.registerProvider 注册第 2 个账号（openai-codex-2）：它要进到 Lead 的 ModelRuntime，
// Lead 才能换到这个账号；每次请求的结果记进 SubscriptionAccountTracker（按回答消息自己的 provider）。
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb } from "@pi-lead-child/store";
import { createLeadSession } from "../src/session.js";
import { SubscriptionAccountTracker } from "../src/subscriptions.js";

let server: Server | null = null;
const savedEntry = process.env.PLC_MULTI_PASS_ENTRY;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  if (savedEntry === undefined) delete process.env.PLC_MULTI_PASS_ENTRY;
  else process.env.PLC_MULTI_PASS_ENTRY = savedEntry;
});

async function openAiStub(): Promise<{ baseUrl: string; calls: () => number }> {
  let calls = 0;
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (body: object) => res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", ...body })}\n\n`);
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "好的。" }, finish_reason: null }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`, calls: () => calls };
}

// 假的 pi-multi-pass：默认导出一个扩展，注册第 2 个 Codex 账号，指向桩。
function fakeMultiPassEntry(baseUrl: string): string {
  const path = join(tempDir("plc-multi-pass-pkg-"), "multi-sub.ts");
  writeFileSync(path, `
export default function multiSub(pi) {
  pi.registerProvider("openai-codex-2", {
    name: "Home — ChatGPT Codex #2", baseUrl: ${JSON.stringify(baseUrl)}, api: "openai-completions", apiKey: "test",
    models: [{ id: "m", name: "m · Home", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000, maxTokens: 4096 }],
  });
}
`);
  return path;
}

// 假的 pi-multi-pass 换了账号、pi 又不重试时：它在 agent_end 里把这一轮的输入作为 followUp 再发一次（MS 的 handleError）。
function resendingMultiPassEntry(): string {
  const path = join(tempDir("plc-multi-pass-pkg-"), "multi-sub.ts");
  writeFileSync(path, `
export default function multiSub(pi) {
  let last = null;
  let resent = false;
  pi.on("before_agent_start", (event) => { last = event.prompt; });
  pi.on("agent_end", () => {
    if (resent || !last) return;
    resent = true;
    pi.sendUserMessage(last, { deliverAs: "followUp" });
  });
}
`);
  return path;
}

describe("pi-multi-pass in the Lead session", () => {
  it("drops pi-multi-pass's resend of the turn input: the daemon retries the turn itself", async () => {
    const stub = await openAiStub();
    const dataDir = tempDir("plc-lead-multi-pass-");
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      lead: {
        providers: { stub: { api: "openai-completions", baseUrl: stub.baseUrl, apiKey: { value: "test" }, discover: false, models: ["m"] } },
        models: ["stub/m"],
      },
    }));
    process.env.PLC_MULTI_PASS_ENTRY = resendingMultiPassEntry();
    const db = openDb(join(dataDir, "plc.db"));
    const lead = await createLeadSession({ dataDir, dbPath: join(dataDir, "plc.db"), db, subscriptionAccounts: new SubscriptionAccountTracker() });
    const session = lead.session as unknown as { prompt(text: string): Promise<void>; dispose(): void; messages: Array<{ role: string }> };
    try {
      await session.prompt("你好");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(stub.calls()).toBe(1);
      expect(session.messages.filter((message) => message.role === "user")).toHaveLength(1);
    } finally {
      session.dispose();
      db.close();
    }
  }, 30_000);

  it("registers the extra account into Lead's ModelRuntime after a reload, records each request, and forgets a removed account", async () => {
    delete process.env.PLC_MULTI_PASS_ENTRY;
    const stub = await openAiStub();
    const dataDir = tempDir("plc-lead-multi-pass-");
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      lead: {
        providers: { stub: { api: "openai-completions", baseUrl: stub.baseUrl, apiKey: { value: "test" }, discover: false, models: ["m"] } },
        models: ["stub/m"],
      },
    }));
    const db = openDb(join(dataDir, "plc.db"));
    const tracker = new SubscriptionAccountTracker();
    const lead = await createLeadSession({ dataDir, dbPath: join(dataDir, "plc.db"), db, subscriptionAccounts: tracker });
    const session = lead.session as unknown as { prompt(text: string): Promise<void>; dispose(): void };
    try {
      // 还没装：没有第 2 个账号。
      await expect(lead.switchModel("openai-codex-2/m")).rejects.toThrow(/openai-codex-2\/m/);

      // daemon 运行中第一次装好（engine 的 multi-pass-package.ts 的 sync），Lead 重新加载扩展。
      process.env.PLC_MULTI_PASS_ENTRY = fakeMultiPassEntry(stub.baseUrl);
      await lead.reloadExtensions();
      await lead.switchModel("openai-codex-2/m");
      expect(lead.currentModel()).toBe("openai-codex-2/m");

      // 这个账号上一次限流了；这一次请求成功：冷却和这次故障都结束。
      tracker.failed("openai-codex-2", "429 Too Many Requests");
      expect(tracker.coolingUntil("openai-codex-2")).not.toBeNull();
      await session.prompt("你好");
      expect(stub.calls()).toBe(1);
      expect(tracker.coolingUntil("openai-codex-2")).toBeNull();

      // 删掉这个账号：从 ModelRuntime 里注销以后换不过去。
      await lead.switchModel("stub/m");
      lead.forgetProvider("openai-codex-2");
      await expect(lead.switchModel("openai-codex-2/m")).rejects.toThrow();
    } finally {
      session.dispose();
      db.close();
    }
  }, 30_000);
});
