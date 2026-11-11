// 外部工人的操作（protocol 的 worker.ts）和放掉一张被领走的单（ticket.release）的声明。业务规则在 worker-queue/，这里只转调。
// - 工人的操作只有 worker 调用方能做（index.ts 的 runWorkerAction）：凭证要是活着的、带 worker 权限。领单以外的操作还要求
//   这张单是这个工人领着的（ownClaim），不是时 forbidden。
// - ticket.release 是普通的工单操作（页面和 Lead 的 ticket_action），lead_allowed：工人很久没有动静、用户要收回时用。
import {
  attachSession, claimBlocker, claimTicket, completeTicket, handBackTicket, releaseBlocker, releaseTicket, reportOnTicket,
  writeBackBlocker,
} from "../worker-queue/index.js";
import { AVAILABLE, unavailable, type TicketActionDefinition, type WorkerActionCatalog } from "./types.js";

// 领单以外的工人操作：这张单要是这个工人领着的。
export const OWN_CLAIM_WORKER_ACTIONS: ReadonlySet<string> = new Set([
  "worker.attach_session", "worker.report", "worker.complete", "worker.hand_back",
]);

const availability = (blocker: string | null) => (blocker ? unavailable(blocker) : AVAILABLE);

export const WORKER_ACTIONS: WorkerActionCatalog = {
  "worker.claim": {
    id: "worker.claim", label: "领单", scope: "worker",
    hint: "领一张等人领的单（ready、blocked，或者执行中但没有在跑的）。领到以后用 worker.attach_session 挂上会话。",
    available: (item, env) => availability(claimBlocker(env.db, item, { liveItemIds: env.liveItemIds() })),
    run: ({ db, env, item, worker }) => claimTicket(db, {
      itemId: item.id, bindingId: worker.bindingId, workerName: worker.workerName, liveItemIds: env.liveItemIds(),
    }),
  },
  "worker.attach_session": {
    id: "worker.attach_session", label: "挂上会话", scope: "worker",
    hint: "给领着的单挂上这次干活的会话：url（https 或 claude 链接）或者 sessionId。",
    available: () => AVAILABLE,
    run: ({ db, env, item, input, worker }) => attachSession(db, {
      itemId: item.id, bindingId: worker.bindingId, workerName: worker.workerName, now: env.now,
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    }),
  },
  "worker.report": {
    id: "worker.report", label: "写进展", scope: "worker",
    hint: "给领着的单写一条进展笔记；usage 是这段工作用掉的 token 和费用。",
    available: () => AVAILABLE,
    run: ({ db, env, item, input, worker }) => reportOnTicket(db, {
      itemId: item.id, bindingId: worker.bindingId, workerName: worker.workerName, text: input.text, now: env.now,
      ...(input.usage ? { usage: input.usage } : {}),
    }),
  },
  "worker.complete": {
    id: "worker.complete", label: "交付", scope: "worker",
    hint: "做完了：summary 是做了什么，evidence 是凭什么说做完了，artifacts 是 PR、票、文件的链接。工单进待验收。",
    available: (item) => availability(writeBackBlocker(item)),
    run: ({ db, env, item, input, worker }) => completeTicket(db, {
      itemId: item.id, bindingId: worker.bindingId, workerName: worker.workerName, summary: input.summary, evidence: input.evidence,
      now: env.now, ...(input.artifacts ? { artifacts: input.artifacts } : {}),
    }),
  },
  "worker.hand_back": {
    id: "worker.hand_back", label: "交回给用户", scope: "worker",
    hint: "做不下去、要用户拿主意时交回：reason 写清楚要用户做什么。工单记成待用户处理，进受阻。",
    available: (item) => availability(writeBackBlocker(item)),
    run: ({ db, item, input, worker }) => handBackTicket(db, {
      itemId: item.id, bindingId: worker.bindingId, workerName: worker.workerName, reason: input.reason,
    }),
  },
};

export const RELEASE_ACTIONS = {
  "ticket.release": {
    id: "ticket.release", label: "放掉外部工人的单", area: "execution", scope: "tickets:create",
    permission: "lead_allowed", external: false, irreversible: false, ownerAction: null,
    hint: "外部工人（Claude Code 等）领着这张单、很久没有动静，或者用户要收回时用：工人的外部 Run 结束，工单回到待开始。",
    defaultReason: "放掉外部工人领着的单",
    available: (item, env) => availability(releaseBlocker(env.db, item)),
    run: ({ db, item, by, reason }) => releaseTicket(db, { itemId: item.id, by, reason }),
  },
} satisfies { "ticket.release": TicketActionDefinition<"ticket.release"> };
