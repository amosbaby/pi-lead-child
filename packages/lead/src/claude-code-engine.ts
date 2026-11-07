// Lead 的 claude-code 后端（2026-11-03，docs/lead-claude-code-backend.md）：用用户本机已经登录的 Claude Code，
// 经官方 Claude Agent SDK 的流式输入模式（一个常驻的 query，用户消息一条条送进去）。实现 engine.ts 的 LeadEngine 端口，
// daemon 照旧只认 pi 的那几种事件（message_start、message_update 的 text_delta、message_end、tool_execution_start/end、
// compaction_start/end、auto_retry_start），这里把 SDK 的消息译成它们。
//
// 合规（用户 2026-11-03 定的）：只给个人自用，要自己在 config.json 里打开，缺省是 pi。这里不碰任何凭据：不读、不传、不存 key 或
// token，不给 SDK 传 apiKey；给 claude 子进程的是 daemon 的环境原样（claudeCodeEnv），Claude Code 自己选认证、用它自己的登录
// （https://code.claude.com/docs/en/agent-sdk/overview）。
// 安全：Claude Code 的内置工具只开工具搜索（tools: [ToolSearch]，只找 Lead 自己的工具），不读任何设置文件（settingSources: []），只认这里给的 MCP 服务器
// （strictMcpConfig），只放行名单里的 Lead 工具（allowedTools），别的调用一律拒绝（permissionMode: dontAsk），从不 bypassPermissions。
// Lead 工具的检查（pi 扩展的那些）在 MCP 处理函数里围着同一个 execute 跑（claude-code-tools.ts、tool-guards.ts）。
// 会话不落盘（persistSession: false）：daemon 重启以后从头开始，Lead 从账本重建上下文。
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  EffortLevel, McpSdkServerConfigWithInstance, ModelInfo, Options, Query, SDKMessage, SDKUserMessage, SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { envConfigPath } from "@pi-lead-child/core";
import { designPreferencesFields, redactSecretText } from "@pi-lead-child/protocol";
import { claudeAutoCompactWindowTokens, findRuntimeExecutable } from "@pi-lead-child/runtime";
import {
  getDesignPreferences, getLeadProfile, getReplyStyle, leadProfileFields, recordDecisionModelCall, renderCoreMemory,
  renderStandingOrdersForLead,
} from "@pi-lead-child/store";
import {
  createSmartModel, smartModelDecisionLogPath, type SmartModel, type SmartModelCallObserver, type SmartTextComplete,
} from "@pi-lead-child/engine";
import { createClaudeCodeCompletion } from "./claude-code-complete.js";
import type { LeadEngine, LeadEngineFactoryResult } from "./engine.js";
import type { createLeadSession } from "./session.js";
import { createLeadToolset, type LeadDeps } from "./tools.js";
import { renderLeadSystemPrompt } from "./prompt.js";
import { renderLeadIdentity } from "./identity.js";
import { renderAppearance } from "./appearance.js";
import { renderReplyStyle } from "./reply-style.js";
import { collectLeadEnvironment, renderEnvironmentDetails, renderLeadEnvironment } from "./environment.js";
import { knownSecretValues } from "./credential-guard.js";
import { TurnEvidence } from "./credibility/evidence.js";
import { replyCodeRefCorrection, touchedTickets } from "./credibility/extension.js";
import { createLeadToolGuards } from "./tool-guards.js";
import { isLeadEvidenceTool } from "./session.js";
import { tildeHome } from "./home-paths.js";
import { leadSystemEvent } from "./envelope.js";
import { formatTokenCount } from "./cost-signals.js";
import { CLAUDE_CODE_MODEL_PROVIDER, claudeCodeModelChoice, DEFAULT_CLAUDE_CODE_MODEL } from "./lead-backend.js";
import {
  CLAUDE_CODE_EXCLUDED_TOOLS, CLAUDE_CODE_TOOL_SERVER, claudeCodeMcpTools, leadToolName, selectClaudeCodeTools,
  type ClaudeCodeToolBridge, type LeadToolResult,
} from "./claude-code-tools.js";

// SDK 在起 query 时才加载（loadClaudeAgentSdk）。打包后的 daemon 是一个文件，esbuild 把 lead-backend.ts 的动态 import 内联了：
// 这里要是静态 import SDK，daemon 一启动就要加载它，选 pi、没装 SDK 时 daemon 也起不来。
export type ClaudeAgentSdk = Pick<typeof import("@anthropic-ai/claude-agent-sdk"), "query" | "createSdkMcpServer">;
const loadClaudeAgentSdk = (): Promise<ClaudeAgentSdk> => import("@anthropic-ai/claude-agent-sdk");

// ——— 给 claude 子进程的环境 ———

/**
 * 给 claude 子进程的环境：daemon 的环境原样一份（SDK 的 env 是整个替换子进程的环境，不是合并）。
 * 不拿掉、不加任何认证变量（2026-11-03 合规审阅：Anthropic 的法律与合规说明要求不去掉、不限制 Claude Code 自带的认证方式，
 * https://code.claude.com/docs/en/legal-and-compliance）。Claude Code 自己按它的先后选认证
 * （https://code.claude.com/docs/en/authentication#authentication-precedence）：环境里有 ANTHROPIC_API_KEY 时它会用这个 key、
 * 按 API 计费。pi-lead-child 不读、不记这些变量的值；Claude Code 实际用的来源由 system:init 的 apiKeySource 报告
 * （claudeCodeAuthSourceText），记进日志和 get_environment。
 */
export function claudeCodeEnv(env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  return { ...env };
}

/**
 * Lead 会话的压缩线（token），也是它的下限。daemon 的环境里设了 CLAUDE_CODE_AUTO_COMPACT_WINDOW、又不小于它时用环境的（leadAutoCompactWindow）。
 * 压缩由 Claude Code 自己做（settingSources 为空，读不到 /autocompact 写的设置），1M 窗口的模型默认几乎不压缩：
 * 2026-11-06 一个 opus 会话涨到 857k，每次唤醒按调用把整段重读几遍，一段会话估算 $57。
 * 变量取值 100000–1000000（https://code.claude.com/docs/en/env-vars.md）。
 */
export const LEAD_AUTO_COMPACT_WINDOW = "200000";

/**
 * 给 claude 子进程的压缩线：环境里的值读得出、又不小于 LEAD_AUTO_COMPACT_WINDOW 时用它，不然用 LEAD_AUTO_COMPACT_WINDOW。
 * Claude Code 在窗口减去约 3.3 万处压缩（2.1.312 实测 getContextUsage：100000 → 67000，200000 → 167000），
 * Lead 的新会话光系统提示词和工具声明就约 8 万：2026-11-07 环境里设成 100000 以后，每次调用都压缩，
 * 三轮内压缩三次，Claude Code 判定「Autocompact is thrashing」，这一轮失败。值的读法见 runtime 的 claudeAutoCompactWindowTokens。
 */
export function leadAutoCompactWindow(configured: string | undefined): string {
  const tokens = claudeAutoCompactWindowTokens(configured);
  return tokens !== null && tokens >= Number(LEAD_AUTO_COMPACT_WINDOW) ? configured!.trim() : LEAD_AUTO_COMPACT_WINDOW;
}

// Claude Code 的压缩抖动保护（压缩后三轮内又满、连续三次）报的错。这个会话接着用只会再抖：下一轮换一个新的 query（retireThrashedSession）。
const AUTOCOMPACT_THRASHING = "Autocompact is thrashing";

/** Claude Code 的工具搜索（内置工具 ToolSearch）。不常用的 Lead 工具不预先声明，Lead 用它找（https://code.claude.com/docs/en/mcp.md 的 tool search）。 */
export const CLAUDE_CODE_TOOL_SEARCH = "ToolSearch";

/** 空闲这么久以后（缓存过期），上下文不小于 LEAD_IDLE_RESET_MIN_TOKENS 的会话在下一轮换成新的（retireIdleSession）。 */
export const LEAD_IDLE_RESET_MS = 60 * 60_000;
// 新会话开头就有约 10 万（系统提示词和工具声明，2026-11-06 的日志），比它大一截才值得重建。
export const LEAD_IDLE_RESET_MIN_TOKENS = 150_000;

/**
 * Claude Code 报告的认证来源（system:init 的 apiKeySource，是来源的名字，不是 key）写成一句话：用户能看出这一次是不是按 API 计费。
 * none 证明不了一定是订阅的 OAuth 登录，所以只说「通常是」。
 * 来源的名字照 SDK 的 ApiKeySource 类型（0.3.317）。
 */
export function claudeCodeAuthSourceText(source: string | null): string {
  switch (source) {
    case null:
      return "还不知道（Claude Code 还没有启动）";
    case "none":
    case "oauth":
      return `通常是 Claude Code 自己的登录（/login），用量算你自己的计划（来源报告为 ${source}，没有用 API key）`;
    case "ANTHROPIC_API_KEY":
      return "环境里的 ANTHROPIC_API_KEY（会按 API 计费，不用订阅额度）";
    case "apiKeyHelper":
      return "Claude Code 设置里的 apiKeyHelper 给的 API key（会按 API 计费）";
    case "/login managed key":
      return "Claude Code 的 /login 登录的 Console API key（会按 API 计费）";
    default:
      return `Claude Code 报告的来源是 ${source.slice(0, 40)}（用的是 API key 时按 API 计费）`;
  }
}

// ——— 检测：claude 装了没有、登录了没有 ———

// authMethod：`claude auth status --json` 报告的认证方式的名字（claude.ai、api_key、oauth_token、third_party……，不是 key）。
export type ClaudeCodeAvailability = { ok: true; executable: string; authMethod?: string } | { ok: false; reason: string };

export type ClaudeCodeAuthProbe = (
  executable: string, env: Record<string, string | undefined>,
) => Promise<{ exitCode: number | null; stdout: string; error?: string }>;

const AUTH_STATUS_TIMEOUT_MS = 15_000;

// `claude auth status --json`，环境和 Lead 的 claude 子进程一样（daemon 的环境原样）。输出里有账号信息：只交回原文给 detectClaudeCode，
// 它只读 loggedIn 和 authMethod，不记日志。
const defaultAuthProbe: ClaudeCodeAuthProbe = (executable, env) => new Promise((resolve) => {
  execFile(executable, ["auth", "status", "--json"], { env, timeout: AUTH_STATUS_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? null : 0;
    resolve({
      exitCode: code,
      stdout: String(stdout ?? ""),
      ...(error && code === null ? { error: (error as Error).message } : {}),
    });
  });
});

/**
 * Claude Code 能不能给 Lead 用：找得到 claude（PLC_CLAUDE_BIN 或 PATH，和执行器同一种找法），`claude auth status --json`
 * 说 loggedIn 是 true。只读 loggedIn 和 authMethod（认证方式的名字）两个字段，输出的其余部分（账号信息）不记、不传。不能用时给一句告诉用户怎么办的原因。
 */
export async function detectClaudeCode(options: {
  env?: Record<string, string | undefined>;
  find?: (nameOrPath: string) => string | null;
  probe?: ClaudeCodeAuthProbe;
} = {}): Promise<ClaudeCodeAvailability> {
  const env = options.env ?? process.env;
  const find = options.find ?? ((name: string) => findRuntimeExecutable(name, env.PATH ?? ""));
  const executable = find(env.PLC_CLAUDE_BIN?.trim() || "claude");
  if (!executable) {
    return {
      ok: false,
      reason: "Lead 用不了 Claude Code：找不到 claude 命令（config.json 的 lead.backend 是 claude-code）。"
        + "装好 Claude Code 并登录，或者把 lead.backend 改回 pi，然后重启 daemon。",
    };
  }
  let status: Awaited<ReturnType<ClaudeCodeAuthProbe>>;
  try {
    status = await (options.probe ?? defaultAuthProbe)(executable, claudeCodeEnv(env));
  } catch (error) {
    status = { exitCode: null, stdout: "", error: error instanceof Error ? error.message : String(error) };
  }
  let loggedIn: unknown;
  let authMethod: unknown;
  try {
    const parsed = JSON.parse(status.stdout) as { loggedIn?: unknown; authMethod?: unknown } | null;
    loggedIn = parsed?.loggedIn;
    authMethod = parsed?.authMethod;
  } catch {
    loggedIn = undefined;
  }
  // loggedIn 是 Claude Code 自己算的：/login 的登录、环境里的 API key、云服务商都算（不限制它的认证方式）。
  if (loggedIn === true) {
    return { ok: true, executable, ...(typeof authMethod === "string" && authMethod ? { authMethod: authMethod.slice(0, 40) } : {}) };
  }
  if (loggedIn === false) {
    return {
      ok: false,
      reason: "Lead 用不了 Claude Code：认证失败，claude 没有登录（claude auth status 说 loggedIn 是 false）。"
        + "在终端里运行 claude 登录，或者把 lead.backend 改回 pi。",
    };
  }
  return {
    ok: false,
    reason: `Lead 用不了 Claude Code：看不出 claude 有没有登录（claude auth status --json ${status.exitCode === null ? "没有跑完" : `退出码 ${status.exitCode}`}）。`
      + "在终端里运行 claude auth status 看看，或者把 lead.backend 改回 pi。",
  };
}

/** 检测结果缓存一会儿：大脑状态和每一轮开始前都会问，不必每次都跑 claude auth status。 */
export function cachedClaudeCodeDetector(detect: () => Promise<ClaudeCodeAvailability>, ttlMs = 30_000, now = Date.now) {
  let cached: { at: number; value: Promise<ClaudeCodeAvailability> } | null = null;
  return (): Promise<ClaudeCodeAvailability> => {
    if (!cached || now() - cached.at > ttlMs) {
      const value = detect();
      cached = { at: now(), value };
      value.catch(() => { cached = null; });
    }
    return cached.value;
  };
}

// ——— SDK 的选项 ———

export interface ClaudeCodeQueryOptionsInput {
  executable: string;
  cwd: string;
  sessionId: string;
  model: string;
  // 推理强度（SDK 的 Options.effort）。没有时为 null 或者不给：用模型自己的缺省。daemon 已经按模型能选的查过。
  effort?: string | null;
  systemPrompt: string;
  mcpServer: McpSdkServerConfigWithInstance;
  allowedTools: readonly string[];
  // daemon 的环境；缺省 process.env。原样给子进程（claudeCodeEnv）。
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

/**
 * 给 SDK 的选项（纯函数，测试断言它）。没有 apiKey，环境原样（Claude Code 自己选认证），不读设置文件，
 * 内置工具全关，只有 Lead 的 MCP 服务器，只放行名单里的工具，会话不落盘。
 * 权限模式是 dontAsk（第二阶段起，写工具也在名单里）：名单里的工具（allowedTools）照常跑，别的一切调用直接拒绝，不问任何人、
 * 不调 canUseTool（https://code.claude.com/docs/en/agent-sdk/permissions 的 Don't ask mode：「a fixed, explicit tool surface
 * for a headless agent」）。审批、授权和确认卡是 pi-lead-child 自己的账本和操作层管的，不靠 Claude Code 的权限提示；
 * Lead 的检查在 MCP 处理函数里（tool-guards.ts）。从不 bypassPermissions。
 */
export function claudeCodeQueryOptions(input: ClaudeCodeQueryOptionsInput): Options {
  const env = claudeCodeEnv(input.env);
  const configured = env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  const compactWindow = leadAutoCompactWindow(configured);
  if (configured !== undefined && configured !== compactWindow) {
    input.log?.(`[lead] claude-code: CLAUDE_CODE_AUTO_COMPACT_WINDOW=${clip(configured)} is below the Lead's ${LEAD_AUTO_COMPACT_WINDOW} floor or unreadable; using ${compactWindow}`);
  }
  return {
    pathToClaudeCodeExecutable: input.executable,
    // SDK 的 env 是整个替换子进程的环境（不是合并），所以给的是 daemon 环境的一份原样拷贝，只定一个压缩线（不小于下限）。
    env: { ...env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: compactWindow },
    cwd: input.cwd,
    sessionId: input.sessionId,
    settingSources: [],
    strictMcpConfig: true,
    // 内置工具只开工具搜索：不常用的 Lead 工具不预先声明（claude-code-tools.ts），要用时搜。它不读写任何东西。
    tools: [CLAUDE_CODE_TOOL_SEARCH],
    skills: [],
    mcpServers: { [CLAUDE_CODE_TOOL_SERVER]: input.mcpServer },
    allowedTools: [...input.allowedTools, CLAUDE_CODE_TOOL_SEARCH],
    permissionMode: "dontAsk",
    persistSession: false,
    // 用户自己装的插件和设置里的 hooks 不在 Lead 的会话里跑（例如把对话同步到别处的 hook）。管理员下发的 hooks 照常跑，这里关不掉，也不该关。
    settings: { disableAllHooks: true },
    includePartialMessages: true,
    model: input.model,
    ...(input.effort ? { effort: input.effort as EffortLevel } : {}),
    systemPrompt: input.systemPrompt,
    stderr: (data: string) => {
      const line = redactSecretText(data.trim());
      if (line) input.log?.(`[lead] claude-code stderr: ${line.length > 400 ? `${line.slice(0, 400)}…` : line}`);
    },
  };
}

// ——— 流式输入 ———

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.items.push(message);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

// ——— 错误的说法：daemon 的健康和模型切换按原文分类（protocol 的 classifyLeadModelError、model-failover.ts） ———

function clip(text: string, max = 300): string {
  const flat = redactSecretText(text.replace(/\s+/g, " ").trim());
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

type RateLimitInfo = { status?: string; resetsAt?: number; rateLimitType?: string; overageStatus?: string };

/** 额度用完：说法里有 usage limit（模型切换按额度用尽算）和服务端给的恢复时间（resets in N seconds）。 */
export function claudeCodeRateLimitText(info: RateLimitInfo | null, now: number = Date.now()): string {
  const window = info?.rateLimitType ? `, ${info.rateLimitType} window` : "";
  let reset = "";
  if (typeof info?.resetsAt === "number" && Number.isFinite(info.resetsAt)) {
    const at = info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt;
    reset = `; resets in ${Math.max(0, Math.round((at - now) / 1000))} seconds`;
  }
  return `Claude Code usage limit reached (rate limit${window})${reset}. This is the user's own Claude subscription limit, shared with their own Claude Code use.`;
}

/** SDK 的 assistant 消息上的 error（SDKAssistantMessageError）译成一句原文。 */
export function claudeCodeAssistantErrorText(code: string, text: string, rateLimit: RateLimitInfo | null, now: number = Date.now()): string {
  const detail = text.trim() ? `：${clip(text)}` : "";
  switch (code) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
    case "account_on_hold":
    case "verification_required":
      return `Claude Code authentication failed (${code})：在终端里运行 claude 重新登录，或者把 lead.backend 改回 pi${detail}`;
    case "rate_limit":
      return rateLimit ? claudeCodeRateLimitText(rateLimit, now) : `Claude Code rate limit (rate_limit)${detail}`;
    case "billing_error":
      return `Claude Code billing error: usage limit or billing problem (billing_error)${detail}`;
    case "overloaded":
      return `Claude Code: the model is overloaded (overloaded)${detail}`;
    case "server_error":
      return `Claude Code: the model service is unavailable (server_error)${detail}`;
    case "model_not_found":
      return `Claude Code: model not found (model_not_found)，检查 config.json 的 lead.claudeCode.models${detail}`;
    case "max_output_tokens":
      return `Claude Code: the reply hit the max output tokens (max_output_tokens)${detail}`;
    default:
      return `Claude Code error (${code})${detail}`;
  }
}

// ——— 引擎 ———

type ImageContent = NonNullable<Parameters<AgentSession["steer"]>[1]>[number];
type QueuedInputDisposition = Awaited<ReturnType<AgentSession["steer"]>>;

type Listener = (event: AgentSessionEvent) => void;

interface Run {
  // 这一次运行送进去、还没有被哪一轮的 result 认领的用户消息（SDKUserMessage 的 uuid）。
  awaiting: Set<string>;
  // 给 beforeSettle 的：这次运行 Lead 的回答、送进去的消息、工具调用的参数；更正送过没有。
  texts: string[];
  prompts: string[];
  toolArgs: unknown[];
  settleChecked: boolean;
  // 还没起好 query 时就被 abort 了（例如在检测登录时用户按了停止）：起好以后不再送消息。
  abortedEarly?: boolean;
  resolve: () => void;
  promise: Promise<void>;
}

interface PendingAssistant {
  id: string | null;
  blocks: Array<Record<string, unknown>>;
  // 流过来的文字。完整的 assistant 消息没有到（流断了、被中断）时，message_end 用它。
  streamed: string;
  stopReason: string | null;
  error: string | null;
  model: string | null;
  // 这一次模型调用的用量（流里的 message_start、message_delta 和完整的 assistant 消息上的 usage）。没有时为 null。
  usage: TokenUsage | null;
}

// supportedModels() 的缓存多久再问一次、最多等多久（输入框的模型列表在等它）。
const SUPPORTED_MODELS_TTL_MS = 5 * 60_000;
const SUPPORTED_MODELS_TIMEOUT_MS = 5_000;
// getContextUsage() 最多等多久。每一轮的 result 以后问一次（不在一轮中间问），问不到时用上一次的。
const CONTEXT_USAGE_TIMEOUT_MS = 5_000;

// ——— 用量（2026-11-04，用户：「先补用量可见」）———
// 一次模型调用的用量，字段名照 pi 的 message.usage（pi-ai 的 Usage）：input 不含缓存，cacheRead、cacheWrite 分开。
// 来源是 Anthropic 的 BetaUsage（SDKAssistantMessage.message.usage，流里 message_start 的 message.usage、message_delta 的 usage）：
// input_tokens、output_tokens、cache_read_input_tokens、cache_creation_input_tokens。
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const USAGE_FIELDS: ReadonlyArray<[keyof TokenUsage, string]> = [
  ["input", "input_tokens"], ["output", "output_tokens"], ["cacheRead", "cache_read_input_tokens"], ["cacheWrite", "cache_creation_input_tokens"],
];

/** 把一份 BetaUsage 并进 into（同一次调用里的数只增不减：每个字段取大的）。不是数的字段不管。没有可用的数时原样返回。 */
function mergeUsage(into: TokenUsage | null, raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== "object") return into;
  let next = into;
  for (const [field, wire] of USAGE_FIELDS) {
    const value = (raw as Record<string, unknown>)[wire];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    next ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    next[field] = Math.max(next[field], value);
  }
  return next;
}

const usageTotal = (usage: TokenUsage) => usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

// result 的 modelUsage（SDK 的 ModelUsage）里用得到的几个数：这个 query 到现在为止的累计。
interface ModelTotals { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number }

function modelTotals(raw: unknown): Map<string, ModelTotals> {
  const totals = new Map<string, ModelTotals>();
  if (!raw || typeof raw !== "object") return totals;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  for (const [model, entry] of Object.entries(raw as Record<string, Record<string, unknown> | null>)) {
    if (!entry || typeof entry !== "object") continue;
    totals.set(model.slice(0, 100), {
      input: num(entry.inputTokens), output: num(entry.outputTokens), cacheRead: num(entry.cacheReadInputTokens),
      cacheWrite: num(entry.cacheCreationInputTokens), costUsd: num(entry.costUSD),
    });
  }
  return totals;
}

// 订阅额度的状态（rate_limit_event 的 rate_limit_info，SDKRateLimitInfo）。只留这几个字段：没有账号的信息。
interface QuotaWindow { status: string; utilization: number | null; resetsAt: number | null; overageStatus: string | null; isUsingOverage: boolean | null; at: number }

const QUOTA_STATUSES: ReadonlySet<string> = new Set(["allowed", "allowed_warning", "rejected"]);

function resetsAtMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 1e12 ? value * 1000 : value;
}

// utilization 的刻度 SDK 的类型没写：0 到 1 时按比例换成百分数，大于 1 时当它已经是百分数。
function utilizationText(value: number | null): string {
  if (value === null) return "";
  const percent = value <= 1 ? value * 100 : value;
  return `，用了约 ${Math.round(percent)}%`;
}

export interface ClaudeCodeEngineOptions {
  cwd: string;
  model: string; // Claude Code 的模型名（不带 claude-code/）
  // 推理强度（不给或者 null：模型自己的缺省）。
  effort?: string | null;
  systemPrompt: () => string;
  // Lead 的只读工具（claude-code-tools.ts）。每起一个 query 建一个新的进程内 MCP 服务器装它们。
  mcpTools: readonly SdkMcpToolDefinition<any>[];
  allowedTools: readonly string[];
  detect: () => Promise<ClaudeCodeAvailability>;
  // 一次运行（prompt 到它答完）彻底结束时（和 pi 的 agent_settled 一样）：清空这一轮的检查状态和证据。
  onRunSettled?: () => void;
  // 一次运行要收尾以前（和 pi 的 agent_before_settle 一样，credibility/extension.ts）：返回一段话时把它送进去，Lead 在同一次运行里
  // 接着答（每次运行最多一次），返回 null 时收尾。texts：这次运行 Lead 的回答；prompts：送进去的消息；toolArgs：工具调用的参数。
  beforeSettle?: (run: { texts: string[]; prompts: string[]; toolArgs: unknown[] }) => Promise<string | null>;
  // 每一轮刷新的那几节系统提示词（pi 的 before_agent_start 改写的身份、外观、代回复风格）：prompt 时调，
  // 有改动时返回要放在这条消息前面的一段，没有时返回 null。
  turnContext?: () => string | null;
  // 处理函数等这次调用的 tool_execution_start 最多多久（ClaudeCodeToolBridge.begin）。缺省 30 秒。
  toolStartWaitMs?: number;
  // 测试注入：假的 SDK query；加载 SDK 的函数。缺省是 SDK 的 query 和 loadClaudeAgentSdk。
  query?: ClaudeAgentSdk["query"];
  loadSdk?: () => Promise<ClaudeAgentSdk>;
  log?: (line: string) => void;
  now?: () => number;
  // 一轮的 result 到了、送进去的消息却还有没被认领的，而 SDK 说没有排着的：等这么久没有新消息就当这次运行结束了。
  idleGraceMs?: number;
}

/**
 * LeadEngine 的 Claude Code 实现。prompt 和 pi 一样：送一条消息，等这一次运行结束（期间插进来的 steer、followUp 都答完）才返回；
 * 模型的失败不抛错，而是发 stopReason 为 error 的 message_end（daemon 据此记健康、换模型）。
 * steer 送成 priority 'next'（这一轮里下一次调模型前送到），followUp 送成 'later'（这一轮答完以后另起一轮）。
 * 空闲时的 steer、followUp 先存着（连同图片），下一次 prompt 时跟着送（pi 也是这样排队），clearQueue 取回的就是这些（只还文字，
 * daemon 按轮次从库里重新取图片）。用户附的图片跟着文字送成图片块（userContent）。
 * abort 用 SDK 的 interrupt。claude 进程退出或者流断了：这一轮按失败收尾，下一次 prompt 重新起一个 query（上下文从头开始）。
 */
export class ClaudeCodeLeadEngine implements LeadEngine {
  private readonly listeners = new Set<Listener>();
  private currentSessionId = randomUUID();
  private live: { q: Query; input: InputQueue } | null = null;
  // 空闲时主动关掉的 query：它的流结束不算这一轮失败（retireIdleSession）。
  private readonly retired = new WeakSet<Query>();
  // 上一次运行结束的时间。还没有结束过时为 null。
  private lastSettledAt: number | null = null;
  private run: Run | null = null;
  private idleInputs: Array<{ text: string; kind: "steer" | "followUp"; images?: ImageContent[] }> = [];
  private model: string;
  private effort: string | null;
  private disposed = false;
  private graceTimer: NodeJS.Timeout | null = null;
  // 一轮里的翻译状态。
  private pending: PendingAssistant | null = null;
  private readonly openTools = new Map<string, string>();
  // 发过 tool_execution_start、还没有被 MCP 处理函数认领的调用（toolBridge.begin 认领），和在等的处理函数。
  private startedTools: Array<{ id: string; name: string }> = [];
  private toolWaiters: Array<{ name: string; toolUseId: string | null; resolve: (id: string | null) => void }> = [];
  // 处理函数已经发过 tool_execution_end 的调用：SDK 流里随后的 tool_result 不再发一遍。
  private readonly endedByHandler = new Set<string>();
  private compacting = false;
  // 这个 query 报过压缩抖动：下一轮开新会话（retireThrashedSession）。
  private thrashed = false;
  private rateLimit: RateLimitInfo | null = null;
  private interruptRequested = false;
  private turnErrorEmitted = false;
  private turnAbortEmitted = false;
  private initLogged = false;
  // Claude Code 报告的认证来源的名字（system:init 的 apiKeySource）。还没起过 query 时为 null。
  private reportedAuthSource: string | null = null;
  // Claude Code 说用户的账号能用的模型（query 的 supportedModels()）。每起一个 query 问一次，之后按 TTL 再问；
  // 没有 query 时用上一次问到的。还没问到过时为 null。
  private sdkModels: { at: number; models: ModelInfo[] } | null = null;
  private sdkModelsAsking: { q: Query; promise: Promise<void> } | null = null;
  // 用量（usageReport、leadContextUsage）。lastUsage：最近一次模型调用的用量（上下文用了多少，和 pi 一样按它算）；
  // contextInfo：Claude Code 说的窗口和自动压缩线（getContextUsage）；resultWindow：result 的 modelUsage 里这个模型的 contextWindow。
  // 换了 query（claude 重启了，上下文从头开始）时清掉。
  private lastUsage: TokenUsage | null = null;
  private lastCallModel: string | null = null;
  private resultWindow: number | null = null;
  private contextInfo: { window: number | null; compactAt: number | null; tokens: number | null } | null = null;
  private contextAsking: Query | null = null;
  // 这个引擎起来以后的累计：之前几个 query 的（earlier），加上现在这个 query 最新的一条 result 带的（current，SDK 说是累计的，不能相加）。
  private earlierTotals = new Map<string, ModelTotals>();
  private currentTotals = new Map<string, ModelTotals>();
  private earlierCostUsd = 0;
  private currentCostUsd = 0;
  private turns = 0;
  private lastTurnUsage: TokenUsage | null = null;
  private readonly quota = new Map<string, QuotaWindow>();
  private readonly startedAt: number;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(private readonly options: ClaudeCodeEngineOptions) {
    this.model = options.model;
    this.effort = options.effort ?? null;
    this.log = options.log ?? ((line) => console.error(line));
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
  }

  /** MCP 处理函数用的（claude-code-tools.ts 的 ClaudeCodeToolBridge）。 */
  readonly toolBridge: ClaudeCodeToolBridge = {
    begin: (toolName, toolUseId, signal) => this.beginTool(toolName, toolUseId, signal),
    end: (toolCallId, result, isError) => this.endTool(toolCallId, result, isError),
  };

  get sessionId(): string {
    return this.currentSessionId;
  }

  get currentModel(): string {
    return this.model;
  }

  /** 正在用的 claude-code/<模型>(<推理强度>)。 */
  get currentSpec(): string {
    return `${CLAUDE_CODE_MODEL_PROVIDER}/${this.model}${this.effort ? `(${this.effort})` : ""}`;
  }

  /** Claude Code 报告的认证来源的名字（不是 key）。 */
  get authSource(): string | null {
    return this.reportedAuthSource;
  }

  /** 这个会话给模型的 Lead 工具（daemon 比较 Lead 的能力有没有变时读它，lead-capabilities.ts）。 */
  getAllTools(): Array<{ name: string }> {
    return this.options.allowedTools.map((name) => ({ name: leadToolName(name) }));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async prompt(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    if (this.disposed) throw new Error("Lead 的会话已经关闭");
    if (this.run) throw new Error("Lead 正在回答：这时用 steer 或 followUp");
    this.retireThrashedSession();
    this.retireIdleSession();
    const run = this.startRun();
    const ready = await this.ensureLive();
    if (this.disposed) {
      this.finishRun(run);
      return;
    }
    if (!ready.ok) {
      // Lead 不可用（没装、没登录、配置写错）：和模型失败一样发一条失败的回答，daemon 记健康并告诉用户原因。
      // 空闲时存着的插话和排队消息留着：daemon 用 clearQueue 取回它们（这一轮失败以后，由它决定怎么再送）。
      this.emitEnd([], "error", { errorMessage: ready.reason });
      this.resetTurn();
      this.finishRun(run);
      return;
    }
    if (run.abortedEarly) {
      this.emitEnd([], "aborted");
      this.resetTurn();
      this.finishRun(run);
      return;
    }
    let context: string | null = null;
    try {
      context = this.options.turnContext?.() ?? null;
    } catch (error) {
      this.log(`[lead] claude-code: turn context skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.send(context ? `${context}\n\n${text}` : text, undefined, options?.images);
    for (const queued of this.idleInputs.splice(0)) this.send(queued.text, queued.kind === "steer" ? "next" : "later", queued.images);
    await run.promise;
  }

  async steer(text: string, images?: ImageContent[]): Promise<QueuedInputDisposition> {
    return this.queueInput(text, "steer", images);
  }

  async followUp(text: string, images?: ImageContent[]): Promise<QueuedInputDisposition> {
    return this.queueInput(text, "followUp", images);
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    const queued = this.idleInputs.splice(0);
    return {
      steering: queued.filter((entry) => entry.kind === "steer").map((entry) => entry.text),
      followUp: queued.filter((entry) => entry.kind === "followUp").map((entry) => entry.text),
    };
  }

  /** 中断正在跑的一轮（SDK 的 interrupt），等这次运行收尾。没有在跑时什么也不做。 */
  async abort(): Promise<void> {
    const run = this.run;
    const live = this.live;
    if (!run) return;
    if (!live) {
      run.abortedEarly = true;
      await run.promise;
      return;
    }
    this.interruptRequested = true;
    try {
      const receipt = await live.q.interrupt();
      const queued = receipt?.still_queued?.length ?? 0;
      if (queued > 0) this.log(`[lead] claude-code interrupted; ${queued} queued message(s) still run after it`);
    } catch (error) {
      this.log(`[lead] claude-code interrupt failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await run.promise;
  }

  /**
   * Claude Code 说用户的账号能用的模型（SDK 的 supportedModels()）。有在跑的 query、而且上一次问到的超过 TTL 时
   * 再问一次，最多等 SUPPORTED_MODELS_TIMEOUT_MS；问不到时用上一次问到的。从来没问到过时为 null（调用方列常用的别名）。
   * 不为了问它起 query：还没回答过时 claude 进程还没起。
   */
  async supportedModels(): Promise<ModelInfo[] | null> {
    const fresh = this.sdkModels && this.now() - this.sdkModels.at < SUPPORTED_MODELS_TTL_MS;
    if (this.live && !fresh) await this.askSupportedModels(this.live.q);
    return this.sdkModels?.models ?? null;
  }

  private askSupportedModels(q: Query): Promise<void> {
    // 同一个 query 正在问：等那一次。换了 query（claude 重启了）：问新的。
    if (this.sdkModelsAsking?.q === q) return this.sdkModelsAsking.promise;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${SUPPORTED_MODELS_TIMEOUT_MS} ms`)), SUPPORTED_MODELS_TIMEOUT_MS);
      timer.unref?.();
    });
    // 下一拍才开始：先记下在问的是哪个 query，收尾时才清得掉。
    const asking = Promise.resolve().then(async () => {
      try {
        if (typeof q.supportedModels !== "function") throw new Error("this SDK has no supportedModels()");
        const models = await Promise.race([q.supportedModels(), timeout]);
        if (Array.isArray(models) && models.length) this.sdkModels = { at: this.now(), models };
      } catch (error) {
        this.log(`[lead] claude-code: supported models unavailable: ${clip(error instanceof Error ? error.message : String(error))}`);
      } finally {
        clearTimeout(timer);
        if (this.sdkModelsAsking?.q === q) this.sdkModelsAsking = null;
      }
    });
    this.sdkModelsAsking = { q, promise: asking };
    return asking;
  }

  /**
   * Lead 的上下文现在用了多少（daemon 的当前局面、代价信号的尾注、整理笔记的水位读它，cost-signals.ts 的 leadContextUsage）。
   * tokens 和 pi 一样按最近一次模型调用的用量算（input、output、cacheRead、cacheWrite 加起来）；窗口和自动压缩线是 Claude Code 说的
   * （getContextUsage 的 maxTokens、autoCompactThreshold），还没问到时窗口用 result 的 modelUsage 的 contextWindow。同步、不问 SDK：
   * 用的是缓存着的数。不知道时为 null。
   */
  leadContextUsage(): { tokens: number; window: number; compactAt: number | null } | null {
    const window = this.contextInfo?.window ?? this.resultWindow;
    const tokens = this.lastUsage ? usageTotal(this.lastUsage) : this.contextInfo?.tokens ?? null;
    if (!window || tokens === null) return null;
    return { tokens, window, compactAt: this.contextInfo?.compactAt ?? null };
  }

  /**
   * 这个引擎起来以后 Lead 的用量（get_system_usage 的 lead_model、get_environment），数字都是 SDK 给的：
   * result 的 modelUsage（按模型累计的 token 和估算的成本）、usage（这一轮主循环的）、total_cost_usd，rate_limit_event 的额度状态。
   * 成本是 Claude Code 按 API 价格估的（SDK：「An estimate, not a billing statement」），用订阅登录时不是实际花的钱。
   */
  usageReport(): Record<string, unknown> {
    const byModel = new Map<string, ModelTotals>();
    for (const source of [this.earlierTotals, this.currentTotals]) {
      for (const [model, entry] of source) {
        const sum = byModel.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
        byModel.set(model, {
          input: sum.input + entry.input, output: sum.output + entry.output, cacheRead: sum.cacheRead + entry.cacheRead,
          cacheWrite: sum.cacheWrite + entry.cacheWrite, costUsd: sum.costUsd + entry.costUsd,
        });
      }
    }
    const all = [...byModel.values()];
    const add = (key: keyof ModelTotals) => all.reduce((total, entry) => total + entry[key], 0);
    const tokens = { input: add("input"), output: add("output"), cache_read: add("cacheRead"), cache_write: add("cacheWrite") };
    const round = (value: number) => Math.round(value * 10_000) / 10_000;
    const context = this.leadContextUsage();
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    return {
      backend: "claude-code",
      source: "Claude Agent SDK：每一轮 result 的 modelUsage、usage、total_cost_usd，rate_limit_event",
      since: iso(this.startedAt),
      turns: this.turns,
      tokens: { ...tokens, total: tokens.input + tokens.output + tokens.cache_read + tokens.cache_write },
      by_model: [...byModel].map(([model, entry]) => ({
        model, input: entry.input, output: entry.output, cache_read: entry.cacheRead, cache_write: entry.cacheWrite, cost_usd_estimate: round(entry.costUsd),
      })),
      cost_usd_estimate: round(this.earlierCostUsd + this.currentCostUsd),
      cost_note: "成本是 Claude Code 按 API 价格估的等价成本，不是实际花的钱：用 Claude 订阅登录时用的是订阅额度（认证来源见 get_environment）。",
      last_turn: this.lastTurnUsage
        ? { input: this.lastTurnUsage.input, output: this.lastTurnUsage.output, cache_read: this.lastTurnUsage.cacheRead, cache_write: this.lastTurnUsage.cacheWrite }
        : null,
      context: context ? { tokens: context.tokens, window: context.window, compact_at: context.compactAt } : null,
      quota: [...this.quota].map(([window, entry]) => ({
        window, status: entry.status, utilization: entry.utilization, resets_at: iso(entry.resetsAt),
        ...(entry.overageStatus ? { overage_status: entry.overageStatus } : {}),
        ...(entry.isUsingOverage !== null ? { using_overage: entry.isUsingOverage } : {}),
        seen_at: iso(entry.at),
      })),
      quota_note: this.quota.size
        ? "订阅额度的状态是 Claude Code 最近报告的（rate_limit_event，额度变化时才报），和用户自己用 Claude Code 共用一份额度。utilization 是 SDK 给的原数。"
        : "Claude Code 这次还没有报告订阅额度的状态（它只在额度变化时报；用 API key 时没有）。",
      not_counted: "不含 daemon 起来以前的用量；since 和 until 不筛这一节。",
    };
  }

  /** get_environment 的一段：用量和订阅额度，给人看的几行。 */
  usageSummary(): string {
    const report = this.usageReport() as {
      turns: number; tokens: { total: number; input: number; output: number; cache_read: number; cache_write: number }; cost_usd_estimate: number;
    };
    const lines = [
      `- Lead 的用量（claude-code，daemon 这次起来以后，SDK 给的数）：${report.turns} 轮，`
        + `token 共 ${formatTokenCount(report.tokens.total)}（输入 ${formatTokenCount(report.tokens.input)}、输出 ${formatTokenCount(report.tokens.output)}、`
        + `缓存读 ${formatTokenCount(report.tokens.cache_read)}、缓存写 ${formatTokenCount(report.tokens.cache_write)}）；`
        + `按 API 价格估算约 $${report.cost_usd_estimate.toFixed(2)}（估算，不是实际花的钱）。`,
    ];
    if (!this.quota.size) {
      lines.push("- 订阅额度：Claude Code 这次还没有报告（它只在额度变化时报；用 API key 时没有）。");
    } else {
      const windows = [...this.quota].map(([window, entry]) => {
        const reset = entry.resetsAt === null ? "" : `，${new Date(entry.resetsAt).toISOString()} 恢复`;
        return `${window} ${entry.status}${utilizationText(entry.utilization)}${reset}`;
      });
      lines.push(`- 订阅额度（Claude Code 最近报告的，和用户自己用 Claude Code 共用）：${windows.join("；")}。`);
    }
    return lines.join("\n");
  }

  /**
   * 换模型和推理强度，不改 config.json。只认 claude-code/<模型>，可以带强度（claude-code/opus(high)）。daemon 只在两轮之间调
   * （Lead 正在回答时等这一轮结束，和换模型一样）。还没起 query 时记下，下一个 query 起的时候用（Options.model、Options.effort）。
   * 有 query 时：模型变了用 SDK 的 setModel；强度变了（或者换了模型又带着强度）用 applyFlagSettings 的 effortLevel
   * （sdk.d.ts 的 Query.applyFlagSettings：流式输入模式里在会话中改设置，effortLevel 为 null 时回到模型的缺省）。
   */
  async switchModel(spec: string): Promise<void> {
    const choice = claudeCodeModelChoice(spec);
    if (!choice) throw new Error(`claude-code 后端只能换到 claude-code/<模型>，收到 ${spec}`);
    const live = this.live;
    if (live) {
      const modelChanged = choice.name !== this.model;
      if (modelChanged) {
        await live.q.setModel(choice.name);
        this.model = choice.name;
      }
      if (choice.effort !== this.effort || (modelChanged && choice.effort)) {
        if (typeof live.q.applyFlagSettings !== "function") throw new Error("这个版本的 Claude Agent SDK 不能在会话里换推理强度");
        await live.q.applyFlagSettings({ effortLevel: (choice.effort as EffortLevel | null) ?? null });
      }
    }
    this.model = choice.name;
    this.effort = choice.effort;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearGrace();
    this.idleInputs = [];
    const live = this.live;
    this.live = null;
    live?.input.close();
    try {
      live?.q.close();
    } catch (error) {
      this.log(`[lead] claude-code close failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const waiter of [...this.toolWaiters]) waiter.resolve(null);
    if (this.run) this.finishRun(this.run);
    this.listeners.clear();
  }

  // ——— 工具调用：处理函数先等 tool_execution_start（daemon 在那里记外部内容、落成系统回合），和 pi 一样先发它再执行 ———

  // 按模型的 tool_use id 对（Claude Code 在 MCP 请求的 _meta 里带着它），只认同一个 id：按名字对的话，一个没经过处理函数的
  // 同名调用（Claude Code 自己拒绝了、参数没通过校验）还没收尾时，会被拿来当成这次的，工具就在自己的 start 以前跑了。
  // 请求里没有 id 时（老版本的 Claude Code）才按工具名取最早的一个。
  private claimStarted(toolName: string, toolUseId: string | null): string | null {
    const index = this.startedTools.findIndex((entry) => entry.name === toolName && (toolUseId === null || entry.id === toolUseId));
    if (index < 0) return null;
    const [entry] = this.startedTools.splice(index, 1);
    return entry!.id;
  }

  private beginTool(
    toolName: string, toolUseId: string | null, signal?: AbortSignal,
  ): Promise<{ ok: true; toolCallId: string } | { ok: false; reason: string }> {
    const refused = (why: string) => ({
      ok: false as const,
      reason: `${toolName} 没有执行：${why}。这次调用没有做任何事；需要的话再调一次。`,
    });
    if (this.disposed) return Promise.resolve(refused("Lead 的会话已经关闭"));
    // 已经中断的调用不执行（pi 的 prepareToolCall 也先看 signal.aborted）：abort 事件不会再发，等也等不到。
    if (signal?.aborted) return Promise.resolve(refused("这次调用已经中断"));
    const claimed = this.claimStarted(toolName, toolUseId);
    if (claimed) return Promise.resolve({ ok: true, toolCallId: claimed });
    return new Promise((resolve) => {
      let settled = false;
      const waiter = {
        name: toolName,
        toolUseId,
        resolve: (id: string | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          this.toolWaiters = this.toolWaiters.filter((entry) => entry !== waiter);
          resolve(id ? { ok: true, toolCallId: id } : refused("系统没有对上这次工具调用"));
        },
      };
      const onAbort = () => waiter.resolve(null);
      const timer = setTimeout(() => {
        this.log(`[lead] claude-code: ${toolName} was called but its tool_use never showed up in the stream; not run`);
        waiter.resolve(null);
      }, this.options.toolStartWaitMs ?? 30_000);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.toolWaiters.push(waiter);
    });
  }

  private wakeToolWaiters(): void {
    for (const waiter of [...this.toolWaiters]) {
      const id = this.claimStarted(waiter.name, waiter.toolUseId);
      if (id) waiter.resolve(id);
    }
  }

  private endTool(toolCallId: string, result: LeadToolResult, isError: boolean): void {
    const toolName = this.openTools.get(toolCallId);
    // 这次调用已经收尾了（例如被中断，SDK 流里先来了出错的 tool_result）：不再发一遍。
    if (toolName === undefined) return;
    this.openTools.delete(toolCallId);
    this.endedByHandler.add(toolCallId);
    this.emit({ type: "tool_execution_end", toolCallId, toolName, result: { content: result.content, details: result.details }, isError });
  }

  // ——— 内部 ———

  private emit(event: Record<string, unknown>): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event as unknown as AgentSessionEvent);
      } catch (error) {
        this.log(`[lead] claude-code listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private startRun(): Run {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    const run: Run = { awaiting: new Set(), texts: [], prompts: [], toolArgs: [], settleChecked: false, resolve, promise };
    this.run = run;
    return run;
  }

  private finishRun(run: Run): void {
    this.clearGrace();
    if (this.run === run) this.run = null;
    this.lastSettledAt = this.now();
    try {
      this.options.onRunSettled?.();
    } catch (error) {
      this.log(`[lead] claude-code: run settle hook failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    run.resolve();
  }

  private clearGrace(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  private async queueInput(text: string, kind: "steer" | "followUp", images?: ImageContent[]): Promise<QueuedInputDisposition> {
    if (this.disposed) throw new Error("Lead 的会话已经关闭");
    if (this.run && this.live) this.send(text, kind === "steer" ? "next" : "later", images);
    else this.idleInputs.push({ text, kind, ...(images?.length ? { images } : {}) });
    return "queued";
  }

  private send(text: string, priority?: "next" | "later", images?: ImageContent[]): void {
    const live = this.live;
    const run = this.run;
    if (!live || !run) return;
    const uuid = randomUUID();
    run.awaiting.add(uuid);
    run.prompts.push(text);
    live.input.push({
      type: "user",
      message: { role: "user", content: userContent(text, images) },
      parent_tool_use_id: null,
      uuid,
      ...(priority ? { priority } : {}),
    } as SDKUserMessage);
  }

  /**
   * 空闲够久、上下文又大时关掉当前的 query，下一轮从头开始（Lead 从账本重建，和 daemon 重启一样）。
   * 缓存一小时就过期（订阅下主会话的 TTL，https://code.claude.com/docs/en/agent-sdk/cost-tracking），过期以后接着用旧上下文要把它整段
   * 重新写进缓存：2026-11-06 一个 opus 会话两次在 705k、800k 上整段重写。小的上下文留着，重建它省不了多少。
   */
  private retireIdleSession(): void {
    const live = this.live;
    if (!live || this.lastSettledAt === null) return;
    const idleMs = this.now() - this.lastSettledAt;
    const tokens = this.leadContextUsage()?.tokens ?? (this.lastUsage ? usageTotal(this.lastUsage) : null);
    if (idleMs < LEAD_IDLE_RESET_MS || tokens === null || tokens < LEAD_IDLE_RESET_MIN_TOKENS) return;
    this.retireLive(`idle ${Math.round(idleMs / 60_000)} min with ${tokens} context tokens`);
  }

  /** 上一轮 Claude Code 报了压缩抖动（AUTOCOMPACT_THRASHING）：关掉这个 query，下一轮从头开始。Claude Code 不会自己清，接着用每轮都再抖一次。 */
  private retireThrashedSession(): void {
    if (!this.thrashed) return;
    this.thrashed = false;
    this.retireLive("autocompact thrashed last turn");
  }

  private retireLive(reason: string): void {
    const live = this.live;
    if (!live) return;
    this.log(`[lead] claude-code: ${reason}; starting a new session`);
    this.retired.add(live.q);
    this.live = null;
    live.input.close();
    try {
      live.q.close();
    } catch (error) {
      this.log(`[lead] claude-code close failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async ensureLive(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.live) return { ok: true };
    let availability: ClaudeCodeAvailability;
    try {
      availability = await this.options.detect();
    } catch (error) {
      availability = { ok: false, reason: `Lead 用不了 Claude Code：检查安装和登录时出错（${error instanceof Error ? error.message : String(error)}）。` };
    }
    if (!availability.ok) return availability;
    if (this.disposed) return { ok: false, reason: "Lead 的会话已经关闭" };
    if (this.live) return { ok: true };
    const input = new InputQueue();
    this.currentSessionId = randomUUID();
    this.initLogged = false;
    let systemPrompt: string;
    try {
      systemPrompt = this.options.systemPrompt();
    } catch (error) {
      return { ok: false, reason: `Lead 的系统提示词生成失败：${error instanceof Error ? error.message : String(error)}` };
    }
    let sdk: ClaudeAgentSdk;
    try {
      sdk = await (this.options.loadSdk ?? loadClaudeAgentSdk)();
    } catch (error) {
      return {
        ok: false,
        reason: `Lead 用不了 Claude Code：加载 Claude Agent SDK 失败（${clip(error instanceof Error ? error.message : String(error))}）。`
          + "在 pi-lead-child 的目录里运行 npm install，或者把 lead.backend 改回 pi，然后重启 daemon。",
      };
    }
    if (this.disposed) return { ok: false, reason: "Lead 的会话已经关闭" };
    if (this.live) return { ok: true };
    let q: Query;
    try {
      // MCP 服务器每个 query 一个：一个 McpServer 只能接一个连接，claude 进程重启以后不复用上一个的。
      const mcpServer: McpSdkServerConfigWithInstance = sdk.createSdkMcpServer({
        name: CLAUDE_CODE_TOOL_SERVER, version: "0.1.0", tools: [...this.options.mcpTools], alwaysLoad: true,
      });
      q = (this.options.query ?? sdk.query)({
        prompt: input,
        options: claudeCodeQueryOptions({
          executable: availability.executable,
          cwd: this.options.cwd,
          sessionId: this.currentSessionId,
          model: this.model,
          effort: this.effort,
          systemPrompt,
          mcpServer,
          allowedTools: this.options.allowedTools,
          log: this.log,
        }),
      });
    } catch (error) {
      input.close();
      return { ok: false, reason: `Lead 用不了 Claude Code：启动失败（${clip(error instanceof Error ? error.message : String(error))}）。` };
    }
    this.live = { q, input };
    // 新的 query 的上下文从头开始，modelUsage、total_cost_usd 的累计也从 0 开始：之前那个 query 的累计留着。
    for (const [model, entry] of this.currentTotals) {
      const sum = this.earlierTotals.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
      this.earlierTotals.set(model, {
        input: sum.input + entry.input, output: sum.output + entry.output, cacheRead: sum.cacheRead + entry.cacheRead,
        cacheWrite: sum.cacheWrite + entry.cacheWrite, costUsd: sum.costUsd + entry.costUsd,
      });
    }
    this.currentTotals = new Map();
    this.earlierCostUsd += this.currentCostUsd;
    this.currentCostUsd = 0;
    this.lastUsage = null;
    this.resultWindow = null;
    this.contextInfo = null;
    void this.consume(q, input);
    // 新的 query（可能换了账号、换了登录）：问一次它能用的模型，输入框和设置页的模型列表用它。
    void this.askSupportedModels(q);
    return { ok: true };
  }

  private async consume(q: Query, input: InputQueue): Promise<void> {
    let failure: unknown = null;
    try {
      for await (const message of q) {
        if (this.disposed || this.live?.q !== q) break;
        this.onMessage(message);
      }
    } catch (error) {
      failure = error;
    }
    if (this.live?.q === q) this.live = null;
    input.close();
    if (this.disposed || this.retired.has(q)) return;
    this.onStreamEnd(failure);
  }

  // claude 进程退出或者流断了。正在跑的一轮按失败收尾；下一次 prompt 重新起 query。
  private onStreamEnd(failure: unknown): void {
    const detail = failure ? clip(failure instanceof Error ? failure.message : String(failure)) : "流结束了";
    this.log(`[lead] claude-code session ended: ${detail}`);
    this.flushPending();
    this.closeOpenTools("Claude Code 的进程结束了，工具调用没有完成。");
    const run = this.run;
    if (!run) return;
    if (this.interruptRequested) {
      if (!this.turnAbortEmitted) this.emitEnd([], "aborted");
    } else if (!this.turnErrorEmitted) {
      this.emitEnd([], "error", { errorMessage: `Claude Code 的进程意外结束了（${detail}）。下一轮会重新启动它，之前的上下文没有保留。` });
    }
    this.resetTurn();
    this.finishRun(run);
  }

  private onMessage(message: SDKMessage): void {
    if (this.graceTimer) this.armGrace();
    const m = message as SDKMessage & Record<string, any>;
    switch (m.type) {
      case "system":
        this.onSystem(m);
        return;
      case "stream_event":
        if (m.parent_tool_use_id) return;
        this.onStreamEvent(m.event ?? {});
        return;
      case "assistant":
        if (m.parent_tool_use_id) return;
        this.onAssistant(m);
        return;
      case "user":
        if (m.parent_tool_use_id) return;
        this.onUser(m);
        return;
      case "rate_limit_event": {
        const info = m.rate_limit_info as (RateLimitInfo & { utilization?: unknown; isUsingOverage?: unknown }) | undefined;
        const used = this.recordQuota(info);
        // 订阅的额度用完了、还能走额外用量（overage）时请求照常过：那不是这一轮失败的原因，不记下。
        const overage = info?.overageStatus === "allowed" || info?.overageStatus === "allowed_warning";
        if (info?.status === "rejected" && !overage) {
          this.rateLimit = info;
          this.log(`[lead] claude-code rate limit rejected (${info.rateLimitType ?? "unknown"})${used}`);
        } else if (info?.status === "rejected" || info?.status === "allowed_warning") {
          this.log(`[lead] claude-code rate limit ${info.status === "rejected" ? "reached, using overage" : "warning"} (${info.rateLimitType ?? "unknown"})${used}`);
        } else if (info?.status === "allowed" && used) {
          this.log(`[lead] claude-code quota (${info.rateLimitType ?? "unknown"}) allowed${used}`);
        }
        return;
      }
      case "result":
        this.onResult(m);
        return;
      default:
        // command_lifecycle、system:post_turn_summary、auth_status 一类的消息 daemon 不用；新版本加的类型也在这里忽略。
        return;
    }
  }

  private onSystem(m: Record<string, any>): void {
    switch (m.subtype) {
      case "init": {
        if (this.initLogged) return;
        this.initLogged = true;
        const tools: string[] = Array.isArray(m.tools) ? m.tools.map(String) : [];
        const foreign = tools.filter((name) => name !== CLAUDE_CODE_TOOL_SEARCH && !this.options.allowedTools.includes(name));
        // apiKeySource 是来源的名字（none 表示没有用 API key），不是 key。只记名字。
        const source = typeof m.apiKeySource === "string" ? m.apiKeySource.slice(0, 40) : null;
        const changed = source !== this.reportedAuthSource;
        this.reportedAuthSource = source;
        this.log(`[lead] claude-code ready (model=${String(m.model ?? "?")}, claude=${String(m.claude_code_version ?? "?")}, `
          + `auth source=${source ?? "?"}, tools=${tools.length})`);
        if (changed) this.log(`[lead] claude-code auth: ${claudeCodeAuthSourceText(source)}`);
        if (foreign.length) this.log(`[lead] claude-code: unexpected tools in the session (denied: not in allowedTools, permission mode dontAsk): ${foreign.join(", ")}`);
        return;
      }
      case "status":
        if (m.status === "compacting" && !this.compacting) {
          this.compacting = true;
          this.emit({ type: "compaction_start", reason: "threshold" });
        }
        if (m.compact_result === "failed") {
          if (!this.compacting) this.emit({ type: "compaction_start", reason: "threshold" });
          this.compacting = false;
          this.emit({
            type: "compaction_end", reason: "threshold", aborted: false, willRetry: false,
            errorMessage: clip(String(m.compact_error ?? "Claude Code 的上下文压缩失败了")),
          });
        } else if (m.compact_result === "success" && this.compacting) {
          this.compacting = false;
          this.emit({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false, result: { summary: "" } });
        }
        return;
      case "compact_boundary": {
        // 压缩以后上下文变小了：最近一次调用的用量不再是现在的数。压缩以后的数（post_tokens）有时给，没给时等下一次调用。
        this.lastUsage = null;
        const post = m.compact_metadata?.post_tokens;
        if (this.contextInfo) this.contextInfo.tokens = typeof post === "number" && post >= 0 ? post : null;
        const reason = m.compact_metadata?.trigger === "manual" ? "manual" : "threshold";
        if (!this.compacting) this.emit({ type: "compaction_start", reason });
        this.compacting = false;
        this.emit({
          type: "compaction_end", reason, aborted: false, willRetry: false,
          result: { summary: "", tokensBefore: Number(m.compact_metadata?.pre_tokens ?? 0) },
        });
        return;
      }
      case "api_retry": {
        const status = typeof m.error_status === "number" ? ` (HTTP ${m.error_status})` : "";
        this.emit({
          type: "auto_retry_start",
          attempt: Number(m.attempt ?? 0),
          maxAttempts: Number(m.max_retries ?? 0),
          delayMs: Number(m.retry_delay_ms ?? 0),
          errorMessage: `Claude Code API retry: ${String(m.error ?? "unknown")}${status}`,
        });
        return;
      }
      default:
        return;
    }
  }

  private ensurePending(id: string | null): PendingAssistant {
    if (this.pending && (id === null || this.pending.id === null || this.pending.id === id)) {
      if (id !== null) this.pending.id = id;
      return this.pending;
    }
    if (this.pending) this.flushPending();
    this.pending = { id, blocks: [], streamed: "", stopReason: null, error: null, model: null, usage: null };
    this.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    return this.pending;
  }

  private onStreamEvent(event: Record<string, any>): void {
    switch (event.type) {
      case "message_start": {
        const pending = this.ensurePending(typeof event.message?.id === "string" ? event.message.id : null);
        pending.usage = mergeUsage(pending.usage, event.message?.usage);
        return;
      }
      case "content_block_delta":
        if (event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
          this.ensurePending(null).streamed += event.delta.text;
          this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: event.delta.text } });
        }
        return;
      case "message_delta":
        if (this.pending && typeof event.delta?.stop_reason === "string") this.pending.stopReason = event.delta.stop_reason;
        if (this.pending) this.pending.usage = mergeUsage(this.pending.usage, event.usage);
        return;
      case "message_stop":
        this.flushPending();
        return;
      default:
        return;
    }
  }

  // Claude Code 每个内容块发一条 assistant 消息（同一个 message.id）：按 id 攒起来，到 message_stop 时发一条 message_end。
  private onAssistant(m: Record<string, any>): void {
    const id = typeof m.message?.id === "string" ? m.message.id : null;
    const pending = this.ensurePending(id);
    const blocks = Array.isArray(m.message?.content) ? m.message.content as Array<Record<string, unknown>> : [];
    pending.blocks.push(...blocks);
    if (typeof m.message?.model === "string") pending.model = m.message.model;
    if (typeof m.message?.stop_reason === "string") pending.stopReason = m.message.stop_reason;
    if (typeof m.error === "string") pending.error = m.error;
    pending.usage = mergeUsage(pending.usage, m.message?.usage);
  }

  private flushPending(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    const content: Array<Record<string, unknown>> = [];
    const calls: Array<{ id: string; name: string; args: unknown }> = [];
    for (const block of pending.blocks) {
      if (block.type === "text" && typeof block.text === "string") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use" && typeof block.id === "string") {
        const name = leadToolName(String(block.name ?? ""));
        content.push({ type: "toolCall", id: block.id, name, arguments: block.input ?? {} });
        calls.push({ id: block.id, name, args: block.input ?? {} });
      }
    }
    if (pending.streamed && !content.some((part) => part.type === "text")) content.unshift({ type: "text", text: pending.streamed });
    const text = content.filter((part) => part.type === "text").map((part) => String(part.text)).join("");
    // 什么也没有的一条（例如重试以前开了头的那一次请求）：不发 message_end，不算一次成功的模型调用。
    if (content.length === 0 && !pending.error && !this.interruptRequested) return;
    // 先记下用量，再发 message_end 和 tool_execution_start：工具的处理函数加尾注时读得到这次调用以后的上下文。
    if (pending.usage) {
      this.lastUsage = { ...pending.usage };
      if (pending.model) this.lastCallModel = pending.model;
    }
    const usage = pending.usage;
    if (pending.error) {
      const errorMessage = claudeCodeAssistantErrorText(pending.error, text, this.rateLimit, this.now());
      this.emitEnd(content, "error", { errorMessage, model: pending.model, started: true, usage });
    } else if (this.interruptRequested && pending.stopReason === null) {
      this.emitEnd(content, "aborted", { model: pending.model, started: true, usage });
    } else {
      const stopReason = pending.stopReason === "max_tokens" ? "length" : calls.length ? "toolUse" : "stop";
      this.emitEnd(content, stopReason, { model: pending.model, started: true, usage });
    }
    for (const call of calls) {
      this.openTools.set(call.id, call.name);
      this.run?.toolArgs.push(call.args);
      this.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.args });
      this.startedTools.push({ id: call.id, name: call.name });
    }
    if (calls.length) this.wakeToolWaiters();
  }

  // started：前面已经发过这条消息的 message_start（flushPending 发的那些）。收尾时补发的失败、中断没有。
  private emitEnd(
    content: Array<Record<string, unknown>>, stopReason: string,
    extra: { errorMessage?: string; model?: string | null; started?: boolean; usage?: TokenUsage | null } = {},
  ): void {
    if (stopReason === "error") this.turnErrorEmitted = true;
    if (stopReason === "error" && extra.errorMessage?.includes(AUTOCOMPACT_THRASHING)) this.thrashed = true;
    if (stopReason === "aborted") this.turnAbortEmitted = true;
    const said = content.filter((part) => part.type === "text").map((part) => String(part.text)).join("");
    if (said) this.run?.texts.push(said);
    if (!extra.started) this.emit({ type: "message_start", message: { role: "assistant", content: [] } });
    this.emit({
      type: "message_end",
      message: {
        role: "assistant", content, stopReason,
        ...(extra.errorMessage ? { errorMessage: extra.errorMessage } : {}),
        ...(extra.model ? { model: extra.model } : {}),
        // 和 pi 的 message.usage 同样的字段（不带 cost：SDK 不给一次调用的成本，只给整个 query 估算的累计）。
        ...(extra.usage ? { usage: { ...extra.usage, totalTokens: usageTotal(extra.usage) } } : {}),
        timestamp: this.now(),
      },
    });
  }

  private onUser(m: Record<string, any>): void {
    this.flushPending();
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Array<Record<string, any>>) {
      if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      // 没有经过处理函数的调用（Claude Code 自己拒绝了、参数没通过校验）：不会再有处理函数来认领它。
      this.startedTools = this.startedTools.filter((entry) => entry.id !== block.tool_use_id);
      if (this.endedByHandler.delete(block.tool_use_id)) continue;
      const toolName = this.openTools.get(block.tool_use_id) ?? "unknown";
      this.openTools.delete(block.tool_use_id);
      this.emit({
        type: "tool_execution_end",
        toolCallId: block.tool_use_id,
        toolName,
        result: { content: toolResultParts(block.content), details: undefined },
        isError: block.is_error === true,
      });
    }
  }

  private closeOpenTools(text: string): void {
    for (const [toolCallId, toolName] of this.openTools) {
      this.emit({ type: "tool_execution_end", toolCallId, toolName, result: { content: [{ type: "text", text }], details: undefined }, isError: true });
    }
    this.openTools.clear();
    this.startedTools = [];
    this.endedByHandler.clear();
  }

  private onResult(m: Record<string, any>): void {
    this.flushPending();
    this.closeOpenTools("这一轮结束了，工具调用没有完成。");
    this.recordResultUsage(m);
    const failed = m.subtype !== "success" || m.is_error === true;
    const interrupted = this.interruptRequested;
    if (failed) {
      if (this.interruptRequested) {
        if (!this.turnAbortEmitted) this.emitEnd([], "aborted");
      } else if (!this.turnErrorEmitted) {
        this.emitEnd([], "error", { errorMessage: this.resultErrorText(m) });
      }
    }
    this.resetTurn();
    const run = this.run;
    if (!run) return;
    const uuids: string[] = Array.isArray(m.user_message_uuids)
      ? m.user_message_uuids.map(String)
      : typeof m.user_message_uuid === "string" ? [m.user_message_uuid] : [];
    const queued = typeof m.queued_turn_count === "number" ? m.queued_turn_count : 0;
    for (const uuid of uuids) run.awaiting.delete(uuid);
    // 老版本不回传 uuid：只能看 SDK 说的还有没有排着的。
    if (uuids.length === 0 && queued === 0) run.awaiting.clear();
    if (run.awaiting.size === 0 && queued === 0) {
      if (failed || interrupted || run.settleChecked || !this.options.beforeSettle || !this.live) {
        this.finishRun(run);
        return;
      }
      // 核对是异步的（读文件、git）：核对期间又送进了消息，就由那条消息的结果收尾。
      void this.settleCorrection(run).then((sent) => {
        if (!sent && this.run === run && run.awaiting.size === 0) this.finishRun(run);
      });
    } else if (queued === 0) {
      // 送进去的消息还没有被哪一轮认领，SDK 又说没有排着的：多半还在路上。等一会儿；一直没有新消息就收尾，不让 daemon 一直等着。
      this.armGrace();
    }
  }

  // 收尾以前的检查（beforeSettle，和 pi 的 agent_before_settle 一样每次运行最多一次）：要更正时送一条说明，这次运行接着答。
  private async settleCorrection(run: Run): Promise<boolean> {
    if (run.settleChecked || !this.options.beforeSettle || !this.live) return false;
    run.settleChecked = true;
    let correction: string | null = null;
    try {
      correction = await this.options.beforeSettle({ texts: [...run.texts], prompts: [...run.prompts], toolArgs: [...run.toolArgs] });
    } catch (error) {
      this.log(`[lead] claude-code: settle check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!correction || this.run !== run || !this.live) return false;
    this.send(correction);
    return true;
  }

  // 一轮的 result 带的用量（SDKResultSuccess / SDKResultError）：modelUsage 和 total_cost_usd 是这个 query 到现在的累计
  // （SDK：「read the latest result rather than summing across results」），usage 是这一轮主循环的。记一行日志，再问一次上下文。
  private recordResultUsage(m: Record<string, any>): void {
    this.turns += 1;
    const totals = modelTotals(m.modelUsage);
    if (totals.size) this.currentTotals = totals;
    if (typeof m.total_cost_usd === "number" && Number.isFinite(m.total_cost_usd) && m.total_cost_usd >= 0) this.currentCostUsd = m.total_cost_usd;
    const turn = mergeUsage(null, m.usage);
    if (turn) this.lastTurnUsage = turn;
    // 窗口：这一轮最后一次调用的模型在 modelUsage 里的 contextWindow（模型名和 modelUsage 的键对得上时）。
    const entry = this.lastCallModel && m.modelUsage && typeof m.modelUsage === "object" ? m.modelUsage[this.lastCallModel] : undefined;
    if (typeof entry?.contextWindow === "number" && entry.contextWindow > 0) this.resultWindow = entry.contextWindow;
    const context = this.leadContextUsage();
    const parts = [
      turn ? `turn in=${turn.input} out=${turn.output} cacheRead=${turn.cacheRead} cacheWrite=${turn.cacheWrite}` : "turn usage not reported",
      context ? `context≈${context.tokens}/${context.window}` : null,
      `session≈$${(this.earlierCostUsd + this.currentCostUsd).toFixed(4)} (API-equivalent estimate)`,
    ].filter(Boolean);
    this.log(`[lead] claude-code usage: ${parts.join(", ")}`);
    if (this.live) void this.askContextUsage(this.live.q);
  }

  // Claude Code 说的上下文窗口和自动压缩线（Query.getContextUsage，detail 'summary'：按最近一次回答的 usage 和本地估计，
  // 不调 token 计数接口）。一轮结束以后问，不等它；同一个 query 正在问时不再问；最多等 CONTEXT_USAGE_TIMEOUT_MS，问不到时用上一次的。
  private askContextUsage(q: Query): Promise<void> {
    if (this.contextAsking === q || typeof (q as { getContextUsage?: unknown }).getContextUsage !== "function") return Promise.resolve();
    this.contextAsking = q;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${CONTEXT_USAGE_TIMEOUT_MS} ms`)), CONTEXT_USAGE_TIMEOUT_MS);
      timer.unref?.();
    });
    return (async () => {
      try {
        const answer = await Promise.race([q.getContextUsage({ detail: "summary" }), timeout]) as Partial<Record<string, unknown>>;
        if (this.live?.q !== q) return;
        const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);
        const window = count(answer.maxTokens);
        // 自动压缩线：一个 token 数（不大于窗口时才认）；关了自动压缩时没有。
        const threshold = count(answer.autoCompactThreshold);
        const compactAt = answer.isAutoCompactEnabled === false || threshold === null
          ? null
          : threshold <= 1 && window ? Math.round(threshold * window) : window && threshold > window ? null : threshold;
        this.contextInfo = { window, compactAt, tokens: count(answer.totalTokens) };
      } catch (error) {
        this.log(`[lead] claude-code: context usage unavailable: ${clip(error instanceof Error ? error.message : String(error))}`);
      } finally {
        clearTimeout(timer);
        if (this.contextAsking === q) this.contextAsking = null;
      }
    })();
  }

  // rate_limit_event 的额度状态，按窗口（rateLimitType）留最新的一条。返回给日志的一段（用了多少），没有时为空。
  private recordQuota(info: (RateLimitInfo & { utilization?: unknown; isUsingOverage?: unknown }) | undefined): string {
    if (!info || typeof info.status !== "string" || !QUOTA_STATUSES.has(info.status)) return "";
    const utilization = typeof info.utilization === "number" && Number.isFinite(info.utilization) && info.utilization >= 0 ? info.utilization : null;
    const window = typeof info.rateLimitType === "string" && /^[a-z0-9_]{1,40}$/.test(info.rateLimitType) ? info.rateLimitType : "unknown";
    this.quota.set(window, {
      status: info.status,
      utilization,
      resetsAt: resetsAtMs(info.resetsAt),
      overageStatus: typeof info.overageStatus === "string" && QUOTA_STATUSES.has(info.overageStatus) ? info.overageStatus : null,
      isUsingOverage: typeof info.isUsingOverage === "boolean" ? info.isUsingOverage : null,
      at: this.now(),
    });
    return utilization === null ? "" : `, utilization ${utilization}`;
  }

  private resultErrorText(m: Record<string, any>): string {
    if (this.rateLimit) return claudeCodeRateLimitText(this.rateLimit, this.now());
    const errors = Array.isArray(m.errors) ? m.errors.map(String).filter(Boolean) : [];
    const detail = errors.length ? errors.join("; ") : typeof m.result === "string" ? m.result : "";
    return `Claude Code 这一轮失败了（${String(m.subtype ?? "error")}）${detail ? `：${clip(detail)}` : ""}`;
  }

  private resetTurn(): void {
    this.turnErrorEmitted = false;
    this.turnAbortEmitted = false;
    this.interruptRequested = false;
    this.rateLimit = null;
  }

  private armGrace(): void {
    this.clearGrace();
    const run = this.run;
    if (!run) return;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (this.run !== run) return;
      this.log(`[lead] claude-code: ${run.awaiting.size} message(s) were never answered; ending the run`);
      run.awaiting.clear();
      this.finishRun(run);
    }, this.options.idleGraceMs ?? 15_000);
    this.graceTimer.unref?.();
  }
}

function toolResultParts(content: unknown): Array<{ type: "text"; text: string }> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => ({ type: "text" as const, text: part.text as string }));
}

// 送给 Claude Code 的一条用户消息的 content（SDK 的 SDKUserMessage.message 是 Anthropic 的 MessageParam）。
// 没有图片时就是文字。有图片时是内容块：文字在前，图片在后，每张是 base64 的图片块
// （{ type: "image", source: { type: "base64", media_type, data } }）。API 只收 jpeg、png、gif、webp
// （@anthropic-ai/sdk 的 Base64ImageSource），别的格式的图片不送（daemon 收图时已经按文件头核对过，几乎不会有），
// 在文字后面说一句，这一轮照常答。
type UserContent = SDKUserMessage["message"]["content"];
type ImageBlock = Extract<Exclude<UserContent, string>[number], { type: "image" }>;
type ImageMediaType = Extract<ImageBlock["source"], { type: "base64" }>["media_type"];
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set<ImageMediaType>(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function userContent(text: string, images?: readonly ImageContent[]): UserContent {
  if (!images?.length) return text;
  const blocks: ImageBlock[] = [];
  const skipped: string[] = [];
  for (const image of images) {
    if (IMAGE_MEDIA_TYPES.has(image.mimeType)) {
      blocks.push({ type: "image", source: { type: "base64", media_type: image.mimeType as ImageMediaType, data: image.data } });
    } else {
      skipped.push(image.mimeType);
    }
  }
  const note = skipped.length ? `\n\n（用户附的 ${skipped.length} 张图片格式不支持（${skipped.join("、")}），没有送到。）` : "";
  if (!blocks.length) return `${text}${note}`;
  return [...(text || note ? [{ type: "text" as const, text: `${text}${note}` }] : []), ...blocks];
}

// ——— 会话工厂 ———

export type ClaudeCodeSessionOptions = Parameters<typeof createLeadSession>[0];

export const CLAUDE_CODE_BACKEND_SECTION_TITLE = "## 你这次的后端：claude-code";

// pi 后端有、这个后端没有的工具（pi 的内置工具、扩展的工具，和要它们的工具）。
export const CLAUDE_CODE_MISSING_PI_TOOLS: readonly string[] = [
  "read", "grep", "find", "ls", "bash", "edit", "write", "codemode", "obs_recall", ...Object.keys(CLAUDE_CODE_EXCLUDED_TOOLS),
];

/** 系统提示词末尾的一节：告诉 Lead 这个后端少了哪些工具，别假装做了做不了的事。 */
export function claudeCodeBackendSection(): string {
  return [
    CLAUDE_CODE_BACKEND_SECTION_TITLE,
    "你这次跑在用户本机的 Claude Code 上（config.json 的 lead.backend 是 claude-code），用的是用户自己的 Claude 订阅额度。",
    "Lead 的工具都在（建工单、派发、工单操作、回复来源、发消息、记笔记、提醒、设置、连接……），检查、授权、审批和账本和平时一样。",
    // 上面几节已经按这个后端写（prompt.ts、environment.ts 的 backend 参数），这里只点名少了什么，和不常用的工具怎么找。
    `这个后端没有这些：${CLAUDE_CODE_MISSING_PI_TOOLS.join("、")}，也没有 Lead 自带的 skill：不要调用它们，也不要说读过 skill。`,
    "不常用的 Lead 工具不预先列出参数：提示里点名的工具不在你的工具表里时，先用 ToolSearch 按名字搜到它，再直接调。",
    "用户要你换你自己的模型时：list_lead_models 列的是 Claude Code 给的 claude-code/<模型>，switch_lead_model 只能换到它们，"
      + "推理强度只能选这个模型的 efforts；pi 的服务商的模型在这个后端换不了。",
    "用户要你做只有 pi 后端能做的事时，告诉他：把后端换回 pi（plc lead backend pi），再重启 daemon。",
    "这个会话不落盘：daemon 重启以后上下文从头开始，需要的事实用工具重新查。",
    "用户问你用了多少 token、额度还剩多少时：get_system_usage 的 lead_model 一节是 Claude Code 给的数（成本是按 API 价格的估算），"
      + "get_environment 也写着。",
  ].join("\n");
}

/**
 * 每一轮刷新的几节（身份、外观、代回复风格）有改动时放在消息前面的一段。和 daemon 的别的系统事件一样包成
 * <system_event kind="settings_refresh" source="daemon">（envelope.ts）：系统提示词讲过它不是用户的话，正文里的「<」都转义，
 * 设置里的文字结束不了这一段、也冒充不了用户的话。
 */
export function claudeCodeTurnContextBlock(sections: string): string {
  return leadSystemEvent("settings_refresh", `设置页的下面几节改过了：它们取代系统提示词里的同名几节，直到下一次更新。\n${sections}`);
}

/**
 * claude-code 后端的 SmartModel：先按直觉的分工问（Jev 这一类，分工里也可以有 Claude Code），都用不了时由 Claude Code（haiku）
 * 兜底（工单 #96：Jev 的 key 不能用了，判断不再依赖它）。自由文本补全（收件判断的兜底、线程整理）也用同一个 Claude Code。
 * 每次调用写一条 decision_model.called 事件（写不进去只记一行日志，判断照常返回），和 pi 后端的 session.ts 一样。
 */
function claudeCodeSmartModel(
  opts: ClaudeCodeSessionOptions, log: (line: string) => void,
): { smartModel: SmartModel | null; complete: SmartTextComplete | null } {
  const onCall: SmartModelCallObserver = (call) => {
    try {
      recordDecisionModelCall(opts.db, call);
    } catch (error) {
      log(`[lead] decision_model.called not recorded: ${(error as Error).message}`);
    }
  };
  try {
    const claudeCode = createClaudeCodeCompletion({ dataDir: opts.dataDir, onCall, log });
    const built = createSmartModel({
      ...(opts.decisionModel ? { decisionModel: opts.decisionModel } : {}),
      claudeCode: { complete: claudeCode.complete, model: claudeCode.model, fallback: true },
      logPath: smartModelDecisionLogPath(opts.dataDir),
      onCall,
      onNote: (note) => log(`[lead] ${note}`),
    });
    log(`[lead] smart model: ${built?.backend ?? "none"}`);
    return { smartModel: built, complete: claudeCode.text };
  } catch (error) {
    log(`[lead] smart model unavailable: ${(error as Error).message}`);
    return { smartModel: null, complete: null };
  }
}

/**
 * claude-code 后端的 Lead 会话（lead-backend.ts 的 createLeadEngine 选了它时）。工具用 createLeadToolset 建的同一份，
 * 参数和 pi 后端一样（daemon 给的依赖全部交给工具），只去掉这个后端用不了的（CLAUDE_CODE_EXCLUDED_TOOLS）。
 * configError：config.json 写错了，Lead 不可用，原因是这一句。
 */
export async function createClaudeCodeLeadSession(
  opts: ClaudeCodeSessionOptions,
  choice: { models: string[]; configError?: string },
  inject: {
    query?: ClaudeAgentSdk["query"];
    loadSdk?: () => Promise<ClaudeAgentSdk>;
    detect?: () => Promise<ClaudeCodeAvailability>;
    log?: (line: string) => void;
    idleGraceMs?: number;
    toolStartWaitMs?: number;
  } = {},
): Promise<LeadEngineFactoryResult> {
  const log = inject.log ?? ((line: string) => console.error(line));
  const models = choice.configError ? [] : choice.models;
  const firstSpec = models[0] ?? `${CLAUDE_CODE_MODEL_PROVIDER}/${DEFAULT_CLAUDE_CODE_MODEL}`;
  const firstChoice = claudeCodeModelChoice(firstSpec);
  const firstModel = firstChoice?.name ?? DEFAULT_CLAUDE_CODE_MODEL;
  // 专用的空目录：Claude Code 不从这里读到任何项目文件。
  const cwd = join(opts.dataDir, "lead-claude-code");
  mkdirSync(cwd, { recursive: true });

  let engine: ClaudeCodeLeadEngine | null = null;
  const currentSpec = () => engine?.currentSpec ?? `${CLAUDE_CODE_MODEL_PROVIDER}/${firstModel}`;
  // 决策模型（设置页的「直觉」，2026-11-04）：和 pi 后端（session.ts、smart-model.ts）一样带决策日志和 decision_model.called 事件。
  // 这个后端没有 pi 的 LLM，兜底是 Claude Code（haiku，工单 #96）。
  const { smartModel, complete: smartComplete } = claudeCodeSmartModel(opts, log);
  // get_environment 的现值，加上这个后端用的是哪种认证（Claude Code 报告的来源的名字，不是 key）。
  const environmentDetails = () => [
    renderEnvironmentDetails(collectLeadEnvironment({
      db: opts.db,
      dataDir: opts.dataDir,
      leadModel: currentSpec,
      smartModel: () => (smartModel ? { backend: smartModel.backend, llm: null } : null),
      connections: opts.connections ?? null,
      daemon: opts.environment ?? null,
    })),
    `- Lead 的后端：claude-code（用户本机的 Claude Code）。认证：${claudeCodeAuthSourceText(engine?.authSource ?? null)}`,
    ...(engine ? [engine.usageSummary()] : []),
  ].join("\n");
  // 和 pi 后端的凭证防护一样：已知密钥的值缓存一分钟，工具结果里出现时盖掉。
  let secretCache: { values: readonly string[]; at: number } | null = null;
  const secretValues = () => {
    if (!secretCache || Date.now() - secretCache.at > 60_000) {
      secretCache = { values: knownSecretValues(process.env, envConfigPath(opts.dataDir)), at: Date.now() };
    }
    return secretCache.values;
  };
  // 这一轮 Lead 读过什么（credibility/evidence.ts）：record_decision、ticket_action 的验收读它，和 pi 后端一样。
  const evidence = new TurnEvidence();
  const connectionToolReadOnly = (connection: string, tool: string) => {
    try {
      return opts.connections?.toolDtos(connection).find((entry) => entry.name === tool)?.readOnly ?? null;
    } catch {
      return null;
    }
  };
  const guards = createLeadToolGuards({
    db: opts.db, dataDir: opts.dataDir, secretValues, evidence, isEvidenceTool: isLeadEvidenceTool, connectionToolReadOnly,
    ...(opts.turnOrigin ? { turnOrigin: opts.turnOrigin } : {}),
    ...(opts.currentTurnId ? { currentTurnId: opts.currentTurnId } : {}),
    ...(opts.toolGate ? { toolGate: opts.toolGate } : {}),
    // 上下文用量：引擎记着的（SDK 的 usage 和 getContextUsage），大结果的尾注写上下文到哪了，和 pi 一样。
    contextUsage: () => engine?.leadContextUsage() ?? null,
    log,
  });
  // 和 session.ts 给 pi 的工具的依赖一样，少了 pi 会话才有的：userSkills（find_skill，这个后端不给）。
  const toolDeps: LeadDeps = {
    db: opts.db, dbPath: opts.dbPath, dataDir: opts.dataDir,
    ...(opts.onChildDone ? { onChildDone: opts.onChildDone } : {}),
    ...(opts.onChildEvent ? { onChildEvent: opts.onChildEvent } : {}),
    ...(opts.childPi ? { childPi: opts.childPi } : {}),
    ...(opts.runtimeRegistry ? { runtimeRegistry: opts.runtimeRegistry } : {}),
    ...(opts.currentTurnId ? { currentTurnId: opts.currentTurnId } : {}),
    ...(opts.turnOrigin ? { turnOrigin: opts.turnOrigin } : {}),
    ...(opts.cancelBudgetTurnId ? { cancelBudgetTurnId: opts.cancelBudgetTurnId } : {}),
    ...(opts.announceLeadStatus ? { announceLeadStatus: opts.announceLeadStatus } : {}),
    ...(opts.scheduleLeadModelRestart ? { scheduleLeadModelRestart: opts.scheduleLeadModelRestart } : {}),
    ...(opts.ticketActionHost ? { ticketActionHost: opts.ticketActionHost } : {}),
    ...(opts.uiActionServices ? { uiActionServices: opts.uiActionServices } : {}),
    ...(opts.pullRequestRunner ? { pullRequestRunner: opts.pullRequestRunner } : {}),
    ...(opts.ticketSummaries ? { ticketSummaries: opts.ticketSummaries } : {}),
    ...(opts.ticketSummary ? { ticketSummary: opts.ticketSummary } : {}),
    ...(opts.leadHealth ? { leadHealth: opts.leadHealth } : {}),
    ...(smartModel ? { smartModel } : {}),
    ...(opts.memory ? { memory: opts.memory } : {}),
    ...(opts.connections ? { connections: opts.connections } : {}),
    ...(opts.channelCards ? { channelCards: opts.channelCards } : {}),
    turnEvidence: () => evidence.list(),
    environmentDetails,
    // get_system_usage 的 lead_model：这个后端的 token、估算的成本和订阅额度（pi 后端没有这一节）。
    leadModelUsage: () => engine?.usageReport() ?? null,
    ...(opts.turnUserActions ? { turnUserActions: opts.turnUserActions } : {}),
    ...(opts.leadModelQuota ? { leadModelQuota: opts.leadModelQuota } : {}),
    ...(opts.configSlackEmoji ? { configSlackEmoji: opts.configSlackEmoji } : {}),
  };
  const tools = selectClaudeCodeTools(createLeadToolset(toolDeps));
  // 处理函数经 bridge 找引擎（引擎要先有工具才建得出来）。
  const bridge: ClaudeCodeToolBridge = {
    begin: (name, toolUseId, signal) => (engine
      ? engine.toolBridge.begin(name, toolUseId, signal)
      : Promise.resolve({ ok: false, reason: `${name} 没有执行：Lead 的会话还没建好。` })),
    end: (toolCallId, result, isError) => engine?.toolBridge.end(toolCallId, result, isError),
  };
  const { tools: mcpTools, allowedTools } = claudeCodeMcpTools(tools, { guards, bridge, log });
  const toolNames = allowedTools.map(leadToolName);

  // 每一轮刷新的几节（pi 的 before_agent_start 改写的身份、外观、代回复风格；环境一节只写组件和能力，进程里不变）。
  // 设置页（或者 Lead 自己的 update_lead_profile 一类工具）改了以后，下一条消息前面放一段新的（claudeCodeTurnContextBlock）。
  const renderRefreshed = (): string => {
    const part = (title: string, render: () => string | null, empty: string) => {
      try {
        return `### ${title}\n${render() ?? empty}`;
      } catch (error) {
        log(`[lead] claude-code: ${title} section skipped: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    };
    return [
      part("身份（identity）", () => renderLeadIdentity(leadProfileFields(getLeadProfile(opts.db))), ""),
      part("外观（appearance）", () => renderAppearance(designPreferencesFields(getDesignPreferences(opts.db))), ""),
      part("代回复风格（reply-style）", () => renderReplyStyle(getReplyStyle(opts.db).text), "（没有代回复风格：代用户写的话按缺省的写法。）"),
    ].filter((text): text is string => text !== null).join("\n\n");
  };
  let sentSections: string | null = null;
  const turnContext = (): string | null => {
    const now = renderRefreshed();
    if (sentSections === null || now === sentSections) {
      sentSections ??= now;
      return null;
    }
    sentSections = now;
    return tildeHome(claudeCodeTurnContextBlock(now), homedir());
  };

  // 系统提示词：每次起 query 时生成（会话开始时的身份、外观、代回复风格；之后的改动由 turnContext 补上）。
  const systemPrompt = () => {
    const sections: string[] = [renderLeadSystemPrompt(renderCoreMemory(opts.db), renderStandingOrdersForLead(opts.db), "claude-code")];
    const attempt = (what: string, render: () => string | null) => {
      try {
        const text = render();
        if (text) sections.push(text);
      } catch (error) {
        log(`[lead] claude-code: ${what} section skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    attempt("identity", () => renderLeadIdentity(leadProfileFields(getLeadProfile(opts.db))));
    attempt("appearance", () => renderAppearance(designPreferencesFields(getDesignPreferences(opts.db))));
    attempt("reply-style", () => renderReplyStyle(getReplyStyle(opts.db).text));
    attempt("environment", () => renderLeadEnvironment("claude-code"));
    sections.push(claudeCodeBackendSection());
    // 新的 query 从这里的几节开始：之后有改动才补。
    sentSections = renderRefreshed();
    // 系统提示词里不写用户目录的完整路径（home-paths.ts）。
    return tildeHome(sections.join("\n\n"), homedir());
  };

  // 回复里的代码引用核对（和 pi 的 agent_before_settle 一样，credibility/extension.ts）。
  const beforeSettle = (run: { texts: string[]; prompts: string[]; toolArgs: unknown[] }): Promise<string | null> => replyCodeRefCorrection(
    { db: opts.db, log: (line) => log(`[lead] ${line}`) }, run.texts, run.prompts, run.toolArgs.flatMap(touchedTickets),
  );

  const configError = choice.configError;
  const detect = configError
    ? async (): Promise<ClaudeCodeAvailability> => ({ ok: false, reason: `Lead 不可用：${configError}` })
    : inject.detect ?? cachedClaudeCodeDetector(() => detectClaudeCode());

  engine = new ClaudeCodeLeadEngine({
    cwd, model: firstModel, effort: firstChoice?.effort ?? null, systemPrompt, mcpTools, allowedTools, detect, log,
    onRunSettled: () => guards.resetTurn(),
    beforeSettle,
    turnContext,
    ...(inject.query ? { query: inject.query } : {}),
    ...(inject.loadSdk ? { loadSdk: inject.loadSdk } : {}),
    ...(inject.idleGraceMs !== undefined ? { idleGraceMs: inject.idleGraceMs } : {}),
    ...(inject.toolStartWaitMs !== undefined ? { toolStartWaitMs: inject.toolStartWaitMs } : {}),
  });
  const session: LeadEngine = engine;
  log(`[lead] claude-code backend: ${toolNames.length} tools, model ${firstSpec}`);
  return {
    session,
    modelName: configError ? `${CLAUDE_CODE_MODEL_PROVIDER}/unavailable` : firstSpec,
    // 只有 claude-code/<模型>：daemon 的模型切换只在这些之间换（限流、额度用完时）。
    ...(models.length ? { models, switchModel: (spec: string) => engine!.switchModel(spec) } : {}),
    claudeCodeModels: () => engine!.supportedModels(),
    reportsInputDelivery: false,
    smartModel,
    // 自由文本补全：Claude Code（haiku）。设置 → 模型的「问大脑」那一项只对 pi 的 LLM 有意义，这里没有。
    complete: smartComplete,
    smartModelLlm: null,
    brainReady: async () => (await detect()).ok,
  };
}
