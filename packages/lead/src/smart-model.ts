// Lead 会话的 SmartModel（2026-10-16 用户决定）：决策模型（设置页「模型」的「直觉」，缺省 TypeSafe 的 Jev）有 key 时用它，
// 失败时用 LLM 兜底；没有 key 时只用 LLM。LLM 走 Lead 自己的 ModelRuntime 和 config.json 里的 provider。
// LLM 用哪个模型（每次调用时现选，跟着目录和设置变，不用重启）：
//   0. 设置页选的（config.json 的 decision.llmFallback，2026-10-29），注册得到时用它；
//   1. PLC_SMART_MODEL（provider/model）；
//   2. 后台模型（background-model.ts，2026-11-20）：kv lead.background_model 选的，或者自动：按价格算出的第一个便宜模型；
//      都不便宜时是不比 Lead 的模型贵的最便宜的那个；再没有时是 Lead 自己的模型。
// A broken background model never freezes Lead (spec 2026-11-20): failures of these calls do not feed the model-hold
// breaker. An account-level failure still enters the hold. A configuration or quota failure marks the model broken for
// 1 hour, and the same call retries once on the next choice.
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createSmartModel, decisionPurpose, LLM_BACKEND, SmartModelBackendError, smartModelDecisionLogPath,
  type CreateSmartModelOptions, type SmartModel, type SmartTextComplete,
} from "@pi-lead-child/engine";
import { isLeadAccountFailure, type BackgroundModelSource } from "@pi-lead-child/protocol";
import {
  backgroundFailureClass, BrokenBackgroundModels, resolveBackgroundModel,
  type BackgroundFailureClass, type LeadCatalogSource,
} from "./background-model.js";
import { configuredPrice, type LeadCatalogModel, type LeadModelConfig } from "./model-config.js";
import { isModelHoldRefusal, modelHoldError, type ModelHoldPort } from "./model-hold.js";

export { newestModelSpec } from "./background-model.js";

// 模型暂停拒了这次调用（调用没有发出去）。kind 还是 unconfigured：调用方照旧按没有 LLM 后端处理。
class ModelHeldError extends SmartModelBackendError {
  constructor(message: string) {
    super(LLM_BACKEND, message, "unconfigured");
  }
}

// 调用记录只数真的调用：模型暂停拒了的那一次不记（2026-11-20：暂停期间每次拒绝都记成一次失败的 decision_model.called）。
function isHoldRefusalRecord(record: { ok: boolean; errorKind: string | null; error: string | null }): boolean {
  return !record.ok && record.errorKind === "unconfigured" && isModelHoldRefusal(record.error);
}

const SMART_MODEL_SPEC = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[^\s/][^\s]{0,199}$/;
const MAX_REPLY_TOKENS = 2_048;

export interface SmartModelSpecChoice {
  spec: string;
  /** env: PLC_SMART_MODEL; the others are resolveBackgroundModel's sources ("main" is Lead's own model). */
  source: "env" | BackgroundModelSource;
  /** 选择时遇到的问题，例如 PLC_SMART_MODEL 格式不对。 */
  note: string | null;
}

/** spec 是不是 provider/model 的格式：provider 是一个名字，model 不含空白。 */
export function isValidSmartModelSpec(spec: string): boolean {
  return SMART_MODEL_SPEC.test(spec);
}

/** Lead 的 provider 配置里列出的模型，按 provider 的顺序；registered 补上 discover 拉到的模型。 */
export function configuredLeadModelSpecs(
  config: Pick<LeadModelConfig, "providers">,
  registered: (provider: string) => readonly string[] = () => [],
): string[] {
  const specs: string[] = [];
  for (const [provider, settings] of Object.entries(config.providers)) {
    for (const id of [...(settings.models ?? []).map((model) => model.id), ...registered(provider)]) {
      const spec = `${provider}/${id}`;
      if (!specs.includes(spec)) specs.push(spec);
    }
  }
  return specs;
}

/**
 * A catalog from the models the session registered, for when the priced catalog is not read yet. pi's model cost is the
 * price for built-in providers (subscriptions); Lead's own providers register 0, which reads as no price.
 */
export function registeredLeadCatalog(
  config: Pick<LeadModelConfig, "providers">,
  modelRuntime: Pick<ModelRuntime, "getModels">,
): LeadCatalogModel[] {
  const registered = (provider: string) => {
    try {
      return modelRuntime.getModels(provider) as ReadonlyArray<{ id: string; cost?: unknown; created?: unknown }>;
    } catch {
      return [];
    }
  };
  const costs = new Map<string, unknown>();
  for (const provider of Object.keys(config.providers)) for (const model of registered(provider)) costs.set(`${provider}/${model.id}`, model.cost);
  return configuredLeadModelSpecs(config, (provider) => registered(provider).map((model) => model.id)).map((spec) => {
    const slash = spec.indexOf("/");
    const price = configuredPrice(costs.get(spec));
    return {
      provider: spec.slice(0, slash), id: spec.slice(slash + 1), group: null, source: null, name: null, input: ["text"],
      efforts: [], defaultEffort: null, contextWindow: null, maxTokens: null, created: null,
      price: price && (price.input > 0 || price.output > 0) ? price : null,
    };
  });
}

/** 选 LLM 后端的模型：PLC_SMART_MODEL，否则后台模型（resolveBackgroundModel）。 */
export function selectSmartModelSpec(input: {
  env?: Record<string, string | undefined>;
  catalog: readonly LeadCatalogModel[];
  leadSpec: string;
  /** kv lead.background_model (null: automatic). */
  setting?: string | null;
  isBroken?: (spec: string) => boolean;
}): SmartModelSpecChoice {
  const env = input.env ?? process.env;
  const fromEnv = env.PLC_SMART_MODEL?.trim();
  let note: string | null = null;
  if (fromEnv) {
    if (!isValidSmartModelSpec(fromEnv)) note = "PLC_SMART_MODEL must be provider/model; ignoring it";
    else if (!input.isBroken?.(fromEnv)) return { spec: fromEnv, source: "env", note: null };
  }
  const choice = resolveBackgroundModel({
    catalog: input.catalog, mainSpec: input.leadSpec, setting: input.setting ?? null, ...(input.isBroken ? { isBroken: input.isBroken } : {}),
  });
  return choice.spec ? { spec: choice.spec, source: choice.source, note } : { spec: input.leadSpec, source: "main", note };
}

function replyText(reply: Awaited<ReturnType<ModelRuntime["completeSimple"]>>): string {
  if (reply.stopReason === "error" || reply.stopReason === "aborted") {
    throw new Error(reply.errorMessage ?? `the model stopped with ${reply.stopReason}`);
  }
  return reply.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

export interface LeadSmartModel {
  smartModel: SmartModel | null;
  /**
   * 同一个便宜模型（LLM 后端）的自由文本补全（slack-takeover 工单 07）：要模型写一段话、而不是回答几个问题时用。
   * 每次调用经 onCall 交出一条调用记录（后端 llm、用途是调用方给的 purpose），session.ts 把它写成 decision_model.called，
   * get_system_usage 按用途统计。没有 LLM 后端时为 null。
   */
  complete: SmartTextComplete | null;
  /** LLM 后端建好时选的模型。每次调用时现选（见文件开头），currentSpec 是最近一次用的。没有 LLM 后端时为 null。 */
  llmSpec: string | null;
  /** The model the last call used, or llmSpec before the first call. */
  currentSpec: () => string | null;
  notes: string[];
}

/** Health hooks of the background model (the background-health module subscribes later). */
export interface BackgroundModelHooks {
  /**
   * A background call failed. switchedTo is the model the same call retries on, or null when it does not retry.
   * Not called when the caller aborted the call.
   */
  onBackgroundFailure?: (model: string, reasonClass: BackgroundFailureClass, reason: string, switchedTo: string | null) => void;
  /** A background call succeeded on this model. */
  onBackgroundSuccess?: (model: string) => void;
}

/** 给一个 Lead 会话建 SmartModel。每个会话建一次。 */
export function createLeadSmartModel(input: {
  modelRuntime: Pick<ModelRuntime, "getModel" | "getModels" | "completeSimple">;
  config: LeadModelConfig;
  leadSpec: string;
  /** Lead's model now (it changes when Lead switches models). Not given: leadSpec. */
  currentLeadSpec?: () => string | null;
  dataDir: string;
  // 决策模型的配置和 key（daemon 的 MemoryController）。不给时只用 LLM。
  decisionModel?: CreateSmartModelOptions["decisionModel"];
  // 每次调用结束时的调用记录（工单 13）：session.ts 把它写成 decision_model.called 事件。
  onCall?: CreateSmartModelOptions["onCall"];
  // 设置页选的「都用不了时问大脑的哪个模型」（provider/model，可以带推理强度）。每次调用时读；没选或者注册不到时用下面选出的。
  llmFallback?: () => string | null;
  /** The priced model catalog (background-model.ts). Not given: the registered models, without prices. */
  catalog?: LeadCatalogSource;
  /** kv lead.background_model, read on each call (null: automatic). */
  backgroundModel?: () => string | null;
  /** Models skipped after a configuration or quota failure. Shared with the daemon (background_model.read). */
  broken?: BrokenBackgroundModels;
  env?: Record<string, string | undefined>;
  /**
   * 每条说明出现时调用一次。决策模型不能用的说明在第一次读 backend 时才出现，会话中途改了配置时也会出现，
   * 所以调用方要在打 backend 那一行之前接上它，否则日志里看不到原因。
   */
  onNote?: (note: string) => void;
  /**
   * 模型暂停（model-hold.ts）。LLM 后端走 Lead 的 provider 和账号：暂停期间不调模型，抛 MODEL_HOLD_ERROR（kind=unconfigured，
   * 调用方按没有 LLM 后端处理）。只有账号级的失败报给它（进入暂停）；别的失败不进熔断（2026-11-20：坏掉的后台模型让 Lead
   * 停了一天多）。决策模型（Jev）是另一个服务、另一个 key，不受影响。
   */
  hold?: ModelHoldPort;
} & BackgroundModelHooks): LeadSmartModel {
  const env = input.env ?? process.env;
  const notes: string[] = [];
  const note = (text: string): void => {
    notes.push(text);
    input.onNote?.(text);
  };
  const broken = input.broken ?? new BrokenBackgroundModels();
  const resolve = (spec: string) => {
    const slash = spec.indexOf("/");
    return slash > 0 ? input.modelRuntime.getModel(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;
  };
  const setting = (): string | null => {
    try {
      return input.backgroundModel?.()?.trim() || null;
    } catch {
      return null;
    }
  };
  const leadSpecNow = (): string => {
    try {
      return input.currentLeadSpec?.()?.trim() || input.leadSpec;
    } catch {
      return input.leadSpec;
    }
  };
  const registered = () => registeredLeadCatalog(input.config, input.modelRuntime);
  const choose = (catalog: readonly LeadCatalogModel[]) => selectSmartModelSpec({
    env, catalog, leadSpec: leadSpecNow(), setting: setting(), isBroken: broken.isBroken,
  });
  const initialCatalog = input.catalog?.snapshot() ?? null;
  const choice = choose(initialCatalog?.length ? initialCatalog : registered());
  if (choice.note) note(choice.note);
  let llmSpec: string | null = choice.spec;
  let model = resolve(choice.spec);
  if (!model && choice.spec !== input.leadSpec) {
    note(`smart model ${choice.spec} is not registered; using the Lead model ${input.leadSpec}`);
    llmSpec = input.leadSpec;
    model = resolve(input.leadSpec);
  }
  if (!model) {
    note(`smart model ${llmSpec} is not registered; no LLM backend`);
    llmSpec = null;
  }
  const resolved = model;
  let lastSpec: string | null = llmSpec;
  // 设置页选的模型：注册得到时用它（带推理强度的先找带后缀的，再找不带的）。注册不到时只说一次，用后台模型。
  let missingChoice: string | null = null;
  const chosen = (): { spec: string; model: NonNullable<typeof resolved> } | null => {
    let spec: string | null = null;
    try {
      spec = input.llmFallback?.()?.trim() || null;
    } catch {
      spec = null;
    }
    if (!spec) return null;
    const bare = spec.replace(/\([A-Za-z0-9_-]{1,32}\)$/, "");
    const found = resolve(spec) ?? resolve(bare);
    if (found) {
      missingChoice = null;
      return { spec: resolve(spec) ? spec : bare, model: found };
    }
    if (missingChoice !== spec) note(`the chosen smart model ${spec} is not registered; using the background model`);
    missingChoice = spec;
    return null;
  };
  // The models to try for one call, in order, without broken ones: the user's choice, then PLC_SMART_MODEL or the
  // background model (resolveBackgroundModel's candidates). Read on each call: the catalog and the setting can change.
  const targets = async (): Promise<Array<{ spec: string; model: NonNullable<typeof resolved> }>> => {
    const list: Array<{ spec: string; model: NonNullable<typeof resolved> }> = [];
    const add = (spec: string | null) => {
      if (!spec || broken.isBroken(spec) || list.some((entry) => entry.spec === spec)) return;
      const found = resolve(spec);
      if (found) list.push({ spec, model: found });
    };
    const explicit = chosen();
    if (explicit && !broken.isBroken(explicit.spec)) list.push(explicit);
    let catalog: readonly LeadCatalogModel[] = [];
    try {
      catalog = input.catalog ? await input.catalog.get() : [];
    } catch {
      catalog = input.catalog?.snapshot() ?? [];
    }
    if (catalog.length === 0) catalog = registered();
    const fromEnv = env.PLC_SMART_MODEL?.trim();
    if (fromEnv && isValidSmartModelSpec(fromEnv)) add(fromEnv);
    for (const spec of resolveBackgroundModel({ catalog, mainSpec: leadSpecNow(), setting: setting(), isBroken: broken.isBroken }).candidates) {
      add(spec);
    }
    if (list.length === 0 && resolved && llmSpec) list.push({ spec: llmSpec, model: resolved });
    return list;
  };
  const failed = (spec: string, error: unknown, switchedTo: string | null, signal: AbortSignal | undefined): BackgroundFailureClass => {
    const reason = errorMessage(error);
    const reasonClass = backgroundFailureClass(reason);
    if (reasonClass === "config" || reasonClass === "quota") broken.mark(spec, reasonClass, reason);
    // Account safety: an account-level failure still enters the hold. A quota failure that the call could move away
    // from is the model's, not the account's.
    if (reasonClass === "account" || (reasonClass === "quota" && switchedTo === null && isLeadAccountFailure(reason))) {
      input.hold?.failed("decision", reason);
    }
    if (!signal?.aborted) {
      try {
        input.onBackgroundFailure?.(spec, reasonClass, reason, switchedTo);
      } catch {
        // The health hook must not change the call's result.
      }
    }
    return reasonClass;
  };
  const succeeded = (spec: string) => {
    lastSpec = spec;
    broken.clear(spec);
    try {
      input.onBackgroundSuccess?.(spec);
    } catch {
      // The health hook must not change the call's result.
    }
  };
  const call = async (target: NonNullable<typeof resolved>, prompt: string, signal: AbortSignal | undefined, maxTokens: number) =>
    replyText(await input.modelRuntime.completeSimple(
      target,
      { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
      { ...(signal ? { signal } : {}), maxTokens },
    ));
  // 一个都注册不到时没有 LLM 后端（和以前一样）：不因为设置页选了模型就多出一个总是失败的后端。
  const llm = resolved
    ? async (prompt: string, signal: AbortSignal | undefined, maxTokens: number): Promise<{ text: string; spec: string }> => {
      if (input.hold?.held) throw new ModelHeldError(modelHoldError(input.hold.state));
      const list = await targets();
      const first = list[0]!;
      try {
        const text = await call(first.model, prompt, signal, maxTokens);
        succeeded(first.spec);
        return { text, spec: first.spec };
      } catch (error) {
        const reasonClass = backgroundFailureClass(errorMessage(error));
        // Automatic failover, once per call: a configuration or quota failure moves the call to the next model.
        const next = (reasonClass === "config" || reasonClass === "quota") && !signal?.aborted
          ? list.find((entry) => entry.spec !== first.spec) ?? null : null;
        failed(first.spec, error, next?.spec ?? null, signal);
        if (!next) throw error;
        note(`background model ${first.spec} failed (${reasonClass}); retrying on ${next.spec}`);
        try {
          const text = await call(next.model, prompt, signal, maxTokens);
          succeeded(next.spec);
          return { text, spec: next.spec };
        } catch (retryError) {
          failed(next.spec, retryError, null, signal);
          throw retryError;
        }
      }
    }
    : null;
  const smartModel = createSmartModel({
    ...(input.decisionModel ? { decisionModel: input.decisionModel } : {}),
    ...(llm
      ? { complete: async (prompt: string, signal?: AbortSignal) => (await llm(prompt, signal, MAX_REPLY_TOKENS)).text, completeModel: llmSpec }
      : {}),
    logPath: smartModelDecisionLogPath(input.dataDir),
    ...(input.onCall ? { onCall: (record) => { if (!isHoldRefusalRecord(record)) input.onCall!(record); } } : {}),
    onNote: note,
  });
  const complete: SmartTextComplete | null = llm
    ? async (prompt, opts) => {
      const started = Date.now();
      const report = (outcome: { ok: true } | { ok: false; error: unknown }) => {
        try {
          input.onCall?.({
            purpose: decisionPurpose(opts.purpose), backend: LLM_BACKEND, model: lastSpec, latencyMs: Date.now() - started,
            ok: outcome.ok, error: outcome.ok ? null : errorMessage(outcome.error),
            errorKind: outcome.ok ? null : opts.signal?.aborted ? "aborted" : "error", fallbackFrom: null,
          });
        } catch {
          // 记录只用来统计，不能挡住补全本身。
        }
      };
      try {
        const maxTokens = Number.isFinite(opts.maxTokens) ? Math.min(Math.max(1, Math.trunc(opts.maxTokens!)), MAX_REPLY_TOKENS) : MAX_REPLY_TOKENS;
        const { text } = await llm(prompt, opts.signal, maxTokens);
        report({ ok: true });
        return text;
      } catch (error) {
        // 模型暂停拒了：调用没有发出去，不记。
        if (!(error instanceof ModelHeldError)) report({ ok: false, error });
        throw error;
      }
    }
    : null;
  return { smartModel, complete, llmSpec, currentSpec: () => lastSpec, notes };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
