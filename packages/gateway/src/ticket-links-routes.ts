// 网页看台账的两个只读接口（.scratch/external-worker-hub/spec.md P1-2、P1-7）。业务在 engine 的 worker-queue/links.ts，这里只认证、
// 校验参数、映射错误。不进 TicketSummary：TicketSummary 是严格校验的，加字段会让旧页面整张列表加载失败。
//   - GET /v1/tickets/meta?ids=1,2,3  tickets:view  列表上的处理方式、复杂度、领取人、几小时没动静、来源标签。
//     ids 是逗号隔开的正整数，至少一个，最多 TICKET_META_MAX_IDS 个；不存在的编号不出现在结果里。
//   - GET /v1/tickets/:id/links       tickets:view  来源、会话、判断理由。工单不存在时 404。
import type { IncomingMessage } from "node:http";
import { TICKET_META_MAX_IDS, type Scope } from "@pi-lead-child/protocol";
import { ticketLinks, ticketMeta } from "@pi-lead-child/engine";
import type { Db } from "@pi-lead-child/store";

export interface TicketLinksRouteContext {
  req: IncomingMessage;
  url: URL;
  db: Db;
  json(status: number, value: unknown): void;
  requireAuth(scope: Scope): void;
  // 把错误映射成 HTTP 错误（TicketActionError 的 not_found → 404）。
  mapError(error: unknown): never;
}

const META_PATH = "/v1/tickets/meta";
const LINKS_PATH = /^\/v1\/tickets\/(\d+)\/links$/;
const IDS = /^[1-9]\d{0,15}(,[1-9]\d{0,15})*$/;

/** 处理了返回 true；不是这两条路由返回 false。 */
export async function handleTicketLinksRoute(ctx: TicketLinksRouteContext): Promise<boolean> {
  if (ctx.req.method !== "GET") return false;
  if (ctx.url.pathname === META_PATH) {
    ctx.requireAuth("tickets:view");
    const raw = ctx.url.searchParams.get("ids") ?? "";
    const ids = IDS.test(raw) ? raw.split(",").map(Number) : null;
    if (!ids || ids.some((id) => !Number.isSafeInteger(id))) {
      ctx.json(400, { error: { code: "invalid_request", message: "ids must be comma-separated ticket ids, e.g. ids=1,2,3" } });
      return true;
    }
    if (ids.length > TICKET_META_MAX_IDS) {
      ctx.json(400, { error: { code: "invalid_request", message: `at most ${TICKET_META_MAX_IDS} ids per request` } });
      return true;
    }
    ctx.json(200, ticketMeta(ctx.db, ids));
    return true;
  }
  const match = ctx.url.pathname.match(LINKS_PATH);
  if (!match) return false;
  ctx.requireAuth("tickets:view");
  try {
    ctx.json(200, ticketLinks(ctx.db, Number(match[1])));
  } catch (error) {
    ctx.mapError(error);
  }
  return true;
}
