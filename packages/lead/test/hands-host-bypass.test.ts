// 免沙箱的 bash（docs/ticket-246-user-turn-bypass.md 第 10 节）：真实的 pi 会话，hands 扩展和凭证防护照 Lead 加载，
// 模型是 pi-ai 的假模型，按脚本调用 bash。断言命令在哪里跑：沙箱外不调 sandbox-runtime 的 wrapWithSandboxArgv。
// 这里只测分流：sandbox-runtime 换成假的（包装成直接跑），在本身就在沙箱里的环境（嵌套的 sandbox-exec 起不来）也能跑。
// 真的沙箱和开关关着时的行为由 hands.test.ts 覆盖（那个文件不改一行）。
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { tempDir } from "@pi-lead-child/core/testing";
import { HOST_COMMAND_STARTED_KIND } from "@pi-lead-child/protocol";
import { channelOwnerBinding, createLoopbackBinding, createTurn, listEvents, openDb, type Db } from "@pi-lead-child/store";
import { enableHostBypass, resetSandboxForTests } from "@pi-lead-child/engine";
import { credentialGuardExtension } from "../src/credential-guard.js";
import { HOST_RUN_MARK, leadHandsExtension } from "../src/hands.js";
import { withExternalContent, type LeadTurnOrigin } from "../src/turn-origin.js";

type Step = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0][number];
const bash = (command: string, extra: Record<string, unknown> = {}): Step =>
  fauxAssistantMessage([fauxToolCall("bash", { command, ...extra } as never)], { stopReason: "toolUse" });

let dir: string;
let db: Db;
let turnId: string | null;
let origin: LeadTurnOrigin;

let wrap: ReturnType<typeof vi.spyOn>;
// 假的决策模型：两个问题各给一个概率；null 表示没有配置。
let smart: { serves: number; hard: number } | null;
const smartModel = () => (smart === null ? null : {
  backend: "fake",
  decide: async () => ({
    backend: "fake", model: null, latencyMs: 1, fallbackFrom: null,
    answers: {
      serves_user: { type: "yes_no" as const, probability: smart!.serves },
      hard_to_undo: { type: "yes_no" as const, probability: smart!.hard },
    },
  }),
}) as never;

beforeEach(async () => {
  await resetSandboxForTests();
  vi.spyOn(SandboxManager, "isSupportedPlatform").mockReturnValue(true);
  vi.spyOn(SandboxManager, "initialize").mockResolvedValue(undefined as never);
  vi.spyOn(SandboxManager, "reset").mockResolvedValue(undefined as never);
  wrap = vi.spyOn(SandboxManager, "wrapWithSandboxArgv")
    .mockImplementation((async (command: string) => ({ argv: ["/bin/sh", "-c", command] })) as never);
  dir = tempDir("plc-hands-bypass-");
  db = openDb(join(dir, "plc.db"));
  turnId = null;
  origin = { external: false, timer: null };
  smart = null;
});

afterEach(async () => {
  await resetSandboxForTests();
  vi.restoreAllMocks();
  db.close();
});

function turnOn(): void {
  enableHostBypass(db, { bindingId: null, resolvedBy: "user via Mac 网页", reason: "test", now: new Date() });
}

function companionTurn(id: string): void {
  const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
  createTurn(db, { id, originBindingId: binding.id, originKind: "paired:companion", userText: "…", state: "streaming" });
  turnId = id;
}

// afterEnd：第 n 个 bash 结束以后调用（模拟 daemon 在同一轮里记下外部内容）。
async function session(steps: Step[], afterEnd: (index: number) => void = () => {}): Promise<Array<{ isError: boolean; text: string }>> {
  const faux = fauxProvider({ provider: "plc-hands-bypass", api: "plc-hands-bypass-api" });
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
      {
        name: "plc-hands",
        factory: leadHandsExtension({ db, dataDir: dir, home: dir, turnOrigin: () => origin, currentTurnId: () => turnId, smartModel }),
      },
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
    afterEnd(ends.length);
  });
  await session.prompt("go", { expandPromptTemplates: false });
  session.dispose();
  return ends;
}

const started = () => listEvents(db, { kind: HOST_COMMAND_STARTED_KIND }).map((event) => event.payload as Record<string, unknown>);

describe("bash with the sandbox bypass on", () => {
  it("runs outside the sandbox in the user's own turn and records the turn", async () => {
    turnOn();
    companionTurn("turn-live");
    const ends = await session([bash("echo first-host")]);
    expect(ends[0]?.isError).toBe(false);
    expect(ends[0]?.text.startsWith(HOST_RUN_MARK)).toBe(true);
    expect(ends[0]?.text).toContain("first-host");
    expect(wrap).not.toHaveBeenCalled();
    expect(started()).toEqual([expect.objectContaining({
      turnId: "turn-live", turnOrigin: "live_user_companion", via: "bash", command: "echo first-host", spendsMoney: false,
    })]);
  }, 90_000);

  it("treats the user's Slack DM to themselves like Companion", async () => {
    turnOn();
    const slack = channelOwnerBinding(db, { subject: "slack:U000TEST", name: "Slack 私信" })!;
    createTurn(db, { id: "turn-dm", originBindingId: slack.id, originKind: "paired:companion", userText: "…", state: "streaming" });
    turnId = "turn-dm";
    const ends = await session([bash("echo from-dm")]);
    expect(ends[0]?.text.startsWith(HOST_RUN_MARK)).toBe(true);
    expect(wrap).not.toHaveBeenCalled();
    expect(started()[0]).toMatchObject({ turnOrigin: "live_user_slack_self_dm", via: "bash" });
  }, 90_000);

  // 回归（11-11 上午）：系统叫醒的一轮里 git push 退回沙箱，沙箱里没有凭证，推送失败；用户说「如果 bypass 都还要我审批，
  // 那 bypass 有啥意义呢」。
  it("runs outside the sandbox in a system turn, as Lead's own turn", async () => {
    turnOn();
    const ends = await session([bash("echo system-turn")]);
    expect(ends[0]?.text.startsWith(HOST_RUN_MARK)).toBe(true);
    expect(ends[0]?.text).toContain("system-turn");
    expect(wrap).not.toHaveBeenCalled();
    expect(started()).toEqual([expect.objectContaining({ turnId: null, turnOrigin: "lead_turn", command: "echo system-turn" })]);
  }, 90_000);

  // 回归（11-11 上午）：带 $(…) 的推送脚本、超过 400 字的命令被筛查器当成读不懂，退回沙箱。
  it("runs commands the screen cannot read outside the sandbox and records the rule", async () => {
    turnOn();
    companionTurn("turn-screen");
    const long = `echo ${"a".repeat(600)}`;
    const ends = await session([bash("echo $(echo nested)"), bash(long)]);
    expect(ends[0]?.text.startsWith(HOST_RUN_MARK)).toBe(true);
    expect(ends[0]?.text).toContain("nested");
    expect(ends[1]?.text.startsWith(HOST_RUN_MARK)).toBe(true);
    expect(wrap).not.toHaveBeenCalled();
    expect(started().map((event) => event.screen)).toEqual([
      { verdict: "allow", rule: "command-substitution" }, { verdict: "allow", rule: null },
    ]);
  }, 90_000);

  // 回归（11-11 上午）：这一轮查过一次连接（例如 PR 的状态），后面的命令全部退回沙箱。
  it("keeps running outside the sandbox after the turn reads external content when the decision model lets it", async () => {
    turnOn();
    companionTurn("turn-read");
    smart = { serves: 0.9, hard: 0.9 };
    const ends = await session([bash("echo before-read"), bash("echo after-read")], (index) => {
      if (index === 1) origin = withExternalContent(origin, { via: "tool", tool: "call_connection_tool" });
    });
    expect(ends.map((end) => end.text.startsWith(HOST_RUN_MARK))).toEqual([true, true]);
    expect(wrap).not.toHaveBeenCalled();
    expect(started()[0]).not.toHaveProperty("judgement");
    expect(started()[1]).toMatchObject({
      externalContent: ["tool call_connection_tool"], judgement: { servesUser: 0.9, hardToUndo: 0.9, backend: "fake" },
    });
  }, 90_000);

  it("refuses, with the next step, when the decision model says the command is not the user's and hard to undo, or cannot answer", async () => {
    turnOn();
    companionTurn("turn-injected");
    origin = withExternalContent(origin, { via: "tool", tool: "read_channel_conversation" });
    smart = { serves: 0.1, hard: 0.9 };
    const asked = await session([bash("echo not-run")]);
    smart = null;
    const unavailable = await session([bash("echo not-run-either")]);
    for (const end of [asked[0], unavailable[0]]) {
      expect(end?.isError).toBe(true);
      expect(end?.text).toMatch(/^bash 没有跑这条命令：这一轮用 read_channel_conversation 读了外部内容/);
      expect(end?.text).toContain("它也没有退回沙箱跑");
      expect(end?.text).toContain("run_on_host");
    }
    expect(asked[0]?.text).toContain("不像用户本人交代的事");
    expect(unavailable[0]?.text).toContain("没有配置决策模型");
    expect(wrap).not.toHaveBeenCalled();
    expect(started()).toEqual([]);
  }, 90_000);

  // 回归（.scratch/tool-occupancy/spec.md L5，用户 2026-11-11）：碰到底线的 bash 以前退回沙箱照样跑，看起来像成功了。
  it("refuses a command that hits a floor, names every rule with the next step, and runs it nowhere", async () => {
    turnOn();
    companionTurn("turn-floor");
    const ends = await session([
      bash(`cat ${join(dir, ".ssh", "id_ed25519")}; plc status`),
      bash("echo pay", { spends_money: true }),
    ]);
    for (const end of ends) {
      expect(end.isError).toBe(true);
      expect(end.text).toMatch(/^bash 没有跑这条命令：免沙箱开着，命令筛查碰到了底线/);
      expect(end.text).toContain("run_on_host");
    }
    expect(ends[0]?.text).toContain("命令会读凭证");
    expect(ends[0]?.text).toContain("命令用了 plc CLI");
    expect(ends[1]?.text).toContain("命令可能花钱");
    expect(wrap).not.toHaveBeenCalled();
    expect(started()).toEqual([]);
  }, 90_000);

  it("writes a shell startup file outside the sandbox and records the rule", async () => {
    turnOn();
    companionTurn("turn-startup");
    const ends = await session([bash(`echo '# test' > ${join(dir, ".zshrc")}`)]);
    expect(ends[0]?.text.startsWith(HOST_RUN_MARK)).toBe(true);
    expect(existsSync(join(dir, ".zshrc"))).toBe(true);
    expect(started()[0]).toMatchObject({ screen: { verdict: "allow", rule: "startup-file-write" } });
  }, 90_000);

  it("adds nothing to the result and stays in the sandbox when the switch is off", async () => {
    companionTurn("turn-off");
    const ends = await session([bash("echo switch-off")]);
    expect(ends[0]?.text.trim()).toBe("switch-off");
    expect(wrap).toHaveBeenCalledTimes(1);
    expect(started()).toEqual([]);
  }, 90_000);
});
