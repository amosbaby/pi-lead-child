// shadow 的会话（shadow.ts 是规则）：一批事件开一个进程内的隔离会话，处理完就丢掉。
//   - 会话的隔离和代查一样（lookup/session.ts 的 createIsolatedLookupSession）：内存会话，不加载扩展、skill、AGENTS.md。
//   - 开头固定（SHADOW_OPENING）：建好会话以后先放进一轮固定的用户和助手消息，事件放在后面。
//   - 模型：设置里选的（lead_shadow 的 model），没选时和主会话同一个。注册不到时用主会话的模型，结果里写明。
//   - 用量：每次模型调用的 input、output、cacheRead、cacheWrite 加起来，记进 lead.shadow_run（daemon 写），用来比对省没省。
//   - 时限：超过时限就中止，这一批全部交给主会话（resolveShadowOutcome）。
// 测试接缝：ShadowSessionFactory 可以注入（测试用 pi-ai 的假模型）。
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadLeadModelConfig, registerLeadProviders, resolveLeadModel } from "../model-config.js";
import { createIsolatedLookupSession, LOOKUP_MAX_OUTPUT_TOKENS, type LookupSession } from "../lookup/session.js";
import { SHADOW_OPENING } from "./shadow.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface ShadowSessionRequest {
  systemPrompt: string;
  tools: ToolDefinition[];
  /** provider/model。 */
  model: string;
}

/** shadow 会话。固定开头由工厂在建会话时放进去（createIsolatedLookupSession 的 seedMessages）。 */
export type ShadowSession = LookupSession;

/** 建一个shadow 会话。model 是实际用的 provider/model；note 说明为什么和要的不一样。 */
export type ShadowSessionFactory = (request: ShadowSessionRequest) => Promise<{ session: ShadowSession; model: string; note: string | null }>;

export interface ShadowUsage {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ShadowSessionResult {
  model: string;
  modelNote: string | null;
  usage: ShadowUsage;
  /** 出错、超时、会话建不起来时的说明。 */
  error: string | null;
  durationMs: number;
}

const DEFAULT_SHADOW_TIMEOUT_MS = 180_000;
const NUDGE = "（你还没有调用 finish_shadow。现在调用它：这一批的每个编号放进 done 或 escalate。）";

/** 固定开头的两条消息（pi 的 AgentMessage 形状）。助手消息的 provider 和 model 写成这个会话的，usage 记零。 */
export function shadowOpeningMessages(model: { api: string; provider: string; id: string }): unknown[] {
  const at = 0;
  return [
    { role: "user", content: [{ type: "text", text: SHADOW_OPENING.user }], timestamp: at },
    {
      role: "assistant", content: [{ type: "text", text: SHADOW_OPENING.assistant }],
      api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: at,
    },
  ];
}

/**
 * 跑一批：建会话、放固定开头、发这一批的消息。模型没调 finish_shadow 就停了时提醒一次。
 * finished() 说 finish_shadow 调过没有（shadow.ts 的 ShadowRecorder.report）。
 */
export async function runShadowSession(input: {
  factory: ShadowSessionFactory;
  request: ShadowSessionRequest;
  text: string;
  finished: () => boolean;
  /** 每个工具调用开始时（daemon 据此把读了外部内容的一轮标成外部的）。 */
  onToolStart?: (toolName: string) => void;
  /** 每次模型调用结束时（daemon 记进自动调用的预算）。 */
  onCall?: (usage: Record<string, unknown>, stopReason: string | null) => void;
  timeoutMs?: number;
  now?: () => number;
}): Promise<ShadowSessionResult> {
  const now = input.now ?? Date.now;
  const started = now();
  const usage: ShadowUsage = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let model = input.request.model;
  let modelNote: string | null = null;
  let error: string | null = null;
  let session: ShadowSession | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  try {
    const created = await input.factory(input.request);
    session = created.session;
    model = created.model;
    modelNote = created.note;
    session.subscribe((event: any) => {
      if (event?.type === "tool_execution_start" && typeof event.toolName === "string") input.onToolStart?.(event.toolName);
      if (event?.type !== "message_end" || event.message?.role !== "assistant") return;
      const used = event.message.usage ?? {};
      input.onCall?.(used, event.message.stopReason ? String(event.message.stopReason) : null);
      usage.calls += 1;
      usage.input += Number(used.input ?? 0);
      usage.output += Number(used.output ?? 0);
      usage.cacheRead += Number(used.cacheRead ?? 0);
      usage.cacheWrite += Number(used.cacheWrite ?? 0);
      if (event.message.stopReason === "error" && event.message.errorMessage) error = String(event.message.errorMessage);
    });
    const timeoutMs = input.timeoutMs ?? DEFAULT_SHADOW_TIMEOUT_MS;
    const live = session;
    timer = setTimeout(() => { timedOut = true; void live.abort().catch(() => {}); }, timeoutMs);
    timer.unref?.();
    await session.prompt(input.text);
    if (!input.finished() && !timedOut && !error) await session.prompt(NUDGE);
    if (timedOut) error = `超过了 ${Math.round(timeoutMs / 1000)} 秒的时限`;
  } catch (caught) {
    error ??= timedOut ? "超过了时限" : caught instanceof Error ? caught.message : String(caught);
  } finally {
    if (timer) clearTimeout(timer);
    try { session?.dispose(); } catch { /* 会话已经坏了，没有别的要收拾 */ }
  }
  return { model, modelNote, usage, error, durationMs: now() - started };
}

/**
 * daemon 用的会话工厂：ModelRuntime 按模型的配置建一次，配置变了时重建（和代查的工厂一样）。
 * 要的模型注册不到时，用 fallbackModel（主会话的模型），并写明原因。
 */
export function createShadowSessionFactory(input: {
  dataDir: string;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  authPath?: string;
  /** 主会话现在用的模型（provider/model）。 */
  fallbackModel: () => string;
  /** 会话的空目录放在哪里。缺省是 <dataDir>/shadow。 */
  workDir?: string;
}): ShadowSessionFactory {
  const env = input.env ?? process.env;
  let prepared: Promise<ModelRuntime> | null = null;
  let preparedKey: string | null = null;
  const runtimeFor = (config: ReturnType<typeof loadLeadModelConfig>): Promise<ModelRuntime> => {
    const key = createHash("sha256").update(JSON.stringify(config)).digest("hex");
    if (!prepared || preparedKey !== key) {
      preparedKey = key;
      prepared = (async () => {
        const runtime = await ModelRuntime.create({
          allowModelNetwork: false, refreshOnCreate: false, ...(input.authPath ? { authPath: input.authPath } : {}),
        });
        const notes = await registerLeadProviders(runtime, config, env, fetch, { maxOutputTokens: LOOKUP_MAX_OUTPUT_TOKENS });
        for (const note of notes) input.log?.(`[shadow] ${note}`);
        return runtime;
      })();
      prepared.catch(() => { if (preparedKey === key) { prepared = null; preparedKey = null; } });
    }
    return prepared;
  };
  return async (request) => {
    const runtime = await runtimeFor(loadLeadModelConfig(input.dataDir, env));
    let spec = request.model;
    let note: string | null = null;
    let resolved: Awaited<ReturnType<typeof resolveLeadModel>>;
    try {
      resolved = await resolveLeadModel(runtime, spec);
    } catch (wanted) {
      const fallback = input.fallbackModel();
      if (fallback === spec) throw wanted;
      note = `设置的模型 ${spec} 用不了（${wanted instanceof Error ? wanted.message : String(wanted)}），用主会话的模型 ${fallback}`;
      spec = fallback;
      resolved = await resolveLeadModel(runtime, spec);
    }
    const base = await createIsolatedLookupSession({
      workDir: input.workDir ?? join(input.dataDir, "shadow"),
      systemPrompt: request.systemPrompt,
      tools: request.tools,
      model: resolved.model,
      modelRuntime: runtime,
      // shadow 会话出错就交给主会话，不在这里重试：重试的时间不如直接交出去。
      retry: false,
      seedMessages: shadowOpeningMessages(resolved.model as { api: string; provider: string; id: string }),
    });
    return { session: base, model: `${resolved.provider}/${resolved.id}`, note };
  };
}
