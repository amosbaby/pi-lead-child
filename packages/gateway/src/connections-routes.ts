// /v1/connections 的路由和 OAuth 回调页。网关不懂 OAuth：它只做认证、校验请求体，再交给 daemon 的
// ConnectionHub（经 PairedBridge.connections）。令牌不经过这里，除了用户在设置页粘贴的 GitHub 令牌
// 一次性地穿过请求体：这里不记日志，也不回显。
//
// 读用 tickets:view，改用 tickets:create（和 /v1/lead/trust 一样，tickets:create 表示「这台设备是主人」）。
import type { IncomingMessage, ServerResponse } from "node:http";
import { connectionSettingsOwnerAction, type OwnerActionInput } from "./owner-actions.js";
import { routeMessages } from "./routes.messages.js";
import { Value } from "typebox/value";
import {
  AddCustomConnectionRequestSchema,
  DEFAULT_LEAD_NAME,
  DEFAULT_LOCALE,
  type Locale,
  ResolveConnectionConfirmationRequestSchema,
  type ConnectionConfirmationDto,
  ConnectionSettingsRequestSchema,
  StartConnectionRequestSchema,
  type ConnectionDto,
  type ConnectionFlowResponse,
  type ConnectionSettingsRequest,
  type ConnectionToolDto,
  type Scope,
  type StartConnectionResponse,
} from "@pi-lead-child/protocol";

export const OAUTH_CALLBACK_PATH = "/oauth/callback";

export interface ConnectionsService {
  list(): { items: ConnectionDto[]; attention: number };
  start(key: string, input: { token?: string }): Promise<StartConnectionResponse>;
  addCustom(serverUrl: string): Promise<StartConnectionResponse>;
  flowStatus(flowId: string): ConnectionFlowResponse;
  completeCallback(params: {
    state: string | null; code: string | null; iss: string | null; error: string | null; errorDescription: string | null;
  }): Promise<{ flowId: string; label: string }>;
  updateSettings(key: string, settings: ConnectionSettingsRequest): ConnectionDto;
  test(key: string): Promise<{ ok: boolean; message: string; connection: ConnectionDto }>;
  disconnect(key: string): Promise<ConnectionDto>;
  tools(key: string): ConnectionToolDto[];
  confirmation(id: string): ConnectionConfirmationDto;
  resolveConfirmation(id: string, approve: boolean, resolvedBy: string): Promise<ConnectionConfirmationDto>;
}

// ConnectionHub 抛的错误带一个 code（packages/connections 的 ConnectionErrorCode）。按它选 HTTP 状态，
// 在 error.details.reason 里原样带回，界面据此决定显示什么（例如 needs_setup 显示设置说明）。
const ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  flow_not_found: 404,
  invalid_request: 400,
  unknown_tool: 400,
  forbidden: 403,
  not_connected: 409,
  needs_setup: 409,
  unavailable: 409,
  needs_reauth: 409,
  confirmation_required: 409,
  authorization_failed: 502,
  temporarily_unavailable: 503,
};

function connectionError(error: unknown): { status: number; reason: string; message: string } | null {
  if (!(error instanceof Error)) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string" || !(code in ERROR_STATUS)) return null;
  return { status: ERROR_STATUS[code]!, reason: code, message: error.message };
}

const HTTP_CODE: Record<number, string> = {
  400: "invalid_request", 403: "forbidden", 404: "not_found", 409: "conflict", 502: "internal_error", 503: "internal_error",
};

export interface ConnectionRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  service: ConnectionsService | undefined;
  json(status: number, value: unknown): void;
  readBody(): Promise<Record<string, unknown>>;
  // 返回调用方 binding 的显示名，写进确认的 resolvedBy。
  requireAuth(scope: Scope): string;
  // 写入确认成功以后，记一次主人操作（工单 15）。凭证是上一次 requireAuth 的调用方。
  ownerAction?(input: OwnerActionInput): void;
  // 用户现在选的界面语言（store 的 getLocale）：回给界面的错误和主人操作的摘要按它写。不给时按缺省语言。
  locale?: Locale;
}

const KEY = /^[a-z][a-z0-9-]{0,39}$/;
const FLOW_ID = /^flow_[A-Za-z0-9_-]{8,64}$/;
const CONFIRMATION_ID = /^cfm_[A-Za-z0-9_-]{8,40}$/;

/**
 * 你对一次写入确认的决定：允许时执行存下的那一次调用（参数不变），不要时作废。App 的路由和 Slack 私信里的按钮（工单 #72）都调它。
 * by 是做决定的凭证的名字（写进 resolvedBy）。返回确认现在的样子和要记的主人操作（凭证和来源由调用方补上）。
 * 已经处理过、过期的确认不再执行，原样返回它现在的状态（ConnectionHub.resolveConfirmation）。
 */
export async function resolveConnectionConfirmationAsUser(
  service: Pick<ConnectionsService, "resolveConfirmation">, id: string, approve: boolean, by: string, locale: Locale = DEFAULT_LOCALE,
): Promise<{ confirmation: ConnectionConfirmationDto; ownerAction: OwnerActionInput }> {
  const m = routeMessages(locale);
  const confirmation = await service.resolveConfirmation(id, approve, `user via ${by}`);
  return {
    confirmation,
    ownerAction: {
      action: "connection.confirm",
      target: { key: `connection_confirmation:${id}`, label: m.connectionConfirmationTarget(confirmation.label), ticketId: null },
      summary: m.connectionConfirmed(approve, confirmation.label, confirmation.summary),
      detail: { approve, tool: confirmation.tool, state: confirmation.state },
      undo: { kind: "connection_confirmation", confirmationId: id, approve, state: confirmation.state },
    },
  };
}

// 处理了返回 true。不是连接的路由返回 false。认证失败、请求体不对时抛出网关自己的错误，由调用方回应。
export async function handleConnectionRoute(ctx: ConnectionRouteContext): Promise<boolean> {
  const { req, url } = ctx;
  if (url.pathname !== "/v1/connections" && !url.pathname.startsWith("/v1/connections/")) return false;
  const service = ctx.service;
  const locale = ctx.locale ?? DEFAULT_LOCALE;
  const m = routeMessages(locale);
  const fail = (status: number, reason: string, message: string) =>
    // reason 放在 details 里：客户端用严格的 HttpErrorResponseSchema 校验错误响应，多一个字段整条错误就会被丢掉。
    ctx.json(status, { error: { code: HTTP_CODE[status] ?? "internal_error", message, details: { reason } } });
  const run = async (scope: Scope, action: (svc: ConnectionsService) => Promise<unknown> | unknown, status = 200) => {
    ctx.requireAuth(scope);
    if (!service) {
      fail(503, "unavailable", m.connectionsUnavailable);
      return true;
    }
    try {
      ctx.json(status, await action(service));
    } catch (error) {
      const mapped = connectionError(error);
      if (!mapped) throw error;
      fail(mapped.status, mapped.reason, mapped.message);
    }
    return true;
  };

  if (req.method === "GET" && url.pathname === "/v1/connections") {
    return run("tickets:view", (svc) => svc.list());
  }

  const flow = /^\/v1\/connections\/flows\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && flow) {
    const flowId = decodeURIComponent(flow[1]!);
    if (!FLOW_ID.test(flowId)) {
      ctx.requireAuth("tickets:view");
      fail(400, "invalid_request", "flow id is malformed");
      return true;
    }
    return run("tickets:view", (svc) => svc.flowStatus(flowId));
  }

  // 写入确认：读用 tickets:view，按「允许 / 不要」用 approvals:respond（和审批同一个 scope）。
  // Lead 的工具走不到这里，所以确认只能来自用户。
  const confirmation = /^\/v1\/connections\/confirmations\/([^/]+)(\/resolve)?$/.exec(url.pathname);
  if (confirmation) {
    const id = decodeURIComponent(confirmation[1]!);
    if (!CONFIRMATION_ID.test(id)) {
      ctx.requireAuth("tickets:view");
      fail(400, "invalid_request", "confirmation id is malformed");
      return true;
    }
    if (req.method === "GET" && !confirmation[2]) {
      return run("tickets:view", (svc) => ({ confirmation: svc.confirmation(id) }));
    }
    if (req.method === "POST" && confirmation[2]) {
      const by = ctx.requireAuth("approvals:respond");
      const body = await ctx.readBody();
      if (!Value.Check(ResolveConnectionConfirmationRequestSchema, body)) {
        fail(400, "invalid_request", "approve must be a boolean");
        return true;
      }
      return run("approvals:respond", async (svc) => {
        const { confirmation, ownerAction } = await resolveConnectionConfirmationAsUser(
          svc, id, (body as { approve: boolean }).approve, by, locale,
        );
        ctx.ownerAction?.(ownerAction);
        return { confirmation };
      });
    }
    return false;
  }

  if (req.method === "POST" && url.pathname === "/v1/connections/custom") {
    ctx.requireAuth("tickets:create");
    const body = await ctx.readBody();
    if (!Value.Check(AddCustomConnectionRequestSchema, body)) {
      fail(400, "invalid_request", "serverUrl is required");
      return true;
    }
    return run("tickets:create", (svc) => svc.addCustom((body as { serverUrl: string }).serverUrl));
  }

  const action = /^\/v1\/connections\/([^/]+)\/(start|settings|test|disconnect|tools)$/.exec(url.pathname);
  if (!action) return false;
  const key = decodeURIComponent(action[1]!);
  const verb = action[2]!;
  if (!KEY.test(key)) {
    ctx.requireAuth("tickets:view");
    fail(400, "invalid_request", "connection key is malformed");
    return true;
  }
  if (verb === "tools") {
    if (req.method !== "GET") return false;
    return run("tickets:view", (svc) => ({ items: svc.tools(key) }));
  }
  if (req.method !== "POST") return false;
  ctx.requireAuth("tickets:create");
  const body = req.headers["content-length"] === "0" ? {} : await ctx.readBody();
  if (verb === "start") {
    if (!Value.Check(StartConnectionRequestSchema, body)) {
      fail(400, "invalid_request", "the request body has unknown fields");
      return true;
    }
    return run("tickets:create", (svc) => svc.start(key, body as { token?: string }));
  }
  if (verb === "settings") {
    if (!Value.Check(ConnectionSettingsRequestSchema, body)) {
      fail(400, "invalid_request", "roles or writePolicy is invalid");
      return true;
    }
    // 改权限设置是主人操作（工单 15）：放开写入策略以后，child 可以不经确认写外部服务（2026-10-19 审查）。
    return run("tickets:create", (svc) => {
      const before = svc.list().items.find((item) => item.key === key);
      const connection = svc.updateSettings(key, body as ConnectionSettingsRequest);
      ctx.ownerAction?.(connectionSettingsOwnerAction(before, connection, locale));
      return { connection };
    });
  }
  if (verb === "test") return run("tickets:create", (svc) => svc.test(key));
  return run("tickets:create", async (svc) => ({ connection: await svc.disconnect(key) }));
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function callbackPage(res: ServerResponse, status: number, title: string, detail: string, lang: string): void {
  const html = `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{margin:0;font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#F5F6F8;color:#10131A;display:flex;min-height:100vh;align-items:center;justify-content:center}main{background:#fff;border:1px solid #E8EAEF;border-radius:16px;padding:28px 32px;max-width:420px;margin:16px}h1{font-size:19px;margin:0 0 8px}p{margin:0;color:#475467}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body></html>`;
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  });
  res.end(html);
}

// 浏览器授权后跳回这里。它不带 binding 的凭证，靠 state 认人（state 只能用一次，10 分钟过期）。
// 回调地址是 127.0.0.1，所以只接受从本机回环地址来的请求：局域网或 Tailscale 上的监听不响应它。
export async function handleOAuthCallback(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  service: ConnectionsService | undefined,
  isLoopback: boolean,
  log: (line: string) => void,
  // 页面的语言（用户现在选的界面语言）和称呼 Lead 的名字（设置 → 身份与风格）。
  text: { locale: Locale; leadName: string } = { locale: DEFAULT_LOCALE, leadName: DEFAULT_LEAD_NAME },
): Promise<void> {
  const m = routeMessages(text.locale);
  const page = (status: number, title: string, detail: string) => callbackPage(res, status, title, detail, m.htmlLang);
  if (!isLoopback) {
    page(403, m.oauthNotHereTitle, m.oauthNotHereDetail(text.leadName));
    return;
  }
  if (!service) {
    page(503, m.connectionsUnavailable, m.oauthUnavailableDetail(text.leadName));
    return;
  }
  const param = (name: string) => {
    const value = url.searchParams.get(name);
    return value && value.length <= 4096 ? value : null;
  };
  try {
    const { label } = await service.completeCallback({
      state: param("state"), code: param("code"), iss: param("iss"),
      error: param("error"), errorDescription: param("error_description"),
    });
    page(200, m.oauthConnectedTitle(label), m.oauthConnectedDetail(text.leadName));
  } catch (error) {
    const mapped = connectionError(error);
    if (!mapped) log(`[gateway] OAuth callback failed: ${error instanceof Error ? error.message : String(error)}`);
    page(mapped && mapped.status < 500 ? 400 : 502, m.oauthFailedTitle, mapped?.message ?? m.oauthFailedDetail(text.leadName));
  }
}
