// 会话槽（session-slot.ts，.scratch/tool-occupancy/spec.md L3）：一步卡在一个不听中止的 await 上时，daemon 在进程里换掉
// Lead 的 pi 会话。这里用真实的 pi 会话（pi-ai 的假模型，会话文件在临时目录）：一个扩展的 context 钩子（transformContext）
// 一直不返回。旧的样子是 prompt() 和 abort() 都挂住。换会话以后：
//   · 旧会话上的 prompt() 以 LeadSessionReleasedError 结束；
//   · 排着的插话交出来，不丢；
//   · 新会话从会话文件续接，看得到卡住以前的对话；
//   · 旧会话以后醒过来，也写不进会话文件。
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { tempDir } from "@pi-lead-child/core/testing";
import { LeadSessionReleasedError, LeadSessionSlot } from "../src/session-slot.js";
import type { LeadEngine, LeadEngineFactoryResult } from "../src/engine.js";

const slots: LeadSessionSlot[] = [];
afterEach(() => {
  for (const slot of slots.splice(0)) slot.session.dispose();
});

const delay = (ms: number) => new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms));

function textOf(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("") : "";
}

// 会话文件里的消息：[角色, 文字]。
function fileMessages(sessionDir: string): Array<[string, string]> {
  const [file] = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));
  return readFileSync(join(sessionDir, file!), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "message" && ["user", "assistant"].includes(entry.message.role))
    .map((entry) => [entry.message.role, textOf(entry.message)]);
}

describe("replacing a Lead session whose step hangs in a non-tool await", () => {
  it("releases the hung prompt, keeps the queued steer, continues from the session file, and cuts the old session's writes", async () => {
    const workDir = tempDir("plc-session-slot-");
    const cwd = join(workDir, "cwd");
    const agentDir = join(workDir, "agent");
    const sessionDir = join(workDir, "sessions");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    const faux = fauxProvider({ provider: "plc-slot-test", api: "plc-slot-test-api" });
    // 卡住的钩子：打开时 context 钩子等 gate，不听中止。
    let hangOn = false;
    let markHung!: () => void;
    const hung = new Promise<void>((resolve) => { markHung = resolve; });
    let wake!: () => void;
    const gate = new Promise<void>((resolve) => { wake = resolve; });
    const hangingHook: ExtensionFactory = (pi) => {
      pi.on("context", async () => {
        if (!hangOn) return;
        markHung();
        await gate;
      });
    };
    const build = async (): Promise<LeadEngineFactoryResult> => {
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
      const loader = new DefaultResourceLoader({
        cwd, agentDir, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        disabledBuiltinExtensions: ["codemode", "tool-search", "mcp", "llama.cpp"],
        systemPromptOverride: () => "你是测试助手。", appendSystemPromptOverride: () => [],
        extensionFactories: [
          { name: "provider", factory: (pi) => pi.registerProvider(faux.provider) },
          { name: "hanging-hook", factory: hangingHook },
        ],
      });
      await loader.reload();
      const { session } = await createAgentSession({
        cwd, agentDir, model: faux.getModel() as never, thinkingLevel: "off", resourceLoader: loader, settingsManager,
        sessionManager: SessionManager.continueRecent(cwd, sessionDir), noTools: "all", tools: [],
      });
      await session.bindExtensions({});
      return { session: session as unknown as LeadEngine, modelName: "plc-slot-test/m" };
    };

    const slot = new LeadSessionSlot(await build());
    slots.push(slot);
    const ends: string[] = [];
    slot.session.subscribe((event: any) => {
      if (event.type === "message_end" && event.message.role === "assistant") ends.push(textOf(event.message));
    });
    faux.setResponses([fauxAssistantMessage("第一句的回答。")]);
    await slot.session.prompt("第一句");
    expect(ends).toEqual(["第一句的回答。"]);

    // 这一步卡在 context 钩子上。中止也停不下：这就是旧的样子。
    hangOn = true;
    const second = slot.session.prompt("第二句").then(() => null, (error: unknown) => error);
    await hung;
    await slot.session.steer("插话：先别做了");
    const old = slot.current;
    const aborting = old.abort!().then(() => "settled" as const);
    expect(await Promise.race([aborting, delay(300)])).toBe("timeout");
    expect(await Promise.race([second, delay(10)])).toBe("timeout");

    hangOn = false;
    const replaced = await slot.replace(build);
    expect(replaced).toMatchObject({ held: 1, released: 1, modelName: "plc-slot-test/m" });
    expect(await second).toBeInstanceOf(LeadSessionReleasedError);
    expect(slot.current).not.toBe(old);
    expect(slot.generation).toBe(1);
    // 排着的插话交出来（daemon 把它转成下一轮）。
    expect(slot.session.clearQueue!()).toEqual({ steering: ["插话：先别做了"], followUp: [] });
    expect(slot.session.clearQueue!()).toEqual({ steering: [], followUp: [] });

    // 新会话从会话文件续接：看得到卡住以前的对话。监听挂在新会话上。
    faux.setResponses([fauxAssistantMessage("第三句的回答。")]);
    await slot.session.prompt("第三句");
    expect(ends).toEqual(["第一句的回答。", "第三句的回答。"]);
    const context = (slot.current as unknown as { agent: { state: { messages: Array<{ role: string; content: unknown }> } } })
      .agent.state.messages.map((message) => [message.role, textOf(message)]);
    expect(context).toEqual(expect.arrayContaining([["user", "第一句"], ["assistant", "第一句的回答。"], ["user", "第二句"], ["user", "第三句"]]));

    // 旧会话醒过来：它已经断开、写不进会话文件。
    const before = fileMessages(sessionDir);
    faux.setResponses([fauxAssistantMessage("旧会话的迟到回答。")]);
    wake();
    await Promise.race([aborting, delay(1_000)]);
    await delay(100);
    expect(fileMessages(sessionDir)).toEqual(before);
    expect(before).toEqual([
      ["user", "第一句"], ["assistant", "第一句的回答。"], ["user", "第二句"], ["user", "第三句"], ["assistant", "第三句的回答。"],
    ]);
    expect(ends).not.toContain("旧会话的迟到回答。");
    // 不经过事件的写入（例如压缩做完时 pi 直接 appendCompaction）也进不了文件。
    const lines = () => readFileSync(join(sessionDir, readdirSync(sessionDir).find((name) => name.endsWith(".jsonl"))!), "utf8");
    const raw = lines();
    (old as unknown as { sessionManager: { appendCustomEntry(type: string, data: unknown): string } })
      .sessionManager.appendCustomEntry("plc-late-write", { from: "old session" });
    expect(lines()).toBe(raw);
  }, 30_000);

  it("ends the hung calls even when the new session cannot be built, and builds it again on the next prompt", async () => {
    const fake = (name: string): LeadEngineFactoryResult => ({
      modelName: name,
      session: {
        sessionId: name,
        prompt: () => new Promise<void>(() => {}),
        steer: async () => {}, followUp: async () => {},
        subscribe: () => () => {},
        dispose: () => {},
        clearQueue: () => ({ steering: [], followUp: [] }),
      } as unknown as LeadEngine,
    });
    const slot = new LeadSessionSlot(fake("a"));
    const hungPrompt = slot.session.prompt("卡住").then(() => null, (error: unknown) => error);
    let outcome: boolean | null = null;
    let attempts = 0;
    const failing = () => { attempts += 1; return Promise.reject(new Error("没有配置模型")); };
    await expect(slot.replace(failing, { settled: (ok) => { outcome = ok; } })).rejects.toThrow("没有配置模型");
    expect(outcome).toBe(false);
    expect(await hungPrompt).toBeInstanceOf(LeadSessionReleasedError);
    // 换的中间和没建出来时，插话收在槽里。
    await slot.session.steer("还在吗");
    expect(slot.session.clearQueue!()).toEqual({ steering: ["还在吗"], followUp: [] });
    // 下一次 prompt 先再建一次：还失败就报错。
    await expect(slot.session.prompt("再试")).rejects.toThrow("没有配置模型");
    expect(attempts).toBe(2);
  });
});
