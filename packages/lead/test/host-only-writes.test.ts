// 沙箱挡住的 home 路径（core 的 SANDBOX_DENY_WRITE_HOME）一开始就走 run_on_host。2026-11-11 一位用户的 Lead 要卸掉
// ~/.pi 下的一个 pi 扩展：它先建单派了子 agent，子 agent 的沙箱和 Lead 一样写不了 ~/.pi，白绕一圈以后才让用户自己
// 在终端里跑 mv。这里测三处指引：run_on_host 的说明和系统提示词、edit/write 的拒绝、bash 被沙箱挡住时的结果。
// bash 那条用假的 sandbox-runtime（包装成直接跑），在本身就在沙箱里的环境也能跑（同 hands-host-bypass.test.ts）。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { sandboxDenyWriteHomeLabels, sandboxPolicy } from "@pi-lead-child/core";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "@pi-lead-child/store";
import { resetSandboxForTests } from "@pi-lead-child/engine";
import { credentialGuardExtension } from "../src/credential-guard.js";
import { bashHostOnlyWriteHint, hostOnlyWriteNote, leadHandsExtension, leadWriteRefusal, shellPath } from "../src/hands.js";
import { LEAD_SYSTEM_PROMPT } from "../src/prompt.js";
import { createLeadTools, type LeadDeps } from "../src/tools.js";

const home = "/Users/alice";

describe("run_on_host's description and the system prompt", () => {
  it("lists every path from SANDBOX_DENY_WRITE_HOME, says sub-agents cannot write them either, and points at run_on_host", () => {
    const note = hostOnlyWriteNote();
    for (const label of sandboxDenyWriteHomeLabels()) expect(note).toContain(label);
    expect(note).toContain("~/.pi");
    expect(note).toContain("任何仓库的 .git/hooks");
    expect(note).toMatch(/子 agent.*也写不了/);
    expect(note).toMatch(/一开始就用 run_on_host，不要建单、不要派子 agent/);
  });

  it("puts that note into run_on_host's description", () => {
    const dir = tempDir("plc-host-only-tools-");
    const db = openDb(join(dir, "plc.db"));
    const deps: LeadDeps = { db, dbPath: join(dir, "plc.db"), dataDir: dir, currentTurnId: () => null };
    const tool = createLeadTools(deps).find((candidate: { name: string }) => candidate.name === "run_on_host") as { description: string };
    expect(tool.description).toContain(hostOnlyWriteNote());
    db.close();
  });

  it("tells Lead in the fallback order to skip the sub-agent step for these paths", () => {
    const prompt = LEAD_SYSTEM_PROMPT;
    expect(prompt).toMatch(/要写沙箱挡住的 home 路径（清单在 run_on_host 的说明里）时跳过这一步：子 agent 的沙箱和你是同一套边界，也写不了/);
  });
});

describe("edit and write on a path only the host can write", () => {
  const policy = sandboxPolicy({ role: "lead", writable: ["/data/lead-scratch"], home, dataDir: "/data", env: { PATH: "/usr/bin" } });
  const refusal = (path: string, tool: string) => leadWriteRefusal(path, { cwd: "/data", home, policy, tool, scratch: "/data/lead-scratch" });

  it("points write at run_on_host with a command to copy, and does not call it a floor", () => {
    const text = refusal("~/.pi/agent/settings.json", "write")!;
    expect(text).toContain("不能写");
    expect(text).not.toContain("底线");
    expect(text).toContain("~/.pi 只能在沙箱外写");
    expect(text).toContain("不要建单或派子 agent 去试");
    expect(text).toContain("用 write 把内容写到 /data/lead-scratch/host-writes/settings.json");
    expect(text).toContain("用 run_on_host 跑 mkdir -p ~/.pi/agent && cp /data/lead-scratch/host-writes/settings.json ~/.pi/agent/settings.json");
  });

  it("points edit at a scratch copy and run_on_host, with home paths that keep ~ outside the quotes", () => {
    const text = refusal(`${home}/Library/LaunchAgents/com.example.agent.plist`, "edit")!;
    expect(text).toContain("~/Library/LaunchAgents 只能在沙箱外写");
    expect(text).toContain("用 bash 跑 mkdir -p /data/lead-scratch/host-writes && cp ~/Library/LaunchAgents/com.example.agent.plist"
      + " /data/lead-scratch/host-writes/com.example.agent.plist");
    expect(text).toContain("用 edit 改 /data/lead-scratch/host-writes/com.example.agent.plist");
    expect(text).toContain("用 run_on_host 跑 cp /data/lead-scratch/host-writes/com.example.agent.plist ~/Library/LaunchAgents/com.example.agent.plist");
  });

  it("keeps the floor for credentials, plc's own files and other blocked places", () => {
    expect(refusal("~/.ssh/config", "write")).toMatch(/不能写凭证.*底线/);
    expect(refusal("/data/plc.db", "write")).toMatch(/底线/);
    expect(refusal("/data/plc.db", "write")).not.toContain("run_on_host");
    expect(refusal("/repo/src/x.ts", "write")).not.toContain("run_on_host");
  });

  it("quotes a path with spaces so the command can be copied as is", () => {
    expect(shellPath(`${home}/Library/Application Support/Code/User/settings.json`, home))
      .toBe("~/'Library/Application Support/Code/User/settings.json'");
    expect(shellPath("/tmp/it's here", home)).toBe("'/tmp/it'\\''s here'");
    expect(shellPath(home, home)).toBe("~");
  });
});

describe("bashHostOnlyWriteHint", () => {
  const hint = (command: string, output: string) => bashHostOnlyWriteHint({ command, cwd: "/data/lead-scratch", output, home });

  it("names run_on_host and the same command when the sandbox refused a write to one of these paths", () => {
    const command = "mv ~/.pi/agent/extensions/demo-ext ~/.pi/agent/extensions-disabled/";
    const text = hint(command, `mv: rename ${home}/.pi/agent/extensions/demo-ext: Operation not permitted\n\nCommand exited with code 1`)!;
    expect(text).toContain("沙箱挡住了写 ~/.pi");
    expect(text).toContain("不要建单或派子 agent 去试");
    expect(text).toContain(`改用 run_on_host 跑同一条命令，cwd 填 /data/lead-scratch：\n${command}\n`);
  });

  it("says to write a script first when the command is too long for the card", () => {
    const text = hint(`echo ${"x".repeat(2_000)} > ~/.zshrc`, `zsh: operation not permitted: ${home}/.zshrc`)!;
    expect(text).toContain("先写成你临时目录里的脚本，再用 run_on_host 跑 bash <脚本>");
  });

  it("stays out of the way for other failures", () => {
    expect(hint("mv ~/.pi/a ~/.pi/b", "mv: ~/.pi/a: No such file or directory")).toBeNull();
    expect(hint("touch /etc/hosts", "touch: /etc/hosts: Operation not permitted")).toBeNull();
    expect(hint("touch ~/.pip/x", `touch: ${home}/.pip/x: Operation not permitted`)).toBeNull();
  });
});

describe("Lead's bash when the sandbox refuses a write to one of these paths", () => {
  type Step = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0][number];
  let dir: string;
  let db: Db;

  beforeEach(async () => {
    await resetSandboxForTests();
    vi.spyOn(SandboxManager, "isSupportedPlatform").mockReturnValue(true);
    vi.spyOn(SandboxManager, "initialize").mockResolvedValue(undefined as never);
    vi.spyOn(SandboxManager, "reset").mockResolvedValue(undefined as never);
    vi.spyOn(SandboxManager, "wrapWithSandboxArgv")
      .mockImplementation((async (command: string) => ({ argv: ["/bin/sh", "-c", command] })) as never);
    dir = tempDir("plc-host-only-bash-");
    db = openDb(join(dir, "plc.db"));
  });

  afterEach(async () => {
    await resetSandboxForTests();
    vi.restoreAllMocks();
    db.close();
  });

  async function bashResults(commands: string[]): Promise<Array<{ isError: boolean; text: string }>> {
    const faux = fauxProvider({ provider: "plc-host-only", api: "plc-host-only-api" });
    const steps: Step[] = commands.map((command) =>
      fauxAssistantMessage([fauxToolCall("bash", { command } as never)], { stopReason: "toolUse" }));
    faux.setResponses([...steps, fauxAssistantMessage("好了。")]);
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir, { recursive: true });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPromptOverride: () => "test",
      extensionFactories: [
        { name: "provider", factory: (pi) => pi.registerProvider(faux.provider) },
        { name: "plc-credential-guard", factory: credentialGuardExtension({ cwd: dir, secretValues: () => [] }) },
        { name: "plc-hands", factory: leadHandsExtension({ db, dataDir: dir, home: dir, turnOrigin: () => ({ external: false, timer: null }) }) },
      ],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: dir, agentDir, model: faux.getModel() as never, thinkingLevel: "off",
      resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), settingsManager, tools: ["bash"],
    });
    await session.bindExtensions({});
    session.setActiveToolsByName(["bash"]);
    const ends: Array<{ isError: boolean; text: string }> = [];
    session.subscribe((event: any) => {
      if (event.type !== "tool_execution_end" || event.toolName !== "bash") return;
      ends.push({ isError: event.isError === true, text: (event.result?.content ?? []).map((part: { text?: string }) => part.text ?? "").join("") });
    });
    await session.prompt("go", { expandPromptTemplates: false });
    session.dispose();
    return ends;
  }

  it("adds the run_on_host route to a failed command, and nothing to an unrelated failure", async () => {
    // 不真的写 home：命令只打印沙箱拒绝写入时的那句话（home 是这个测试的临时目录）。
    const refused = `echo "mv: rename ${dir}/.pi/agent/extensions/demo-ext: Operation not permitted" >&2; exit 1`;
    const unrelated = "echo 'cat: missing.txt: No such file or directory' >&2; exit 1";
    const ends = await bashResults([refused, unrelated]);
    expect(ends[0]?.isError).toBe(true);
    expect(ends[0]?.text).toContain("Operation not permitted");
    expect(ends[0]?.text).toContain("沙箱挡住了写 ~/.pi");
    // bash 在会话的目录里跑（这里是 home）：cwd 写成 ~。
    expect(ends[0]?.text).toContain(`改用 run_on_host 跑同一条命令，cwd 填 ~：\n${refused}\n`);
    expect(ends[1]?.isError).toBe(true);
    expect(ends[1]?.text).not.toContain("run_on_host");
  }, 60_000);
});
