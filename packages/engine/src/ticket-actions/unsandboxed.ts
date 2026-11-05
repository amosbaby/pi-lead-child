// 「沙箱外执行」授权（工单 #62，#58 的方案 B）：用户打开以后，这张工单之后的执行者 Run 不进沙箱。
// - 权限是 user_direct（AGENTS.md「UI Actions」：给 agent 放权是用户的事）：用户在 App 工单详情或 plc 命令行里开关。
//   Lead 只能发起，不能自己确认（工单 #71，用户 2026-11-05）：在用户本人正在说话的一轮（App、plc、用户发给自己的 Slack 私信）里
//   调用时不直接做，系统存下这一次、Lead 拿到确认卡（authority.ts 的 leadMayRequest，和兜底授权卡同一套）；用户点「确认这一次」
//   才执行这一次，点「不改」作废。外部消息叫醒的一轮等别的轮次里，Lead 调用照旧得到结构化拒绝（user_direct）。
//   确认后执行的那一次记成用户做的，活动和事件里另记 requestedBy: "lead" 和确认卡号。
// - 只对用户本人发起的工单生效：外部通道派出的工单（agent_task，purpose=lookup），和 Lead 在外部消息叫醒的一轮里建的工单
//   （建单时记了 ticket_external_origin），以及它们下面的子工单，都不能打开。理由：外部的话会进执行者的提示词，
//   不进沙箱等于让外部的人在用户的 Mac 上跑命令。
// - 只管执行者的执行 Run（role=executor、purpose=execution）。核查员、合并（integration）、工单对话等别的 Run 照旧进沙箱。
//   哪一个 Run 在沙箱外跑，在 Run 第一次启动时定下，记在 Run 的 metadata 和活动里（children/manager.ts）：
//   正在跑的 Run（包括之后暂停再继续的）不受开关影响，从下一个 Run 生效。
// - 不进沙箱时的底线（读私钥和凭证、直接写 plc.db 和 config.json）由各个 runtime 尽量挡，挡不住的写在 core 的
//   sandbox-policy.ts 的 UNSANDBOXED_FLOOR_GAPS 里。
import type { Item, RunPurpose } from "@pi-lead-child/core";
import { addActivity, getItem, getRun, setItemUnsandboxedExecution, updateRun, type Db } from "@pi-lead-child/store";
import { parseMetadata } from "../pipeline/run-registration.js";
import { behalfCursor, behalfFields } from "./attribution.js";
import { AVAILABLE, TicketActionError, unavailable, type TicketActionDefinition } from "./types.js";

// Lead 在外部消息叫醒（或读过外部内容）的一轮里建的工单：lead 的 create_task 建单时记这条决定。
export const EXTERNAL_ORIGIN_DECISION = "ticket_external_origin";

export const EXTERNAL_TICKET_REFUSAL = "这张工单是外部通道（别人在 Slack 这类通道里的消息）派出的，"
  + "外部的话会进执行者的提示词，不能让它在沙箱外执行。要在沙箱外做，请你自己建一张工单。";

function hasExternalOriginDecision(db: Db, itemId: number): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM activities WHERE item_id=? AND kind='decision' AND json_valid(payload)
       AND json_extract(payload, '$.decision')=? LIMIT 1`,
  ).get(itemId, EXTERNAL_ORIGIN_DECISION));
}

/** 这张工单是不是外部通道派出的（它自己或它的根工单）。见文件头。 */
export function isExternalOriginTicket(db: Db, item: Item): boolean {
  const ids = [item.id, ...(item.root_item_id && item.root_item_id !== item.id ? [item.root_item_id] : [])];
  return ids.some((id) => {
    const target = id === item.id ? item : getItem(db, id);
    return target?.purpose === "lookup" || hasExternalOriginDecision(db, id);
  });
}

/** 一个新 Run 要不要在沙箱外跑：只看执行者的执行 Run，授权打开，并且不是外部通道的工单。 */
export function runsUnsandboxed(
  db: Db, item: Item, run: { role: "executor" | "reviewer"; purpose: RunPurpose },
): boolean {
  if (run.role !== "executor" || run.purpose !== "execution") return false;
  if (item.unsandboxed_execution !== 1) return false;
  return !isExternalOriginTicket(db, item);
}

// Run 的 metadata 里记这次在不在沙箱里跑的键，和派发时记的那条决定。
export const RUN_UNSANDBOXED_KEY = "unsandboxed";
export const RUN_UNSANDBOXED_DECISION = "run_unsandboxed";

/**
 * 这个 Run 在不在沙箱外跑（children/manager.ts 启动 runtime 之前调用）。第一次启动时按工单现在的授权定下，写进 Run 的
 * metadata；在沙箱外跑时再记一条活动（decision: run_unsandboxed）。同一个 Run 再启动（继续、换会话重试、接管）读回
 * 记下的值：开关只影响之后新建的 Run。
 */
export function decideRunSandbox(
  db: Db, runId: number, run: { role: "executor" | "reviewer"; purpose: RunPurpose },
): boolean {
  const current = getRun(db, runId);
  if (!current) throw new Error(`run #${runId} not found`);
  const metadata = parseMetadata(current.metadata);
  if (typeof metadata[RUN_UNSANDBOXED_KEY] === "boolean") return metadata[RUN_UNSANDBOXED_KEY];
  const item = getItem(db, current.item_id);
  const unsandboxed = item ? runsUnsandboxed(db, item, run) : false;
  db.transaction(() => {
    updateRun(db, runId, { metadata: { ...metadata, [RUN_UNSANDBOXED_KEY]: unsandboxed } });
    if (unsandboxed) {
      addActivity(db, {
        itemId: current.item_id, runId, actor: "system", kind: "decision",
        payload: {
          decision: RUN_UNSANDBOXED_DECISION, runtime: current.runtime, role: run.role, purpose: run.purpose,
          reason: "用户给这张工单打开了「沙箱外执行」：这个执行 Run 不进沙箱",
        },
      });
    }
  })();
  return unsandboxed;
}

export const UNSANDBOXED_ACTIONS = {
  set_unsandboxed: {
    id: "set_unsandboxed", label: "沙箱外执行", area: "execution", scope: "tickets:create",
    permission: "user_direct", external: false, irreversible: false, ownerAction: null,
    where: "工单详情「工单信息」的「沙箱外执行」，或者 plc sandbox <工单号> on|off",
    hint: "打开以后这张工单之后的执行者不进沙箱（核查员照旧在沙箱里）。input：{enabled: true} 打开，{enabled: false} 关闭。"
      + "用户在这一轮里要你开关时，你调用会得到确认卡（user_action），用 render_ui 发给用户，他点了才生效。"
      + "别的轮次你调用会被拒，请用户在工单详情里点，或者在终端里运行 plc sandbox <工单号> on。",
    defaultReason: "用户改了沙箱外执行的授权",
    leadRequest: (item, input) => (input.enabled
      ? {
        label: `打开工单 #${item.id} 的「沙箱外执行」`,
        why: `打开以后，工单 #${item.id}（${item.title}）之后的执行者在沙箱外跑：用你自己的权限在你的 Mac 上执行命令、改文件，`
          + "系统尽量挡住读私钥和凭证、直接写 plc.db 和 config.json。正在跑的执行不受影响，核查员照旧在沙箱里。只有你能决定。",
      }
      : {
        label: `关闭工单 #${item.id} 的「沙箱外执行」`,
        why: `关闭以后，工单 #${item.id}（${item.title}）之后的执行者照旧在沙箱里跑。正在跑的执行不受影响。只有你能决定。`,
      }),
    available(item, env) {
      if (item.kind !== "task") return unavailable("提醒没有执行者，不用这个授权。");
      if (isExternalOriginTicket(env.db, item)) return unavailable(EXTERNAL_TICKET_REFUSAL);
      return AVAILABLE;
    },
    run: ({ db, item, input, by, reason, confirmation }) => {
      // available 已经查过；这里再查一次：打开的那一刻要确定不是外部通道的工单。
      if (input.enabled && isExternalOriginTicket(db, item)) throw new TicketActionError("forbidden", EXTERNAL_TICKET_REFUSAL);
      const changed = setItemUnsandboxedExecution(db, item.id, input.enabled, {
        actor: by.actor, reason, extra: behalfFields(by), ...behalfCursor(by),
        // Lead 发起、用户在确认卡上确认的这一次。
        ...(confirmation ? { requestedBy: "lead" as const, confirmation } : {}),
      });
      return { enabled: input.enabled, changed };
    },
  },
} satisfies { set_unsandboxed: TicketActionDefinition<"set_unsandboxed"> };
