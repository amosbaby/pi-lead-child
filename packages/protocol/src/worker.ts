// 外部工人（Claude Code，以后 Codex）领单和回写的线上契约（.scratch/external-worker-hub/spec.md P1-5）。
// 工人凭单独配对、带 worker 权限的凭证调用这些操作（scopes.ts；worker 永远不在缺省授予的清单里）。
// 实现在 engine 的 worker-queue/（业务规则）和 ticket-actions/worker.ts（声明和转调），入口是 runTicketAction，caller 是 worker。
// 这些操作只有工人能做：页面和 Lead 都不调它们（Lead 的 ticket_action 工具不列它们）。用户和 Lead 放掉一张被领走的单
// 用工单操作 ticket.release（ticket-actions.ts）。
// 领取 = 建一个 runtime=external 的 Run（不起进程）；工单 ready/blocked → active 由 system 在建 Run 时推。
// 这个文件不 import index.ts（index.ts 从这里 re-export，反过来会循环）。
import { Type, type Static, type TProperties, type TSchema } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const WORKER_SCOPE = "worker" as const;

// 会话链接只认这两种 scheme：网页按白名单渲染链接，javascript:、file: 这类一律不收。
export const WORKER_SESSION_URL_SCHEMES = ["https:", "claude:"] as const;

export const WORKER_ACTION_IDS = [
  "worker.claim", "worker.attach_session", "worker.report", "worker.complete", "worker.hand_back",
] as const;
export type WorkerActionId = typeof WORKER_ACTION_IDS[number];

export function isWorkerActionId(value: string): value is WorkerActionId {
  return (WORKER_ACTION_IDS as readonly string[]).includes(value);
}

// 工人报的用量（记在它的外部 Run 上，和执行者的用量同一本账）。inputTokens 含缓存读写（ADR 0001 的口径）。
export const WorkerUsageSchema = StrictObject({
  inputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  outputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  cacheReadTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  cacheWriteTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  costUsd: Type.Optional(Type.Number({ minimum: 0 })),
});
export type WorkerUsage = Static<typeof WorkerUsageSchema>;

// 工单编号不在输入里：它是 runTicketAction 的 itemId。
export const WORKER_ACTION_INPUT_SCHEMAS = {
  // 领一张 ready 或 blocked 的单（执行中但没有活着的 Run 的单也行，例如暂停的 Run 留下的）。领取方式 manual。
  "worker.claim": StrictObject({}),
  // 挂上这次干活的会话：链接（https 或 claude）或者会话 id，至少给一个。
  "worker.attach_session": StrictObject({
    url: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" })),
  }),
  // 进展笔记（工单活动 worker_report）；带用量时记到外部 Run 上。
  "worker.report": StrictObject({
    text: Type.String({ minLength: 1, maxLength: 20_000 }),
    usage: Type.Optional(WorkerUsageSchema),
  }),
  // 做完了：工单进 review，外部 Run 结束。artifacts 是交付物的链接或引用（PR、票、文件）。
  "worker.complete": StrictObject({
    summary: Type.String({ minLength: 1, maxLength: 2000 }),
    evidence: Type.String({ minLength: 1, maxLength: 20_000 }),
    artifacts: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 20 })),
  }),
  // 交回给用户：工单记成 needs_user，进 blocked，外部 Run 结束。
  "worker.hand_back": StrictObject({
    reason: Type.String({ minLength: 1, maxLength: 2000 }),
  }),
} as const satisfies Record<WorkerActionId, TSchema>;

export type WorkerActionInputs = { [K in WorkerActionId]: Static<typeof WORKER_ACTION_INPUT_SCHEMAS[K]> };

// 外部 Run 的 metadata（runs.metadata）：工人的 binding id（不是名字）、领取方式、会话。
export const WORKER_CLAIM_MODES = ["manual", "auto"] as const;
export type WorkerClaimMode = typeof WORKER_CLAIM_MODES[number];

export interface WorkerSession {
  url: string | null;
  sessionId: string | null;
  attachedAt: string;
}

// list_tickets 的筛选（ruling R15）：
//   mine       我领着的（活着的外部 Run 是我的）；
//   needs_me   要用户拿主意的：handling=needs_user（Lead 的判断，或者工人交回的），没有活着的外部 Run，没结束（done、cancelled 不算）；
//   claimable  现在能领的：ready、blocked，和没有在跑的 active（例如暂停的 Run 留下的），没有活着的 Run；
//   active     执行中的；
//   recent     最近交付或完成的（review、done）。
export const WORKER_TICKET_FILTERS = ["mine", "needs_me", "claimable", "active", "recent"] as const;
export type WorkerTicketFilter = typeof WORKER_TICKET_FILTERS[number];
