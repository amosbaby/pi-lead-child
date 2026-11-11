// /v1/execution-mode 的路由（执行模式，.scratch/external-worker-hub/spec.md P1-1）。切换是操作层的 execution_mode.set
// （engine 的 ui-actions/execution-mode.ts，仓库 AGENTS.md「UI Actions」）：Lead 走 perform_action，调同一个函数，总是被拒绝。
// 这里只认证、校验请求体，再以你本人的名义交给 perform。
//   - GET  /v1/execution-mode   tickets:view    现在的模式：self、external 或 paused。
//   - POST /v1/execution-mode   tickets:create  切换：{ mode }。只有你本人能做（user_direct）。正在跑的 Run 不受影响。
import type { IncomingMessage, ServerResponse } from "node:http";
import { Value } from "typebox/value";
import { SetExecutionModeRequestSchema, type Scope } from "@pi-lead-child/protocol";
import { getExecutionMode } from "@pi-lead-child/engine";
import type { Db } from "@pi-lead-child/store";

export interface ExecutionModeRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  db: Db;
  json(status: number, value: unknown): void;
  readBody(): Promise<unknown>;
  requireAuth(scope: Scope): void;
  // 以你本人的名义做 execution_mode.set。出错时抛 HttpError（网关按错误码映射）。
  perform(input: unknown, scope: Scope): Promise<unknown>;
}

/** 处理执行模式的路由。不是这个路径时返回 false。 */
export async function handleExecutionModeRoute(ctx: ExecutionModeRouteContext): Promise<boolean> {
  if (ctx.url.pathname !== "/v1/execution-mode") return false;
  if (ctx.req.method === "GET") {
    ctx.requireAuth("tickets:view");
    ctx.json(200, { executionMode: { mode: getExecutionMode(ctx.db) } });
    return true;
  }
  if (ctx.req.method !== "POST") return false;
  ctx.requireAuth("tickets:create");
  const body = await ctx.readBody();
  if (!Value.Check(SetExecutionModeRequestSchema, body)) {
    ctx.json(400, { error: { code: "invalid_request", message: 'body must be {"mode": "self" | "external" | "paused"}' } });
    return true;
  }
  await ctx.perform(body, "tickets:create");
  ctx.json(200, { executionMode: { mode: getExecutionMode(ctx.db) } });
  return true;
}
