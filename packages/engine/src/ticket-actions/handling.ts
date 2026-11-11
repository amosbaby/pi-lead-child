// 改工单的处理方式（.scratch/external-worker-hub/spec.md P1-3、§「切换和改 handling 都是 user_direct 的正式操作」）：
// 这张单可以自动处理（auto），还是要用户拿主意（needs_user）。Lead 的判断写在同样的列上（store 的 setHandling）；用户改了以后
// 判断换成用户的，理由是用户写的原因（没写时是缺省的说法），复杂度不动。
// - 权限是 user_direct：决定哪些单交给自动处理是给 Lead 和工人放权（AGENTS.md「UI Actions」）。Lead 调用总是得到结构化拒绝，
//   拒绝里写明去哪里点。
// - 账本：一条 decision（handling_set），写明从什么改成什么、谁改的、为什么。
import type { TicketHandling } from "@pi-lead-child/store";
import { addActivity, setHandling, type Db } from "@pi-lead-child/store";
import { AVAILABLE, unavailable, type TicketActionDefinition } from "./types.js";

export const HANDLING_SET_DECISION = "handling_set";

function judgmentOf(db: Db, itemId: number): { handling: TicketHandling | null; complexity: "simple" | "medium" | "complex" | null } {
  return db.prepare("SELECT handling, complexity FROM items WHERE id=?").get(itemId) as {
    handling: TicketHandling | null; complexity: "simple" | "medium" | "complex" | null;
  };
}

export const HANDLING_ACTIONS = {
  "ticket.set_handling": {
    id: "ticket.set_handling", label: "改处理方式", area: "ticket", scope: "tickets:create",
    permission: "user_direct", external: false, irreversible: false, ownerAction: null,
    where: "工单详情的处理方式",
    hint: "把工单改成可以自动处理（auto）或者要用户拿主意（needs_user）。只有用户本人能改：请用户在工单详情里改。",
    defaultReason: "用户改了处理方式",
    available(item) {
      if (item.kind !== "task") return unavailable("提醒没有处理方式。");
      if (item.stage === "done" || item.stage === "cancelled") return unavailable("工单已经结束，不用改处理方式。");
      return AVAILABLE;
    },
    run: ({ db, item, input, reason, by }) => db.transaction(() => {
      const before = judgmentOf(db, item.id);
      setHandling(db, item.id, { handling: input.handling, reason, ...(before.complexity ? { complexity: before.complexity } : {}) });
      addActivity(db, {
        itemId: item.id, actor: by.actor, kind: "decision",
        payload: { decision: HANDLING_SET_DECISION, from: before.handling, to: input.handling, reason, actor: by.actor },
      });
      return { ticketId: item.id, handling: input.handling, previous: before.handling };
    })(),
  },
} satisfies { "ticket.set_handling": TicketActionDefinition<"ticket.set_handling"> };
