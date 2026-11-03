// 真实的 Slack Web API（slack-takeover 工单 02，spec D11）：用 Slack 官方 SDK 的 WebClient（@slack/web-api）。
//   - 一个 WebClient 不带令牌；每次调用带上调用方给的令牌（apiCall 的 token 参数，SDK 放进 Authorization 头）。
//   - 参数的编码（表单，复杂的值转成 JSON）、限流（429 按 Retry-After 等了再试）、网络错误的重试都交给 SDK 的重试配置。
//     重试的次数有上限：hub 和传输在等它的结果，不能一等半小时（SDK 的缺省配置）。
//   - SDK 遇到 ok:false 会抛「平台错误」。这里转回 Slack 原来的回答（{ ok:false, error }）：适配器按 error 分情况处理
//     （例如撤回时 message_not_found 算已经删掉了）。网络错误、HTTP 错误照样抛错。
//   - 报错和日志里不带令牌：先把这次的令牌原样换掉，再按通用的规则脱敏。SDK 的日志只要 warn 以上。
//   - 下载消息附带的文件（download，2026-11-02）：不是 Web API 的方法，按 files.info 给的 url_private 直接取，
//     令牌放在 Authorization 头里，只发往 https://files.slack.com。
// SDK 第一次调用时才加载：engine 被很多进程引用（每个 Run 的 mcp-server、测试），加载 SDK 要几百毫秒。
import { redactSecretText } from "@pi-lead-child/protocol";
import type { Logger, LogLevel, RetryOptions, WebClient, WebClientOptions } from "@slack/web-api";

/** Slack Web API 的一个方法（https://slack.com/api/<method>）。返回 Slack 的 JSON（带 ok）。网络错误时抛错。 */
export interface SlackWebApi {
  call(method: string, args: Record<string, unknown>, token: string): Promise<Record<string, unknown>>;
  /**
   * 下载一个文件（files.info 的 url_private_download）：只下载 https://files.slack.com 上的地址，令牌只放在 Authorization 头里。
   * 超过 maxBytes、Slack 回的不是文件（例如令牌缺 files:read 时的登录网页）、网络错误时抛错。没有时不能下载文件。
   */
  download?(url: string, token: string, maxBytes: number): Promise<Uint8Array>;
}

/** 令牌只发往这个主机（slackFileUrlAllowed）。 */
export const SLACK_FILES_HOST = "files.slack.com";

/** 这个文件地址能不能带上令牌去下载：只能是 https://files.slack.com 上的地址。 */
export function slackFileUrlAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === SLACK_FILES_HOST && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** WebClient 用的 fetch。测试注入假的 Slack。 */
export type SlackFetch = NonNullable<WebClientOptions["fetch"]>;

export interface SlackWebApiOptions {
  fetch?: SlackFetch;
  // 一次请求最多等多久。缺省 15 秒。
  timeoutMs?: number;
  // 重试（网络错误、HTTP 错误、限流）。缺省最多再试 2 次，间隔 1 秒起翻倍、最多 10 秒；限流时先等 Retry-After。
  retry?: RetryOptions;
  // SDK 的 warn、error 日志。已经去掉了令牌。
  log?: (line: string) => void;
}

const DEFAULT_RETRY: RetryOptions = { retries: 2, factor: 2, minTimeout: 1_000, maxTimeout: 10_000 };
// @slack/web-api 的 ErrorCode.PlatformError。
const PLATFORM_ERROR = "slack_webapi_platform_error";

/** 去掉文字里的这些令牌，再按通用的规则脱敏。 */
export function scrubSlackText(text: string, secrets: ReadonlyArray<string | null | undefined>): string {
  let result = text;
  for (const secret of secrets) if (secret && secret.length >= 4) result = result.split(secret).join("[凭据]");
  return redactSecretText(result);
}

/** 转给我们的日志、只要 warn 以上的 SDK logger（@slack/logger 的 Logger 接口）。 */
export function slackSdkLogger(log: ((line: string) => void) | undefined, name: string, secrets: () => ReadonlyArray<string | null | undefined> = () => []): Logger {
  const write = (level: string, parts: unknown[]) => {
    if (!log) return;
    const text = parts.map((part) => (part instanceof Error ? part.message : typeof part === "string" ? part : safeJson(part))).join(" ");
    log(`${name} ${level}: ${scrubSlackText(text, secrets())}`);
  };
  return {
    debug: () => {},
    info: () => {},
    warn: (...parts: unknown[]) => write("warn", parts),
    error: (...parts: unknown[]) => write("error", parts),
    setLevel: () => {},
    getLevel: () => "warn" as LogLevel,
    setName: () => {},
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function platformResult(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== "object" || (error as { code?: unknown }).code !== PLATFORM_ERROR) return null;
  const data = (error as { data?: Record<string, unknown> }).data ?? {};
  return { ...data, ok: false, error: typeof data.error === "string" ? data.error : "unknown_error" };
}

/**
 * 读下载文件的回答（两种连接方式共用）：不是 2xx、回的是网页、超过 maxBytes 时抛错。
 * 令牌不对或者缺 files:read 时，Slack 回 200 和登录网页。
 */
export async function readSlackFile(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`slack file download: HTTP ${response.status}`);
  }
  if ((response.headers.get("content-type") ?? "").startsWith("text/html")) {
    await response.body?.cancel();
    throw new Error("slack file download: Slack answered with a web page, not the file (the token may lack files:read)");
  }
  const tooLarge = () => new Error(`slack file download: the file is larger than ${maxBytes} bytes`);
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

/** 真实的 SlackWebApi。 */
// 令牌只放在 Authorization 头里。WebClient 的 apiCall 收到 options.token 时，除了放进头，还会把它原样留在表单请求体里；
// apps.connections.open 不接受请求体里的令牌，一律回 invalid_auth（2026-10-21：设置页把用户的 App-Level Token 一直判成无效）。
// 所以每个令牌一个 WebClient（构造时给令牌，它只进头），调用时不传 token。令牌很少（一个来源两个），按令牌缓存。
const MAX_CLIENTS = 8;

export function createSlackWebApi(options: SlackWebApiOptions = {}): SlackWebApi {
  const clients = new Map<string, Promise<WebClient>>();
  const load = (token: string) => {
    const known = clients.get(token);
    if (known) return known;
    if (clients.size >= MAX_CLIENTS) clients.delete(clients.keys().next().value!);
    const client = import("@slack/web-api").then(({ WebClient: Client }) => new Client(token, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      timeout: options.timeoutMs ?? 15_000,
      retryConfig: options.retry ?? DEFAULT_RETRY,
      logger: slackSdkLogger(options.log, "slack web api"),
    }));
    clients.set(token, client);
    return client;
  };
  const fetchFile = (options.fetch ?? globalThis.fetch) as typeof globalThis.fetch;
  return {
    async download(url, token, maxBytes) {
      if (!slackFileUrlAllowed(url)) throw new Error(`slack file download: only ${SLACK_FILES_HOST} addresses are allowed`);
      let response: Response;
      try {
        response = await fetchFile(url, {
          headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        });
      } catch (error) {
        throw new Error(`slack file download: ${scrubSlackText(errorText(error), [token])}`);
      }
      return readSlackFile(response, maxBytes);
    },
    async call(method, args, token) {
      try {
        const web = await load(token);
        const { token: _ignored, ...rest } = args as Record<string, unknown> & { token?: unknown };
        return await web.apiCall(method, rest) as unknown as Record<string, unknown>;
      } catch (error) {
        const result = platformResult(error);
        if (result) return result;
        throw new Error(`slack ${method}: ${scrubSlackText(errorText(error), [token])}`);
      }
    },
  };
}
