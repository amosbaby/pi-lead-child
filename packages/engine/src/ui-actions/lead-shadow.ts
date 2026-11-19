// The background shadow's setting (user 2026-11-19, protocol's lead-shadow.ts). One operation: set.
// The page route (POST /v1/actions/lead_shadow/lead/set) and Lead (perform_action) call this definition.
//   - set: lead_allowed, changes rules (it decides who handles background events). Lead can change it in a turn that
//     read no external content; in a turn that an external message woke, or that read external content, the change is
//     refused with a confirm card. The user said both the user and Lead can set the shadow's model.
// The daemon reads the setting each time it is about to hand background events out (apps/daemon, wakeForEvents).
import {
  LEAD_SHADOW_MAX_GATHER_SECONDS, LEAD_SHADOW_RESOURCE, normalizeLeadShadow, type LeadShadowDto, type SetLeadShadowRequest,
} from "@pi-lead-child/protocol";
import { getLeadShadow, publishGatewayEvent, writeLeadShadow } from "@pi-lead-child/store";
import { AVAILABLE } from "../ticket-actions/types.js";
import { UiActionError, type UiActionDefinition, type UiActionEnv, type UiActionTargetKind } from "./types.js";

export const LEAD_SHADOW_WHERE = "设置 → Shadow，或者会话里直接告诉 Lead";

export interface LeadShadowChange {
  changed: boolean;
  before: LeadShadowDto;
  shadow: LeadShadowDto;
}

const MODE_WORDS: Record<LeadShadowDto["mode"], string> = {
  off: "关：每件后台事件都由主会话处理",
  trial: "试运行：shadow 也处理每一批，但它的动作不执行，只记下它会怎么做；主会话照常处理",
  on: "开：后台事件先交给 shadow，它处理不了或不该处理的交给主会话",
};
const SOURCE_WORDS: Record<keyof LeadShadowDto["shares"], string> = {
  channel: "外部消息", ticket: "工单、Run 和 blocker 的事件", other: "其他系统事件",
};

function words(shadow: LeadShadowDto): string {
  const sources = (Object.keys(SOURCE_WORDS) as Array<keyof LeadShadowDto["shares"]>)
    .map((source) => `${SOURCE_WORDS[source]} ${shadow.shares[source]}%`).join("、");
  const gather = shadow.gatherSeconds === 0 ? "不合批" : `缓存热的时候，普通的后台事件先等 ${shadow.gatherSeconds} 秒，合成一批再交出去`;
  return `模式是${MODE_WORDS[shadow.mode]}；交给 shadow 的比例：${sources}；模型：${shadow.model ?? "和主会话相同"}；${gather}`;
}

/**
 * 要的模型必须在 Lead 的模型目录里（user 2026-11-19：写成 codex/gpt-6-luna 少了 provider，shadow 就悄悄用了主会话的模型）。
 * 不在时拒绝，并给出名字结尾相同的模型。没有模型服务时（Lead 的会话还没建好，或测试）不查。
 */
async function checkShadowModel(env: UiActionEnv, model: string): Promise<void> {
  const service = env.services.leadModels;
  if (!service) return;
  const models = (await service.catalog()).models.map((option) => option.model);
  if (models.includes(model)) return;
  const near = models.filter((candidate) => candidate.endsWith(`/${model}`) || candidate.endsWith(`/${model.split("/").at(-1)}`));
  throw new UiActionError("invalid_input", `模型目录里没有 ${model}。model 要写 provider/model（list_lead_models 里的）`
    + (near.length ? `，你可能要的是：${near.join("、")}` : ""));
}

export const LEAD_SHADOW_TARGET: UiActionTargetKind<LeadShadowDto> = {
  type: "lead_shadow",
  label: "shadow",
  idHint: "lead",
  load: (env, id) => (id === "lead" ? getLeadShadow(env.db) : null),
  name: () => "shadow",
  describe: (state) => ({
    mode: state.mode, model: state.model, shares: state.shares, gatherSeconds: state.gatherSeconds,
    words: `现在${words(state)}。用户本人的话、要用户审批或确认的事、用户设的跟进和 interrupt 级的事件永远由主会话处理。`,
  }),
};

export const LEAD_SHADOW_ACTIONS = {
  set: {
    target: "lead_shadow", id: "set", label: "调 shadow", scope: "tickets:create",
    permission: "lead_allowed", changesRules: true, external: false, irreversible: false,
    where: LEAD_SHADOW_WHERE,
    hint: "shadow 是不带主会话历史的小会话：它用你的系统提示词、常设指令、核心记忆和权限规则处理后台事件，每一批开一个新会话。"
      + "主会话每次被叫醒都要读一遍整个上下文（二三十万 token），shadow 每次只读几万。"
      + "只写要改的字段：mode 是 off（关）、trial（试运行：它也处理，但动作不执行，只记下来，用来比对）或 on（开）；"
      + "model 是 provider/model（list_lead_models 里的），null 是和主会话用同一个模型；"
      + "shares 是每个来源交给它的比例（0 到 100 的整数，只写要改的来源）：channel（外部消息，所有外部通道）、ticket（工单、Run、blocker）、other（其他系统事件）。"
      + "按对象分（一个对话、一张工单），同一个对话固定走同一边；调大比例只会把更多对象从主会话移给 shadow；"
      + `gatherSeconds 是 0 到 ${LEAD_SHADOW_MAX_GATHER_SECONDS} 的整数：缓存热的时候普通后台事件先等多少秒、合成一批（0 是不等）。`
      + "用户说了用哪个模型、开不开就照用户说的。model 不在模型目录里时拒绝，并给出名字相近的。",
    defaultReason: "调了 shadow",
    available: () => AVAILABLE,
    run: async (run): Promise<LeadShadowChange> => {
      const input = run.input as SetLeadShadowRequest;
      if (typeof input.model === "string" && input.model !== run.target.model) await checkShadowModel(run.env, input.model);
      const before = run.target;
      const next = normalizeLeadShadow({ ...before, ...input, shares: { ...before.shares, ...input.shares } });
      if (JSON.stringify(next) === JSON.stringify(before)) return { changed: false, before, shadow: before };
      writeLeadShadow(run.db, next);
      // The settings page reads it again (GET /v1/lead/shadow).
      publishGatewayEvent(run.db, { type: "snapshot.required", requiredScope: "tickets:view", payload: { resource: LEAD_SHADOW_RESOURCE } });
      return { changed: true, before, shadow: getLeadShadow(run.db) };
    },
    forLead: (_run, result) => {
      const change = result as LeadShadowChange;
      const { mode, model, shares, gatherSeconds } = change.shadow;
      return change.changed
        ? { result: "updated", mode, model, shares, gatherSeconds, next: `已经保存：${words(change.shadow)}。下一批后台事件起生效。用户在场时用一句话告诉他改了什么。` }
        : { result: "unchanged", mode, model, shares, gatherSeconds };
    },
    detail: (_run, result) => {
      const change = result as LeadShadowChange;
      return { before: change.before, after: change.shadow };
    },
  },
} satisfies Record<string, UiActionDefinition<LeadShadowDto, any>>;
