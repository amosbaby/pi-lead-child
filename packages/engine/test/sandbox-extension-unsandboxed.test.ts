// pi 子进程的沙箱扩展在「沙箱外执行」授权下（工单 #62）：runtime 的 pi.ts 只给执行者写 PLC_SANDBOX_OFF=1。
//   - 执行者的 bash 不套沙箱（能读到沙箱里读不到的 plc 配置：这是 UNSANDBOXED_FLOOR_GAPS.pi 写明的缺口）。
//   - read、edit、write 照旧按底线挡：读不到私钥和 plc 的配置、密钥，写不了 plc.db 和 config.json。
//   - 核查员即使环境里有这个变量，bash 照旧在沙箱里。
// 真实的 pi 会话加载扩展，模型是 pi-ai 的假模型；plc 的数据目录指到这个测试自己的目录。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { PLC_UNSANDBOXED_ENV } from "@pi-lead-child/core";
import { createSandboxExtension } from "../src/extension/sandbox.js";
import { resetSandboxForTests } from "../src/sandbox/bash.js";

const supported = process.platform === "darwin" || process.platform === "linux";
type Step = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0][number];
const call = (name: string, args: Record<string, unknown>): Step =>
  fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });

async function childSession(workdir: string, steps: Step[]) {
  const faux = fauxProvider({ provider: "plc-sandbox-ext-test", api: "plc-sandbox-ext-test-api" });
  faux.setResponses([...steps, fauxAssistantMessage("done")]);
  const agentDir = join(workdir, ".agent");
  mkdirSync(agentDir, { recursive: true });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: workdir, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => "test",
    extensionFactories: [
      { name: "provider", factory: (pi) => pi.registerProvider(faux.provider) },
      { name: "plc-sandbox", factory: createSandboxExtension(workdir) },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: workdir, agentDir, model: faux.getModel() as never, thinkingLevel: "off",
    resourceLoader: loader, sessionManager: SessionManager.inMemory(workdir), settingsManager,
    tools: ["read", "bash", "edit", "write"],
  });
  await session.bindExtensions({});
  const results: Array<{ name: string; isError: boolean; text: string }> = [];
  session.subscribe((event: any) => {
    if (event.type !== "tool_execution_end") return;
    const text = (event.result?.content ?? []).map((part: { text?: string }) => part.text ?? "").join("");
    results.push({ name: event.toolName, isError: Boolean(event.isError), text });
  });
  await session.prompt("go", { expandPromptTemplates: false });
  session.dispose();
  return results;
}

describe.runIf(supported)("the pi child sandbox extension outside the sandbox", () => {
  const base = mkdtempSync(join(homedir(), ".plc-unsandboxed-ext-"));
  const dataDir = join(base, "data");
  mkdirSync(dataDir);
  const config = join(dataDir, "config.json");
  writeFileSync(config, "{\"marker\":\"plc-config-marker\"}");
  const saved = { dataDir: process.env.PLC_DATA_DIR, role: process.env.PLC_SANDBOX_ROLE, off: process.env[PLC_UNSANDBOXED_ENV] };
  process.env.PLC_DATA_DIR = dataDir;
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  afterEach(() => {
    restore("PLC_SANDBOX_ROLE", saved.role);
    restore(PLC_UNSANDBOXED_ENV, saved.off);
  });
  afterAll(async () => {
    await resetSandboxForTests();
    restore("PLC_DATA_DIR", saved.dataDir);
    rmSync(base, { recursive: true, force: true });
  });

  it("leaves the executor's bash unsandboxed, and still blocks read and write on the floor", async () => {
    process.env.PLC_SANDBOX_ROLE = "executor";
    process.env[PLC_UNSANDBOXED_ENV] = "1";
    const workdir = join(base, "w1");
    mkdirSync(workdir);
    const ledger = join(dataDir, "plc.db");
    const results = await childSession(workdir, [
      call("bash", { command: `cat ${config}` }),
      call("read", { path: config }),
      call("read", { path: join(homedir(), ".ssh", "id_ed25519") }),
      call("write", { path: ledger, content: "no" }),
      call("write", { path: "inside.txt", content: "ok" }),
    ]);
    // bash 不在沙箱里：读得到 config.json（这是写明的缺口，不是挡住了）。
    expect(results[0]).toMatchObject({ name: "bash", isError: false });
    expect(results[0]!.text).toContain("plc-config-marker");
    expect(results[1]).toMatchObject({ name: "read", isError: true });
    expect(results[1]!.text).toContain("不能读");
    expect(results[1]!.text).not.toContain("plc-config-marker");
    expect(results[2]).toMatchObject({ name: "read", isError: true });
    expect(results[3]).toMatchObject({ name: "write", isError: true });
    expect(existsSync(ledger)).toBe(false);
    expect(readFileSync(join(workdir, "inside.txt"), "utf8")).toBe("ok");
  }, 90_000);

  it("keeps the reviewer's bash in the sandbox even with the variable set", async () => {
    process.env.PLC_SANDBOX_ROLE = "reviewer";
    process.env[PLC_UNSANDBOXED_ENV] = "1";
    const workdir = join(base, "w2");
    mkdirSync(workdir);
    const results = await childSession(workdir, [call("bash", { command: `cat ${config}` })]);
    expect(results[0]!.name).toBe("bash");
    expect(results[0]!.text).not.toContain("plc-config-marker");
  }, 90_000);
});
