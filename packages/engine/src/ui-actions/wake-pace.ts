// How soon Lead wakes for ordinary system events when its prompt cache is cold (user 2026-11-16, protocol's wake-pace.ts).
// One operation: set. The page route (POST /v1/actions/wake_pace/lead/set) and Lead (perform_action) call this definition.
//   - set: lead_allowed, changes rules. Lead can change it in a turn that read no external content; in a turn that an
//     external message woke, or that read external content, the change is refused with a confirm card.
//   - The hard budget for automatic calls (lead's auto-call-budget.ts) is a different thing: only the user changes it,
//     in config.json. Lead paces its own wakes inside that budget; it cannot raise the budget.
// The daemon reads the setting each time it is about to wake Lead for events (apps/daemon, wakeForEvents).
import { WAKE_PACE_MAX_MINUTES, type SetWakePaceRequest, type WakePaceDto } from "@pi-lead-child/protocol";
import { getWakePace, writeWakePace } from "@pi-lead-child/store";
import { AVAILABLE } from "../ticket-actions/types.js";
import type { UiActionDefinition, UiActionTargetKind } from "./types.js";

// 现在没有设置页的入口（2026-11-16）：用户在会话里对 Lead 说。
export const WAKE_PACE_WHERE = "会话里直接告诉 Lead（设置页还没有这一项）";

export interface WakePaceChange {
  changed: boolean;
  before: WakePaceDto;
  wakePace: WakePaceDto;
}

function words(pace: WakePaceDto): string {
  return pace.coldBatchMinutes === 0
    ? "不攒：每来一件普通的系统事件就马上叫醒你"
    : `缓存冷了以后攒 ${pace.coldBatchMinutes} 分钟：从第一件在等的事算起，到点把这段时间来的事一次交给你；缓存还热时照旧马上叫醒你`;
}

export const WAKE_PACE_TARGET: UiActionTargetKind<WakePaceDto> = {
  type: "wake_pace",
  label: "普通系统事件多快叫醒 Lead",
  idHint: "lead",
  load: (env, id) => (id === "lead" ? getWakePace(env.db) : null),
  name: () => "普通系统事件多快叫醒 Lead",
  describe: (state) => ({
    coldBatchMinutes: state.coldBatchMinutes,
    words: `现在是${words(state)}。用户本人的话、外部通道里在等的人、到点的提醒、用户设的跟进和 interrupt 级的事件从不等。`,
  }),
};

export const WAKE_PACE_ACTIONS = {
  set: {
    target: "wake_pace", id: "set", label: "调普通系统事件多快叫醒 Lead", scope: "tickets:create",
    permission: "lead_allowed", changesRules: true, external: false, irreversible: false,
    where: WAKE_PACE_WHERE,
    hint: `coldBatchMinutes 写 0 到 ${WAKE_PACE_MAX_MINUTES} 的整数：普通系统事件在你的缓存冷了以后攒多少分钟再一起叫醒你，0 是不攒（缺省）。`
      + "每次叫醒你都要把整个上下文读一遍：服务商的缓存还在时（离你上一次模型调用不到几分钟）很便宜，缓存过期以后要按全价重新读一遍。"
      + "所以它只管缓存冷了以后的叫醒：数字越大，冷启动越少、越省，普通的事也越晚到你手里。"
      + "从不等的事：用户本人的话、外部通道里在等的人、到点的提醒、用户设的跟进、interrupt 级的事件。"
      + "什么时候调：当前局面「关于你自己」一节写着最近一小时和一天里系统自己调了几次模型、没命中缓存的输入有多少。"
      + "事情不急、冷启动又多时调大（例如 30 或 60）；有工单在等你处理、或者用户要你盯着一件事时调小或者设回 0。"
      + "用户说了要多快就照用户说的。它不改自动调用的硬上限：那个只有用户能改。",
    defaultReason: "调了普通系统事件多快叫醒 Lead",
    available: () => AVAILABLE,
    run: (run): WakePaceChange => {
      const { coldBatchMinutes } = run.input as SetWakePaceRequest;
      const before = run.target;
      if (before.coldBatchMinutes === coldBatchMinutes) return { changed: false, before, wakePace: before };
      writeWakePace(run.db, { coldBatchMinutes });
      return { changed: true, before, wakePace: getWakePace(run.db) };
    },
    forLead: (_run, result) => {
      const change = result as WakePaceChange;
      const { coldBatchMinutes } = change.wakePace;
      return change.changed
        ? { result: "updated", coldBatchMinutes, next: `已经保存：${words(change.wakePace)}。下一件普通的系统事件起生效。用户在场时用一句话告诉他改了什么、为什么。` }
        : { result: "unchanged", coldBatchMinutes };
    },
    detail: (_run, result) => {
      const change = result as WakePaceChange;
      return { before: change.before.coldBatchMinutes, after: change.wakePace.coldBatchMinutes };
    },
  },
} satisfies Record<string, UiActionDefinition<WakePaceDto, any>>;
