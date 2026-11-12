// 「找不到」记录（protocol 的 hub-metrics.ts，计划 Task 14）的操作：record。工单列表页的「找不到」按钮（POST /v1/actions/ticket_miss/hub/record）、
// plc miss 和 Lead（perform_action）调同一个定义。
//   - record：lead_allowed，不改规则：只往 ticket_misses 写一行，不改任何设置、不对外。所以外部消息叫醒的一轮里 Lead 也能记。
//   - 原话去掉首尾空白，空的、超过 500 个字符的被拒（invalid_input）。
// 这些记录和工单的来源、会话覆盖率一起是 S1 成不成功的数（store 的 hubMetrics）。
import { TICKET_MISS_TEXT_MAX, normalizeMissText, type RecordTicketMissRequest } from "@pi-lead-child/protocol";
import { missesSince, recordMiss } from "@pi-lead-child/store";
import { AVAILABLE } from "../ticket-actions/types.js";
import { UiActionError, type UiActionDefinition, type UiActionTargetKind } from "./types.js";

export const TICKET_MISS_WHERE = "工单列表页的「找不到」，或者 plc miss <原话>";

export const TICKET_MISS_TARGET: UiActionTargetKind<{ misses: number }> = {
  type: "ticket_miss",
  label: "「找不到」记录",
  idHint: "hub",
  load: (env, id) => (id === "hub" ? { misses: missesSince(env.db, new Date(0)) } : null),
  name: () => "「找不到」记录",
  describe: (state) => ({ misses: state.misses, words: `到现在记了 ${state.misses} 次「找不到」。` }),
};

export const TICKET_MISS_ACTIONS = {
  record: {
    target: "ticket_miss", id: "record", label: "记一次找不到", scope: "tickets:create",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false,
    where: TICKET_MISS_WHERE,
    hint: `用户说「我找不到那张单」「列表里没有……」「没找到……」这类话时记一次，text 写他的原话（最多 ${TICKET_MISS_TEXT_MAX} 个字符）。`
      + "这只是一行记录，用来看工单列表和来源链接有没有帮到他；不要替他去找，也不要因为记了它就当问题已经解决。",
    defaultReason: "用户说没找到",
    available: () => AVAILABLE,
    run: (run): { text: string } => {
      const text = normalizeMissText((run.input as RecordTicketMissRequest).text);
      if (text === null) {
        throw new UiActionError("invalid_input", `ticket_miss.record：text 不能是空的，也不能超过 ${TICKET_MISS_TEXT_MAX} 个字符（去掉首尾空白以后算）`);
      }
      recordMiss(run.db, text, run.env.now);
      return { text };
    },
    forLead: () => ({ result: "recorded", next: "已经记下。用一句话告诉用户记了；不要说问题解决了。" }),
    detail: (_run, result) => ({ length: (result as { text: string }).text.length }),
  },
} satisfies Record<string, UiActionDefinition<{ misses: number }, RecordTicketMissRequest>>;
