// The model that background work uses (user 2026-11-20, protocol's background-model.ts). Two operations. The page route
// (POST /v1/actions/background_model/lead/<action>) and Lead (perform_action) call these definitions.
//   - set: lead_allowed, not a rule change (switching a model is not one, AGENTS.md). Lead may choose only a model that is
//     cheap now (the service's cheap list), or null (automatic: the first cheap model). The user may choose any model of
//     Lead's catalog. A refusal lists the cheap models.
//   - read: read-only. The setting, the model in use, the cheap models, the models skipped after a failure, and the health
//     of each background job (jobs: background model, channel memory, Hindsight; engine's background-health.ts).
// The same Lead-only check guards the shadow model (lead-shadow.ts) and Hindsight's summary slots (memory-settings.ts):
// assertLeadCheapModel.
import {
  BACKGROUND_MODEL_RESOURCE, type BackgroundJobState, type BackgroundModelReadResult, type BackgroundModelState, type SetBackgroundModelRequest,
} from "@pi-lead-child/protocol";
import { getBackgroundModel, publishGatewayEvent, writeBackgroundModel } from "@pi-lead-child/store";
import type { ActionAttribution } from "../ticket-actions/attribution.js";
import { AVAILABLE } from "../ticket-actions/types.js";
import { UiActionError, type UiActionDefinition, type UiActionEnv, type UiActionTargetKind } from "./types.js";

export const BACKGROUND_MODEL_WHERE = "设置 → 模型，或者会话里直接告诉 Lead";

export interface BackgroundModelTarget {
  // The stored choice (null: automatic).
  setting: string | null;
  // The last state the service read (null: not read yet, or no service).
  state: BackgroundModelState | null;
}

export interface BackgroundModelChange {
  changed: boolean;
  before: string | null;
  setting: string | null;
  state: BackgroundModelState | null;
}

function list(models: readonly string[]): string {
  return models.length ? models.join("、") : "（现在没有）";
}

function words(target: BackgroundModelTarget): string {
  const state = target.state;
  const chosen = target.setting ? `选的是 ${target.setting}` : "自动（第一个便宜的模型）";
  if (!state) return `后台模型：${chosen}。`;
  return `后台模型：${chosen}；现在用的是 ${state.resolved ?? "没有"}（${state.source}）；`
    + `便宜的模型（输入和输出的价格都不超过 Lead 的模型 ${state.main ?? "?"} 的 1/4）：${list(state.cheap)}`
    + (state.broken.length ? `；暂时跳过：${state.broken.map((entry) => `${entry.model}（到 ${entry.until}，${entry.reason}）`).join("、")}` : "")
    + "。";
}

/** One line per background job for Lead: the state, today's calls and failures, and the failure when one is on. */
export function backgroundJobsWords(jobs: readonly BackgroundJobState[]): string {
  if (!jobs.length) return "后台任务：还没有记录。";
  return `后台任务：${jobs.map((job) => {
    const today = `今天 ${job.callsToday} 次，失败 ${job.failuresToday} 次`;
    if (job.state === "ok") return `${job.job} 正常（${today}）`;
    return `${job.job} 从 ${job.since ?? "?"} 起一直失败（${job.reasonClass ?? "?"}：${job.reason ?? ""}`
      + `${job.action ? `；系统已经做了：${job.action}` : ""}；${today}）`;
  }).join("；")}。`;
}

/**
 * Lead may choose only a cheap model for background work (spec D2): the cheap set is computed from the live catalog's
 * prices. The user may choose any model. `what` names the setting in the refusal.
 */
export async function assertLeadCheapModel(env: UiActionEnv, by: ActionAttribution, model: string | null, what: string): Promise<void> {
  if (by.actor !== "lead") return;
  const service = env.services.backgroundModels;
  if (!service) throw new UiActionError("unavailable", `还不知道哪些模型便宜（Lead 的模型目录还没读到），现在不能由你选${what}；用户可以在${BACKGROUND_MODEL_WHERE}选`);
  const cheap = (await service.state()).cheap;
  if (model !== null && cheap.includes(model)) return;
  throw new UiActionError("invalid_input", `${what}你只能选便宜的模型（输入和输出的价格都不超过 Lead 的模型的 1/4）`
    + `${model === null ? "，null（和主会话同一个模型）不便宜" : `，${model} 不是`}。现在便宜的模型：${list(cheap)}。`
    + `用户本人要用别的模型时，请用户在${BACKGROUND_MODEL_WHERE}选`);
}

/** The model must be in Lead's catalog (as the shadow check does). No model service (tests, startup): not checked. */
async function assertCatalogModel(env: UiActionEnv, model: string): Promise<void> {
  const service = env.services.leadModels;
  if (!service) return;
  const models = (await service.catalog()).models.map((option) => option.model);
  if (models.includes(model)) return;
  const near = models.filter((candidate) => candidate.endsWith(`/${model}`) || candidate.endsWith(`/${model.split("/").at(-1)}`));
  throw new UiActionError("invalid_input", `模型目录里没有 ${model}。model 要写 provider/model（list_lead_models 里的）`
    + (near.length ? `，你可能要的是：${near.join("、")}` : ""));
}

export const BACKGROUND_MODEL_TARGET: UiActionTargetKind<BackgroundModelTarget> = {
  type: "background_model",
  label: "后台模型",
  idHint: "lead",
  load: (env, id) => (id === "lead"
    ? { setting: getBackgroundModel(env.db).model, state: env.services.backgroundModels?.snapshot() ?? null }
    : null),
  name: () => "后台模型",
  describe: (target) => ({
    setting: target.setting,
    resolved: target.state?.resolved ?? null,
    cheap: target.state?.cheap ?? [],
    words: `${words(target)}后台工作是你的回合以外的模型调用：判断和整理（外部对话的笔记、摘要、紧急程度）、`
      + "用不上缓存的压缩摘要、Hindsight 自动的摘要模型。设置页选了「问大脑的模型」或者设了 PLC_SMART_MODEL 时，判断和整理先用那个。",
  }),
};

export const BACKGROUND_MODEL_ACTIONS = {
  set: {
    target: "background_model", id: "set", label: "选后台模型", scope: "tickets:create",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false,
    where: BACKGROUND_MODEL_WHERE,
    hint: "选后台工作用的模型。model 写 provider/model，null 是自动（第一个便宜的模型）。"
      + "你只能选便宜的模型（background_model.read 或 list_actions 列出的 cheap：输入和输出的价格都不超过 Lead 的模型的 1/4），"
      + "或者 null。什么时候换：后台模型一直失败、或者有更新的便宜模型时。用户本人可以选任何模型。",
    defaultReason: "选了后台模型",
    available: () => AVAILABLE,
    run: async (run): Promise<BackgroundModelChange> => {
      const model = (run.input as SetBackgroundModelRequest).model;
      const before = run.target.setting;
      if (model !== null) {
        await assertLeadCheapModel(run.env, run.by, model, "后台模型");
        await assertCatalogModel(run.env, model);
      }
      if (model === before) return { changed: false, before, setting: before, state: run.target.state };
      writeBackgroundModel(run.db, { model });
      const service = run.env.services.backgroundModels;
      try {
        service?.changed?.();
      } catch {
        // The setting is saved; a user of the model that does not pick it up now reads it at its next start.
      }
      const state = service ? await service.state().catch(() => null) : null;
      // The settings page reads it again.
      publishGatewayEvent(run.db, { type: "snapshot.required", requiredScope: "tickets:view", payload: { resource: BACKGROUND_MODEL_RESOURCE } });
      return { changed: true, before, setting: getBackgroundModel(run.db).model, state };
    },
    forLead: (_run, result) => {
      const change = result as BackgroundModelChange;
      const target = { setting: change.setting, state: change.state };
      return change.changed
        ? { result: "updated", setting: change.setting, resolved: change.state?.resolved ?? null, next: `已经保存。${words(target)}下一次后台调用起生效。` }
        : { result: "unchanged", setting: change.setting, resolved: change.state?.resolved ?? null };
    },
    detail: (_run, result) => {
      const change = result as BackgroundModelChange;
      return { before: change.before, after: change.setting };
    },
  },
  read: {
    target: "background_model", id: "read", label: "看后台模型", scope: "tickets:view",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false, readOnly: true,
    where: BACKGROUND_MODEL_WHERE,
    hint: "看后台模型：选的（setting）、现在用的（resolved）、便宜的模型（cheap，按自动选的顺序）、失败后暂时跳过的（broken），"
      + "和每个后台任务（后台模型、通道记忆、Hindsight）的状态（jobs：正常还是一直失败、今天的调用和失败次数）。只读。",
    defaultReason: "看后台模型",
    available: () => AVAILABLE,
    run: async (run): Promise<BackgroundModelReadResult> => {
      const service = run.env.services.backgroundModels;
      if (!service) throw new UiActionError("unavailable", "Lead 的会话还没建好，还不知道后台模型");
      const state = await service.state();
      let jobs: BackgroundJobState[] = [];
      try {
        jobs = service.jobs?.() ?? [];
      } catch {
        // The model state is still worth reading without the job health.
      }
      return { ...state, jobs };
    },
    forLead: (_run, result) => {
      const read = result as BackgroundModelReadResult;
      return { ...read, jobs_words: backgroundJobsWords(read.jobs) };
    },
  },
} satisfies Record<string, UiActionDefinition<BackgroundModelTarget, any>>;
