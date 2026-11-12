// GET /v1/hub/metrics?since=7d 的路由（计划 Task 14）：外部工人 hub 的指标，S1 成不成功看这几个数。tickets:view，只读。
// 口径在 store 的 hub-metrics.ts。since 只认 Nd、Nh（protocol 的 hubMetricsWindowMs），缺省 7d，别的写法回 400。
// 记「找不到」不在这里：它是通用的 POST /v1/actions/ticket_miss/hub/record（操作层的 ticket_miss.record）。
import type { IncomingMessage, ServerResponse } from "node:http";
import { HUB_METRICS_DEFAULT_SINCE, hubMetricsWindowMs, type HubMetricsResponse, type Scope } from "@pi-lead-child/protocol";
import { hubMetrics, type Db } from "@pi-lead-child/store";

export interface HubMetricsRouteContext {
  req: IncomingMessage;
  url: URL;
  db: Db;
  now(): Date;
  json(status: number, value: unknown): void;
  requireAuth(scope: Scope): void;
}

/** 处理 /v1/hub/metrics。不是这个路径、不是 GET 时返回 false。 */
export async function handleHubMetricsRoute(ctx: HubMetricsRouteContext): Promise<boolean> {
  if (ctx.url.pathname !== "/v1/hub/metrics" || ctx.req.method !== "GET") return false;
  ctx.requireAuth("tickets:view");
  const since = ctx.url.searchParams.get("since") ?? HUB_METRICS_DEFAULT_SINCE;
  const windowMs = hubMetricsWindowMs(since);
  if (windowMs === null) {
    ctx.json(400, { error: { code: "invalid_request", message: "since must be Nd or Nh, for example 7d or 36h" } });
    return true;
  }
  const body: HubMetricsResponse = { since, metrics: hubMetrics(ctx.db, new Date(ctx.now().getTime() - windowMs)) };
  ctx.json(200, body);
  return true;
}
