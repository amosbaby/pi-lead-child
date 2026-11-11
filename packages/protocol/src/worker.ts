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

// 从工人自己的会话建单（spec P1-5 的 track）：建单、记来源、领取、挂会话，一次调用。没有工单编号，所以不在 WORKER_ACTION_IDS 里：
// 入口是 engine 的 runWorkerTrack（caller 是 worker），不是 runTicketAction。
//   sourceUrl 只收 https：按链接认来源（Slack、Jira、Notion），认不出时记成 manual；同一个 Jira 单、Notion 页已经是一张工单的来源时
//   不再建单，领那张单。sessionUrl、sessionId 同 worker.attach_session，都不给时不挂会话。
export const WORKER_TRACK_ACTION_ID = "worker.track" as const;
export const WorkerTrackInputSchema = StrictObject({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  sourceUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  note: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
  sessionUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" })),
});
export type WorkerTrackInput = Static<typeof WorkerTrackInputSchema>;

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

// 工人的 HTTP MCP（gateway 的 worker-mcp.ts，路径 /v1/worker/mcp）给 agent 的工具。参数按下面的 schema 先校验，再交给操作层
// （操作层按 WORKER_ACTION_INPUT_SCHEMAS、WorkerTrackInputSchema 再查一次）。带工单的工具多一个 ticketId，别的字段就是操作的输入。
export const WORKER_MCP_TOOL_NAMES = [
  "list_tickets", "claim", "track", "get_ticket", "report", "attach_session", "complete", "hand_back",
] as const;
export type WorkerMcpToolName = typeof WORKER_MCP_TOOL_NAMES[number];

const TicketIdSchema = Type.Integer({ minimum: 1 });
const withTicketId = <T extends TProperties>(properties: T) => StrictObject({ ticketId: TicketIdSchema, ...properties });

export const WORKER_MCP_TOOL_INPUT_SCHEMAS = {
  list_tickets: StrictObject({ filter: Type.Union(WORKER_TICKET_FILTERS.map((filter) => Type.Literal(filter))) }),
  claim: withTicketId(WORKER_ACTION_INPUT_SCHEMAS["worker.claim"].properties),
  track: WorkerTrackInputSchema,
  get_ticket: withTicketId({}),
  report: withTicketId(WORKER_ACTION_INPUT_SCHEMAS["worker.report"].properties),
  attach_session: withTicketId(WORKER_ACTION_INPUT_SCHEMAS["worker.attach_session"].properties),
  complete: withTicketId(WORKER_ACTION_INPUT_SCHEMAS["worker.complete"].properties),
  hand_back: withTicketId(WORKER_ACTION_INPUT_SCHEMAS["worker.hand_back"].properties),
} as const satisfies Record<WorkerMcpToolName, TSchema>;

export function isWorkerMcpToolName(value: unknown): value is WorkerMcpToolName {
  return typeof value === "string" && (WORKER_MCP_TOOL_NAMES as readonly string[]).includes(value);
}

// 网页看台账的两个只读接口（spec P1-2、P1-7；gateway 的 ticket-links-routes.ts）。不进 TicketSummary：TicketSummary 是严格校验的，
// 加字段会让旧页面整张列表加载失败。
//   GET /v1/tickets/meta?ids=1,2,3  列表上的来源、处理方式、复杂度、领取人。一次最多 TICKET_META_MAX_IDS 张。
//   GET /v1/tickets/:id/links       详情里的来源链接、会话链接、判断理由。
export const TICKET_META_MAX_IDS = 200;

const NullableString = Type.Union([Type.String(), Type.Null()]);

export const TicketMetaSchema = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  handling: Type.Union([Type.Literal("auto"), Type.Literal("needs_user"), Type.Null()]),
  complexity: Type.Union([Type.Literal("simple"), Type.Literal("medium"), Type.Literal("complex"), Type.Null()]),
  // 现在领着它的工人（配对时的名字）。没人领着时 null。
  claimedBy: NullableString,
  claimMode: Type.Union([Type.Literal("manual"), Type.Literal("auto"), Type.Null()]),
  // 领着它的工人多少个整小时没有动静（领取、挂会话、进展笔记里最晚的一次以后）。没人领着时 null。
  idleHours: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  // 第一条来源的标签（ticketSourceLabel）。没有来源时 null。
  sourceLabel: NullableString,
});
export type TicketMeta = Static<typeof TicketMetaSchema>;
export const TicketMetaListSchema = Type.Array(TicketMetaSchema);

export const TICKET_SOURCE_KIND_IDS = ["slack", "jira", "notion", "manual"] as const;
export type TicketSourceKindId = typeof TICKET_SOURCE_KIND_IDS[number];

export const TicketSourceSchema = StrictObject({
  id: Type.Integer(),
  itemId: Type.Integer(),
  kind: Type.Union([Type.Literal("slack"), Type.Literal("jira"), Type.Literal("notion"), Type.Literal("manual")]),
  // 来源的地址。用户私信里建的单等没有地址的来源为 null。
  url: NullableString,
  externalKey: NullableString,
  conversation: NullableString,
  messageTs: NullableString,
  createdAt: Type.String(),
});
export type TicketSourceDto = Static<typeof TicketSourceSchema>;

export const TicketLinksSchema = StrictObject({
  // 子工单自己没有来源时，是根工单的来源。
  sources: Type.Array(TicketSourceSchema),
  // 工人挂过的会话，最近一次领取的在前，去重。
  sessions: Type.Array(StrictObject({ url: NullableString, sessionId: NullableString })),
  handlingReason: NullableString,
});
export type TicketLinks = Static<typeof TicketLinksSchema>;

const SOURCE_BRANDS: Record<TicketSourceKindId, string | null> = { slack: "Slack", jira: "Jira", notion: "Notion", manual: null };

/**
 * 来源给人看的标签：外部编号（PROJ-123）> 产品名（Slack、Jira、Notion）> 地址的主机名 > null。都是专有名词，不翻译。
 * 网关算列表的 sourceLabel 和网页画详情用同一个函数。
 */
export function ticketSourceLabel(source: { kind: string; url: string | null; externalKey: string | null }): string | null {
  if (source.externalKey) return source.externalKey;
  const brand = SOURCE_BRANDS[source.kind as TicketSourceKindId];
  if (brand) return brand;
  if (!source.url) return null;
  try {
    return new URL(source.url).hostname || null;
  } catch {
    return null;
  }
}

/** 会话链接能不能画成链接：只认 WORKER_SESSION_URL_SCHEMES（https、claude）。别的（javascript:、file:、http:、坏的）返回 null。 */
export function sessionLinkScheme(url: string | null | undefined): typeof WORKER_SESSION_URL_SCHEMES[number] | null {
  if (!url) return null;
  try {
    const protocol = new URL(url).protocol;
    return (WORKER_SESSION_URL_SCHEMES as readonly string[]).includes(protocol)
      ? protocol as typeof WORKER_SESSION_URL_SCHEMES[number]
      : null;
  } catch {
    return null;
  }
}
