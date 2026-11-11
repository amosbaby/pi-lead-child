// Lead 的动手工具（lead-tools-and-routing spec D5、D8、D13）。用户 2026-10-27：Lead 的限制太多，一条路被堵住就没有
// 备选；连 pi 的 codemode 都被堵死了，结果事情要么用户手动做，要么请 Claude Code。所以 Lead 有了：
//   - bash：在沙箱里跑（core 的 sandboxPolicy，engine 的 sandboxedBashOperations）。能写的是 Lead 的临时目录和
//     plc 的隔离 worktree，不能读凭证。网络全开，密钥打码：沙箱里是占位值，发往绑定的主机时换成真值（2026-10-28）。
//     沙箱起不来时命令不跑。
//   - edit、write：和 bash 同一套边界（core 的 sandboxWriteBlocker），不能写凭证文件。沙箱管不到这两个工具，这里用
//     tool_call 钩子检查路径。
//   - codemode：在 session.ts 里加载（pi 内置的扩展），脚本里的调用照样经过这里和别的钩子。
// 外部消息叫醒的一轮里（Slack 这类别人写的话），这三个工具不用（D8，用户 2026-10-27 的办法）：要跑命令的活派沙箱里的
// 子 agent，结果交回 Lead 审核。拒绝写明这是能力缺口，并给出下一条路（D11、D13）。
// 只读了连接结果（例如用户自己 PR 的 CI 状态）的一轮、用户本人正在说话的一轮照用（用户 2026-10-29：「起码要让 lead agent
// 有能力处理」）：命令在沙箱里跑，沙箱挡住凭证和逃出去的路，它才是边界。
// 免沙箱（docs/ticket-246-user-turn-bypass.md，实施单 C）：开关开着、用户本人正在发话、这一轮没读过外部内容、命令过了
// 筛查器时，这一次 bash 在沙箱外跑（engine 的 hostBashOperations），结果开头写「（沙箱外）」。每次调用重新判断
// （hostCommandRoute）。开关开着但这一次退回沙箱时，结果开头写原因；开关关着时什么都不加，和以前一样。
// 筛查器说 floor 的 bash 直接拒绝，不退回沙箱（.scratch/tool-occupancy/spec.md L5，用户 2026-11-11）：退回沙箱的命令常常
// 什么都没做成，看起来却像成功了。拒绝写明碰到的每条规则和下一步（run_on_host 发确认卡）。
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createBashToolDefinition, type BashOperations, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  deniedHomeWritesIn, sandboxDenyWriteHomeLabels, sandboxPolicy, sandboxPolicyAsync, sandboxToolNote, sandboxWriteBlocker,
  type SandboxPolicy,
} from "@pi-lead-child/core";
import {
  copyScreenedScripts, HOST_COMMAND_LIMITS, hostBashOperations, newHostCommandId, sandboxedBashOperations, screenHitReason,
  screenHostCommand, screenReason, type HostCommandRecord, type ScreenResult,
} from "@pi-lead-child/engine";
import type { HostCommandVia } from "@pi-lead-child/protocol";
import type { Db } from "@pi-lead-child/store";
import { credentialPathReason, resolveLikePi } from "./credential-guard.js";
import { tildeHome } from "./home-paths.js";
import { isLiveUserTurn } from "@pi-lead-child/engine";
import { authorityTurnId, hostBypassActive, type LeadTurnOrigin, type TurnOriginDeps } from "./turn-origin.js";
import { DEFAULT_BACKGROUND_JOB_MAX_SECONDS } from "./background-jobs.js";

export const LEAD_HAND_TOOLS = ["bash", "edit", "write"] as const;
export const LEAD_CODEMODE_TOOL = "codemode";

/** Lead 的临时目录：写脚本、放中间结果。bash 的工作目录也在这里。 */
export function leadScratchDir(dataDir: string): string {
  return join(dataDir, "lead-scratch");
}

/** Lead 能写的地方：临时目录，加上 plc 还在用的隔离 worktree（例如给执行者装依赖、在旧代码上跑一次回归测试）。 */
export function leadWritableRoots(db: Db, dataDir: string): string[] {
  let worktrees: string[] = [];
  try {
    worktrees = (db.prepare(
      "SELECT path FROM workspaces WHERE mode = 'isolated' AND cleaned_at IS NULL"
        + " AND state NOT IN ('archived', 'released', 'failed') AND path IS NOT NULL",
    ).all() as Array<{ path: string }>).map((row) => row.path).filter((path) => isAbsolute(path));
  } catch {
    // 读不到工作区表（测试里的空库）：只有临时目录。
  }
  return [leadScratchDir(dataDir), ...worktrees];
}

export function leadSandboxPolicy(db: Db, dataDir: string): SandboxPolicy {
  return sandboxPolicy({ role: "lead", writable: leadWritableRoots(db, dataDir), dataDir });
}

/** leadSandboxPolicy 的异步版：要用的 git 目录和根证书先在子进程里查好（core 的 sandboxPolicyAsync）。跑命令、写文件之前用它。 */
export function leadSandboxPolicyAsync(db: Db, dataDir: string): Promise<SandboxPolicy> {
  return sandboxPolicyAsync({ role: "lead", writable: leadWritableRoots(db, dataDir), dataDir });
}

/** 外部消息叫醒的一轮里不用动手工具：给模型的说明（能力缺口，写出下一条路）。 */
export const EXTERNAL_TURN_HANDS_REFUSAL = "这一轮是外部消息（例如 Slack 里别人发的话）叫醒的，你自己不跑命令、不写文件"
  + "（能力缺口，不是底线）。换一条路：要跑命令或改文件的活派轻子 agent（create_task 的 light=true，再 spawn_child），"
  + "它在沙箱里做，结果交回给你审核；"
  + "只要查东西的，用读的工具和连接工具。";

/** 外部消息叫醒的一轮里不设命令检查（watch 的 check='command'）：到点它在同一个沙箱里跑命令，和 bash 是同一件事。 */
export const EXTERNAL_TURN_WATCH_REFUSAL = "这一轮是外部消息（例如 Slack 里别人发的话）叫醒的，命令检查到点会在你的沙箱里跑命令，"
  + "和 bash 一样不设（能力缺口，不是底线）。换一条路：用 check='agent' 的子代理检查（系统会请用户确认），"
  + "或者等用户本人的一轮再设。";

/** 外部消息叫醒的一轮里不设控件的数据源：它到点也在同一个沙箱里跑命令，和命令检查是同一件事。 */
export const EXTERNAL_TURN_WIDGET_SOURCE_REFUSAL = "这一轮是外部消息（例如 Slack 里别人发的话）叫醒的，控件的数据源到点会在你的沙箱里跑命令，"
  + "和 bash 一样不设（能力缺口，不是底线）。换一条路：先建不带 source 的控件（快照），或者等用户本人的一轮再加数据源。";

/**
 * 这一轮里动手工具（bash、edit、write、命令检查、控件的数据源）能不能用。不能用的只有外部消息叫醒的一轮：交来的事件里有外部消息，
 * 或者只知道是外部的一轮、不知道来源（按外部消息算）。只读了连接结果的一轮、用户本人正在说话的一轮都能用。
 */
export function handsBlockedInTurn(origin: LeadTurnOrigin, liveUser: boolean): boolean {
  if (liveUser || !origin.external) return false;
  const sources = origin.externalBy ?? [];
  if ((origin.externalEvents?.length ?? 0) > 0 || sources.some((source) => source.via === "message")) return true;
  return sources.length === 0;
}

// 沙箱挡住的 home 路径（core 的 SANDBOX_DENY_WRITE_HOME）：Lead、执行者、核查员、轻子 agent 的沙箱是同一套边界，
// 谁都写不了。2026-11-11 一位用户的 Lead 要卸掉 ~/.pi 下的一个 pi 扩展，先建单派了子 agent，子 agent 一样被挡，
// 白绕一圈才让用户自己在终端里跑 mv。所以这些路径一开始就走 run_on_host：run_on_host 的说明、系统提示词、
// edit/write/bash 被拒绝时的结果都指向它。

/** run_on_host 的说明用：沙箱挡住、子 agent 也写不了的 home 路径，要改时直接用 run_on_host。清单从 core 生成。 */
export function hostOnlyWriteNote(): string {
  return `home 下这些路径沙箱不让写：${sandboxDenyWriteHomeLabels().join("、")}。`
    + "子 agent（执行者、核查员、轻子 agent）的沙箱和你是同一套边界，也写不了它们。"
    + "要改这些路径（例如卸掉一个 pi 扩展、改 shell 的配置），一开始就用 run_on_host，不要建单、不要派子 agent 去试。";
}

// shell 里能直接用的写法：不用引号的字符原样写，别的加单引号。
function shellQuote(text: string): string {
  return /^[\w./@%+=:,-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

/** 命令里的一条路径：home 下的写成 ~/...（~ 不进引号，shell 才会展开它），别的照绝对路径写。 */
export function shellPath(path: string, home: string): string {
  const rel = relative(resolve(home), resolve(path));
  if (rel === "") return "~";
  if (!rel.startsWith("..") && !isAbsolute(rel)) return `~/${shellQuote(rel)}`;
  return shellQuote(path);
}

const SAME_BOUNDARY = "你和子 agent（执行者、核查员）的沙箱是同一套边界，都写不了这里，不要建单或派子 agent 去试。";
const HOST_RUN_NOTE = "用户在设置里开了免沙箱、又是用户本人发话的一轮时，run_on_host 直接在沙箱外跑；否则发一张确认卡，用户点了才跑。";

/** edit、write 写 SANDBOX_DENY_WRITE_HOME 里的路径被拒绝时，接在拒绝后面的改法：先写临时副本，再用 run_on_host 复制过去。 */
export function hostOnlyWriteRefusalHint(input: {
  tool: string; target: string; scratch: string; home: string; entries: readonly string[];
}): string {
  const copy = join(input.scratch, "host-writes", basename(input.target));
  const from = shellPath(copy, input.home);
  const to = shellPath(input.target, input.home);
  const steps = input.tool === "edit"
    ? [
      `用 bash 跑 mkdir -p ${shellPath(dirname(copy), input.home)} && cp ${to} ${from}（沙箱里能读）`,
      `用 edit 改 ${from}`,
      `用 run_on_host 跑 cp ${from} ${to}，reason 写清改了什么`,
    ]
    : [
      `用 write 把内容写到 ${from}`,
      `用 run_on_host 跑 mkdir -p ${shellPath(dirname(input.target), input.home)} && cp ${from} ${to}，reason 写清写了什么`,
    ];
  return `${input.entries.join("、")} 只能在沙箱外写。${SAME_BOUNDARY}改法：`
    + steps.map((step, index) => `${index + 1}. ${step}`).join("；") + `。${HOST_RUN_NOTE}`;
}

/**
 * bash 在沙箱里写 SANDBOX_DENY_WRITE_HOME 里的路径被拒绝时（输出里有 Operation not permitted，命令或输出提到这些路径），
 * 接在结果后面的话：改用 run_on_host 跑同一条命令。不是这种情况时为 null。
 */
export function bashHostOnlyWriteHint(input: { command: string; cwd: string; output: string; home: string }): string | null {
  if (!/operation not permitted/i.test(input.output)) return null;
  const entries = deniedHomeWritesIn(`${input.command}\n${input.output}`, input.home);
  if (!entries.length) return null;
  const how = input.command.length > HOST_COMMAND_LIMITS.command
    ? `命令超过 ${HOST_COMMAND_LIMITS.command} 个字符：先写成你临时目录里的脚本，再用 run_on_host 跑 bash <脚本>，cwd 填 ${shellPath(input.cwd, input.home)}。`
    : `改用 run_on_host 跑同一条命令，cwd 填 ${shellPath(input.cwd, input.home)}：\n${input.command}\n`;
  return `（沙箱挡住了写 ${entries.join("、")}。${SAME_BOUNDARY}${how}reason 写清要做什么。${HOST_RUN_NOTE}）`;
}

/**
 * edit、write 的路径为什么不能写。可以写时返回 null。边界和 bash 的沙箱是同一份（core 的 sandboxWriteBlocker）。
 * SANDBOX_DENY_WRITE_HOME 里的路径不算底线：拒绝后面接上用 run_on_host 的改法（hostOnlyWriteRefusalHint）。
 */
export function leadWriteRefusal(
  path: string, options: { cwd: string; home: string; policy: SandboxPolicy; tool?: string; scratch?: string },
): string | null {
  const credential = credentialPathReason(path, { cwd: options.cwd, home: options.home });
  if (credential) return `不能写凭证：${credential}（底线）。`;
  const absolute = resolveLikePi(path, { cwd: options.cwd, home: options.home });
  const blocker = sandboxWriteBlocker(options.policy, absolute);
  if (!blocker) return null;
  const entries = deniedHomeWritesIn(absolute, options.home);
  if (!entries.length) return `${blocker}（底线）。`;
  return `${blocker}。${hostOnlyWriteRefusalHint({
    tool: options.tool ?? "write", target: absolute, scratch: options.scratch ?? leadScratchDir(options.cwd), home: options.home, entries,
  })}`;
}

/** 在沙箱外跑的命令，工具结果开头写这一句（设计文档 5.3）。会话里的工具行据此加标记。 */
export const HOST_RUN_MARK = "（沙箱外）";

/** 开关开着、这一次却退回了沙箱时，工具结果开头写的话。 */
export function sandboxFallbackNote(why: string): string {
  return `（沙箱里：免沙箱开着，但这一次没有用——${why}）`;
}

/** 筛查器读不懂的 bash 退回沙箱时，接在原因后面的下一步。 */
const SCREEN_UNKNOWN_NEXT_STEP = "要在沙箱外跑，改成筛查器读得懂的写法（例如写成 lead-scratch 里的脚本，再用 bash <脚本>），"
  + "或者用 run_on_host 发确认卡";

/**
 * 筛查器说 floor 的 bash：不跑，也不退回沙箱。每条命中一行，写明下一步。只给模型看。
 */
export function bashFloorRefusal(screen: ScreenResult): string {
  const lines = screen.hits.map((hit) => `- ${screenHitReason(hit, "zh")}下一步：${hit.severity === "floor"
    ? "真要在 Mac 上跑，用 run_on_host，系统会给用户发确认卡，用户确认后才跑；用不着碰这个位置的，改写命令再用 bash。"
    : `${SCREEN_UNKNOWN_NEXT_STEP}。`}`);
  return "bash 没有跑这条命令：免沙箱开着，命令筛查碰到了底线。它也没有退回沙箱跑：退回沙箱的命令常常什么都没做成，"
    + `看起来却像成功了。碰到的规则：\n${lines.join("\n")}`;
}

export type HostCommandRoute =
  // 在沙箱外跑。run 是真正跑的命令（脚本换成筛查过的副本），record 写进 host_command.started。
  // 只记日志的命中（例如删除工作目录以外的东西）记在 record.screen.rule，logged 是全部这类命中。
  | { route: "host"; run: string; record: Omit<HostCommandRecord, "cwd" | "timeoutSeconds">; logged: ScreenResult["logged"] }
  // 照旧：bash 在沙箱里跑，run_on_host 发确认卡。why 是开关开着时这一次没有免沙箱的原因；开关关着时为 null。
  // screen 是筛查器没有放行时的结果：floor 时 bash 直接拒绝（bashFloorRefusal），run_on_host 照旧发确认卡。
  | { route: "sandbox"; why: string | null; screen?: ScreenResult };

type HostCommandRouteInput = {
  command: string; cwd: string; via: HostCommandVia; spendsMoney: boolean; dataDir: string; home?: string; now?: Date;
};

/**
 * 这一条命令在哪里跑（设计文档 3.1、第 4 节）：hostBypassActive 说能免沙箱，而且筛查器说 allow，才在沙箱外跑。
 * 筛查器的 floor 和 unknown 都退回今天的做法。bash 和 run_on_host 都用它，每次调用都重新算。判断本身出错时也退回。
 */
export function hostCommandRoute(db: Db, deps: TurnOriginDeps, input: HostCommandRouteInput): HostCommandRoute {
  try {
    return routeOf(db, deps, input);
  } catch (error) {
    return { route: "sandbox", why: `判断能不能免沙箱时出错（${error instanceof Error ? error.message : String(error)}）` };
  }
}

function routeOf(db: Db, deps: TurnOriginDeps, input: HostCommandRouteInput): HostCommandRoute {
  const decision = hostBypassActive(db, deps, input.now);
  if (!decision.active) return { route: "sandbox", why: decision.why };
  const home = input.home ?? homedir();
  const screen = screenHostCommand({
    command: input.command, cwd: input.cwd, allowedRoots: leadWritableRoots(db, input.dataDir), dataDir: input.dataDir, home,
    spendsMoney: input.spendsMoney,
    credentialPathReason: (path, context) => credentialPathReason(path, context),
  });
  if (screen.verdict !== "allow") {
    const reason = screenReason(screen, "zh") ?? screen.rule ?? screen.verdict;
    return { route: "sandbox", why: `命令筛查没有放行（${screen.verdict}）：${reason}`, screen };
  }
  return {
    route: "host",
    run: screen.scripts.length ? copyScreenedScripts(input.command, screen.scripts, tmpdir()) : input.command,
    record: {
      id: newHostCommandId(), turnId: decision.turnId, turnOrigin: decision.turnOrigin, via: input.via, confirmationId: null,
      command: input.command, screen: { verdict: screen.verdict, rule: screen.logged[0]?.rule ?? null }, spendsMoney: input.spendsMoney,
    },
    logged: screen.logged,
  };
}

/**
 * Lead 的 bash 不填 timeout 时的时限（秒）。pi 的 bash 缺省不设时限：2026-11-03 Lead 在仓库根目录跑了一条 grep -r，
 * 扫进了几十个工作树的 node_modules，15 分钟没有结束，这一轮一直停在 Running。要跑更久的命令，模型自己填 timeout。
 */
export const LEAD_BASH_DEFAULT_TIMEOUT_SECONDS = 120;

/** 没填 timeout 的命令按 seconds 秒的时限跑。到时限时 pi 结束命令，告诉模型「Command timed out after N seconds」。 */
export function withDefaultTimeout(operations: BashOperations, seconds: number): BashOperations {
  return {
    exec: (command, cwd, run) => operations.exec(command, cwd, { ...run, timeout: run.timeout ?? seconds }),
  };
}

export interface LeadHandsOptions {
  db: Db;
  dataDir: string;
  turnOrigin?: () => LeadTurnOrigin;
  // 这一轮的编号：用户本人正在说话的一轮不受外部内容的限制（isLiveUserTurn）。
  currentTurnId?: () => string | null;
  home?: string;
  log?: (line: string) => void;
  // bash 不填 timeout 时的时限（秒），缺省 LEAD_BASH_DEFAULT_TIMEOUT_SECONDS。测试用短的。
  bashTimeoutSeconds?: number;
}

/** 工具结果的第一段文字前面加一句。 */
function withLeadingNote<T extends { content: Array<{ type: string; text?: string }> }>(result: T, note: string): T {
  const index = result.content.findIndex((part) => part.type === "text");
  if (index < 0) return { ...result, content: [{ type: "text", text: note }, ...result.content] };
  const content = result.content.map((part, at) => (at === index ? { ...part, text: `${note}\n${part.text ?? ""}` } : part));
  return { ...result, content };
}

/** 工具结果的最后一段文字后面加一句。 */
function withTrailingNote<T extends { content: Array<{ type: string; text?: string }> }>(result: T, note: string): T {
  const index = result.content.map((part) => part.type).lastIndexOf("text");
  if (index < 0) return { ...result, content: [...result.content, { type: "text", text: note }] };
  const content = result.content.map((part, at) => (at === index ? { ...part, text: `${part.text ?? ""}\n${note}` } : part));
  return { ...result, content };
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => part.text ?? "").join("\n");
}

/** pi 扩展：沙箱里的 bash（替换 pi 内置的），以及三个动手工具的检查。 */
export function leadHandsExtension(options: LeadHandsOptions): ExtensionFactory {
  const scratch = leadScratchDir(options.dataDir);
  const home = options.home ?? homedir();
  const timeoutSeconds = options.bashTimeoutSeconds ?? LEAD_BASH_DEFAULT_TIMEOUT_SECONDS;
  return (pi) => {
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const sandboxed = sandboxedBashOperations(() => leadSandboxPolicyAsync(options.db, options.dataDir));
    const bash = createBashToolDefinition(scratch, { operations: withDefaultTimeout(sandboxed, timeoutSeconds) });
    pi.registerTool({
      ...bash,
      // pi 的参数说明写着「没有缺省时限」：换成 Lead 的缺省，模型才知道长命令要自己填。
      parameters: Type.Object({
        command: Type.String({ description: "Shell command to execute" }),
        timeout: Type.Optional(Type.Number({
          description: `Timeout in seconds. Without it, the command stops after ${timeoutSeconds} seconds.`,
        })),
        spends_money: Type.Optional(Type.Boolean({
          description: "true when you think the command spends money (cloud resources, paid APIs, deploys).",
        })),
        read_only: Type.Optional(Type.Boolean({
          description: "true when the command only reads or is safe to run again (grep, find, tests, builds, reading a system). "
            + "Without timeout it may run up to 30 minutes. When the system stops your step, a read_only command stops too; "
            + "any other command keeps running in the background. Leave it out for a command that changes anything.",
        })),
      }),
      // 每次调用按这一次的命令和目录选沙箱或主机（hostCommandRoute）。pi 的 bash 工具照旧管输出、截断和错误写法。
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        let note: string | null = null;
        // 在沙箱里跑时的目录：被沙箱挡住写 SANDBOX_DENY_WRITE_HOME 的路径时，结果后面接上 run_on_host 的写法。
        let sandboxCwd: string | null = null;
        const hostHint = (output: string) => sandboxCwd === null ? null : bashHostOnlyWriteHint({
          command: String((params as { command?: unknown }).command ?? ""), cwd: sandboxCwd, output, home,
        });
        const spendsMoney = (params as { spends_money?: unknown }).spends_money === true;
        const routeOfCall = (command: string, cwd: string) => hostCommandRoute(options.db, options, {
          command, cwd, via: "bash", spendsMoney, dataDir: options.dataDir, home,
        });
        // 先按这一次的命令判断一次：碰到底线的直接拒绝，不跑，也不退回沙箱（L5）。
        // pi 的 bash 用会话的 cwd，没有时用 scratch（createBashToolDefinition）；这里按同一个目录判断，exec 时直接用这一次的结果。
        const command = String((params as { command?: unknown }).command ?? "");
        const cwd = (ctx as { cwd?: string } | undefined)?.cwd || scratch;
        let first: HostCommandRoute | null = routeOfCall(command, cwd);
        if (first.route === "sandbox" && first.screen?.verdict === "floor") {
          options.log?.(`[lead] bash refused by the host screen: ${first.screen.hits.map((hit) => hit.rule).join(", ")}`);
          throw new Error(bashFloorRefusal(first.screen));
        }
        const routed: BashOperations = {
          exec: (runCommand, runCwd, run) => {
            const route = first && runCommand === command && runCwd === cwd ? first : routeOfCall(runCommand, runCwd);
            first = null;
            if (route.route === "sandbox") {
              // pi 改过命令或目录、又碰到底线时，同样不退回沙箱。
              if (route.screen?.verdict === "floor") return Promise.reject(new Error(bashFloorRefusal(route.screen)));
              note = route.why
                ? sandboxFallbackNote(route.screen?.verdict === "unknown" ? `${route.why}${SCREEN_UNKNOWN_NEXT_STEP}` : route.why)
                : null;
              sandboxCwd = runCwd;
              return sandboxed.exec(runCommand, runCwd, run);
            }
            note = HOST_RUN_MARK;
            sandboxCwd = null;
            const logged = route.logged.map((hit) => `${hit.rule} ${hit.detail}`).join("; ");
            options.log?.(`[lead] bash runs outside the sandbox (${route.record.id})${logged ? `; screen logged: ${logged}` : ""}`);
            return hostBashOperations(options.db, { record: route.record, dataDir: options.dataDir }).exec(route.run, runCwd, run);
          },
        };
        // 跑过软时限、用户插话、调度器为了空出 Lead 而中止时，中止兜底把这次调用转到后台（tool-abort-guard.ts）。
        // 只读的命令（read_only）没填 timeout 时最多跑 30 分钟；改东西的命令照旧按 Lead 的缺省时限。
        const readOnly = (params as { read_only?: unknown }).read_only === true;
        const call = createBashToolDefinition(scratch, {
          operations: withDefaultTimeout(routed, readOnly ? DEFAULT_BACKGROUND_JOB_MAX_SECONDS : timeoutSeconds),
        });
        try {
          const result = await call.execute(toolCallId, params, signal, onUpdate, ctx);
          const hint = hostHint(resultText(result));
          const hinted = hint ? withTrailingNote(result, hint) : result;
          return note ? withLeadingNote(hinted, note) : hinted;
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          const hint = hostHint(error.message);
          if (!note && !hint) throw error;
          throw new Error(`${note ? `${note}\n` : ""}${error.message}${hint ? `\n${hint}` : ""}`);
        }
      },
      // 工具说明每一轮都发给模型服务商：用户目录写成 ~（home-paths.ts，用户 2026-10-30）。
      description: tildeHome(`${bash.description}\n工作目录是 ${scratch}。`
        + `不填 timeout 时，命令跑到 ${timeoutSeconds} 秒就结束；要跑更久的命令（装依赖、跑测试）自己填 timeout。`
        + "命令跑过 20 秒还没完、或者用户插话时，转到后台：你拿到作业编号，结束时系统把输出交给你，这期间用户的消息能送到你这里；要停掉它用 stop_job。"
        + "只读或可以重跑的命令（搜索、跑测试、构建、查外部系统）标 read_only=true。改东西的命令不要标。"
        + "在仓库里找文件、搜代码用 find、grep 工具，读已知的文件用 read：它们按 .gitignore 跳过 node_modules 这类目录。"
        + "bash 里的 grep -r、find 不会跳过它们，在大仓库里会跑很久。"
        + sandboxToolNote(leadSandboxPolicy(options.db, options.dataDir), "整个 home（挡住会在沙箱外执行的地方，清单和改法见 run_on_host 的说明）、plc 的隔离 worktree")
        + "\n发评审、发消息这类写外部账号的事用连接工具：那里有你的账号和护栏。", home),
    });
    pi.on("tool_call", async (event) => {
      if (!(LEAD_HAND_TOOLS as readonly string[]).includes(event.toolName)) return undefined;
      const origin = options.turnOrigin?.();
      if (origin && handsBlockedInTurn(origin, origin.external && isLiveUserTurn(
        options.db, authorityTurnId({ ...options, turnOrigin: () => origin }), "tickets:create",
      ))) {
        options.log?.(`[lead] ${event.toolName} refused in an external turn`);
        return { block: true, reason: EXTERNAL_TURN_HANDS_REFUSAL };
      }
      if (event.toolName === "bash") return undefined;
      const input = event.input as Record<string, unknown>;
      const path = typeof input.path === "string" ? input.path : "";
      if (!path.trim()) return undefined;
      const reason = leadWriteRefusal(path, {
        cwd: options.dataDir, home, policy: await leadSandboxPolicyAsync(options.db, options.dataDir), tool: event.toolName, scratch,
      });
      if (!reason) return undefined;
      options.log?.(`[lead] ${event.toolName} refused outside the writable roots`);
      return { block: true, reason };
    });
  };
}
