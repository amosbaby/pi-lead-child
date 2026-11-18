// Lead's context (2026-11-18): compact it on request, optionally with another model (protocol's lead-context.ts).
// One operation: compact. The page route (POST /v1/lead/compact) and Lead (compact_lead_context, perform_action) call this
// definition, and the daemon's LeadContextService does the work.
//   - lead_allowed, not a rule change, not external, not irreversible: the session file keeps the full history.
//   - Lead's model does not change. The summary uses the given model with its own credentials.
//   - The hold rule (lead's manualCompactionHold) needs to know if the user asked: the page, or Lead in the user's own turn.
// Background: on 2026-11-18 the user asked Lead to compress its context with another model. Lead had no tool for it. It
// wrote a hand-off document, switched its own model twice, and said the context was compressed when it was not.
import type { CompactLeadContextRequest, CompactLeadContextResult } from "@pi-lead-child/protocol";
import { AVAILABLE } from "../ticket-actions/types.js";
import { leadUserTurnOf } from "./authority.js";
import { UiActionError, type LeadContextService, type UiActionDefinition, type UiActionEnv, type UiActionTargetKind } from "./types.js";

export const LEAD_CONTEXT_WHERE = "会话输入框里输入 /compact（可以跟模型 provider/id 和对摘要的要求）";

export interface LeadContextTarget {
  model: string;
  tokens: number | null;
}

function leadContext(env: UiActionEnv): LeadContextService {
  const service = env.services.leadContext;
  if (!service) throw new UiActionError("unavailable", "Lead 的会话还没有建好，现在不能压缩上下文");
  return service;
}

export const LEAD_CONTEXT_TARGET: UiActionTargetKind<LeadContextTarget> = {
  type: "lead_context",
  label: "Lead 的上下文",
  idHint: "lead",
  load: (env, id) => (id === "lead" ? leadContext(env).state() : null),
  name: () => "Lead 的上下文",
  describe: (target) => ({ model: target.model, tokens: target.tokens }),
};

function nextFor(result: CompactLeadContextResult): string {
  switch (result.applied) {
    case "now":
      return "摘要已经开始写，写好以后马上接上。结果（压缩前后的 token 数和用的模型）会作为一条系统通知出现在会话里，不用你再转述。"
        + "不要再写交接文档，也不要为了压缩去换自己的模型。";
    case "after_turn":
      return "你这一轮结束以后马上开始压缩，下一轮之前接上。结果会作为一条系统通知出现在会话里。"
        + "这一轮照常答完；不要写交接文档，也不要为了压缩去换自己的模型。";
    case "nothing_to_compact":
      return "上一次压缩以后没有新的对话，没有要压缩的。如实告诉用户。";
    case "held":
      return "没有压缩：你自己的模型现在在暂停中。可以让用户点名另一个模型（model 写 list_lead_models 列出的 provider/id）再压缩，"
        + "或者等用户本人发话。";
    case "model_ambiguous":
      return `没有压缩：「${result.model}」对得上好几个模型（candidates）。按用户的原话从里面选一个，用完整的 provider/id 再调；`
        + "看不出用户指的是哪一个时问用户，不要自己猜，也不要退回用你自己的模型。";
    case "model_unknown":
      return `没有压缩：「${result.model}」对不上任何模型。candidates 是最接近的几个；先用 list_lead_models 核对，`
        + "用完整的 provider/id 再调。对不上时问用户，不要退回用你自己的模型。";
  }
}

export const LEAD_CONTEXT_ACTIONS = {
  compact: {
    target: "lead_context", id: "compact", label: "压缩 Lead 的上下文", scope: "chat",
    // Compacting does not change any rule, sends nothing outside, and the session file keeps the full history.
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false,
    where: LEAD_CONTEXT_WHERE,
    hint: "用户要你压缩、精简、整理你自己的上下文时用（target_id 是 lead），例如「压缩一下上下文」「用便宜的模型压缩上下文」。"
      + "model 写 list_lead_models 列出的 provider/id，不带推理强度，也可以写用户的原话（例如 gpt 6 luna），系统按模型目录对上唯一的一个；"
      + "对上好几个或者一个都对不上时不压缩，结果里列出候选。不给时用你现在的模型。它只用来写这一次的摘要，你的模型不变。"
      + "instructions 是对摘要的额外要求（可选）。你空闲时马上开始；你正在回答时（包括在这一轮里调它）这一轮结束后开始。"
      + "不要用写交接文档或者换模型来代替它。",
    defaultReason: "在输入框里要求压缩 Lead 的上下文",
    available: () => AVAILABLE,
    run: (run) => {
      const byUser = run.by.actor === "user" || leadUserTurnOf(run.db, run.by, run.turnId, "压缩 Lead 的上下文", "chat") !== null;
      return leadContext(run.env).compact(run.input as CompactLeadContextRequest, { byUser });
    },
    forLead: (_run, result) => {
      const compacted = result as CompactLeadContextResult;
      return { ...compacted, next: nextFor(compacted) };
    },
    detail: (run, result) => {
      const compacted = result as CompactLeadContextResult;
      const input = run.input as CompactLeadContextRequest;
      return {
        model: compacted.model, requestedModel: input.model ?? null, applied: compacted.applied, tokensBefore: compacted.tokensBefore,
        existing: compacted.existing, instructions: input.instructions ? true : false,
      };
    },
  },
} satisfies Record<string, UiActionDefinition<LeadContextTarget, CompactLeadContextRequest>>;
