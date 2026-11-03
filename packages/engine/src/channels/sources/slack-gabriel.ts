// Slack 浏览器会话方式用的 gabriel-slack（npm 包，MIT，用网页版 Slack 的会话 cookie 连接；用户 2026-11-02 定）。
// 只有这个文件 import 它，别的代码经过这里用。
//   - 版本锁死在 0.1.1（packages/engine/package.json 写精确版本，package-lock.json 记下 sha512）。用之前审查过 npm 上发布的代码：
//     tarball 的哈希和 SLSA 来源证明一致（GitHub 托管的 runner 从 tag node-v0.1.1 构建），从那个 tag 的源码重新编译出的 JS
//     和发布的逐个相同，没有安装脚本，只连 Slack 的主机。
//   - 只用底层的 GabrielCore（换令牌、Web API、WebSocket、心跳、重连、令牌刷新）。消息分类、补拉、回复都用我们自己的。
//   - 审查发现的两处在这里补上：
//     1. 服务器给的重连地址（reconnect_url）没有检查主机，连接带着 cookie：createWebSocket 只接受 wss:// 加 Slack 的主机。
//     2. 它缺省的脱敏会留下令牌的前几个字符：日志经过我们自己的 logger，按这次的 cookie 和令牌整段去掉。
//   - 升级：只在需要时升级（例如 Slack 改了协议，0.1.1 不能用了）。每次升级前重复上面的审查，再审查代码差异。
//     作者不再维护时，按 MIT 许可 fork 到我们自己名下。
// 第一次用时才加载（engine 被很多进程引用，用 Slack 应用方式的人用不到它）。
import type { GabrielCore, GabrielCoreOptions, WebSocketFactory, WebSocketLike } from "gabriel-slack";
import { scrubSlackText } from "./slack-web-api.js";

export type { GabrielCore, RawWsFrame, WebSocketFactory, WebSocketLike } from "gabriel-slack";

/** 会话方式的 fetch 和 WebSocket（测试注入假的 Slack）。缺省是全局的 fetch 和 ws 包。 */
export interface SlackSessionNetwork {
  fetch?: typeof globalThis.fetch;
  createWebSocket?: WebSocketFactory;
  // 网络出错时可以重试的调用（只读的、幂等的）最多再试几次。缺省用 gabriel 的（3 次）。
  maxHttpRetries?: number;
}

// 带 cookie 的连接只发往这些主机（和 gabriel 的 SLACK_HOST 一样）。
const SLACK_HOST = /(^|\.)slack(-edge|-files)?\.com$/i;

/** 这个 WebSocket 地址能不能带着 cookie 去连：只能是 wss:// 加 Slack 的主机。 */
export function slackSocketUrlAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "wss:" && SLACK_HOST.test(parsed.hostname) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/**
 * 建一个 GabrielCore（还没有换令牌、没有连接）。cookie 是会话的根凭据；workspace 限定只连这个工作区（编号）。
 * log 收到的日志已经去掉 cookie 和令牌。
 */
export async function createGabrielCore(input: {
  cookie: string;
  workspace?: string;
  network?: SlackSessionNetwork;
  log: (line: string) => void;
}): Promise<GabrielCore> {
  const { GabrielCore: Core } = await import("gabriel-slack");
  let core: GabrielCore | null = null;
  const secrets = () => {
    let token: string | null = null;
    try {
      token = core?.session.token ?? null;
    } catch {
      token = null;
    }
    return [input.cookie, token];
  };
  const write = (level: string) => (obj: Record<string, unknown>, msg?: string) => {
    input.log(scrubSlackText(`session ${level}: ${msg ?? ""} ${JSON.stringify(obj)}`.trim(), secrets()));
  };
  const options: GabrielCoreOptions = {
    auth: { cookieD: input.cookie, ...(input.workspace ? { allowedTeams: [input.workspace] } : {}) },
    logger: { debug: () => {}, info: () => {}, warn: write("warn"), error: write("error") },
    ...(input.network?.fetch ? { fetch: input.network.fetch } : {}),
    ...(input.network?.maxHttpRetries !== undefined ? { maxHttpRetries: input.network.maxHttpRetries } : {}),
    createWebSocket: guardedWebSocket(input.network?.createWebSocket ?? (await defaultWebSocket())),
  };
  core = new Core(options);
  return core;
}

// gabriel 的缺省 WebSocket（ws 包，和它自己的写法一样）。
async function defaultWebSocket(): Promise<WebSocketFactory> {
  const { default: WebSocket } = await import("ws");
  return (url, headers) => new WebSocket(url, { headers, perMessageDeflate: false, handshakeTimeout: 15_000 }) as unknown as WebSocketLike;
}

function guardedWebSocket(create: WebSocketFactory): WebSocketFactory {
  return (url, headers) => {
    if (!slackSocketUrlAllowed(url)) {
      let host = "an invalid address";
      try {
        host = new URL(url).host;
      } catch {
        // 地址本身不对：上面的说法就够了。
      }
      throw new Error(`refusing to send the Slack session cookie to ${host}`);
    }
    return create(url, headers);
  };
}

/** gabriel 的错误：Slack 原来的错误码（例如 channel_not_found）和 gabriel 的分类（例如 AUTH_DEAD）。不是它的错误时都是 null。 */
export function gabrielErrorOf(error: unknown): { code: string | null; slackError: string | null } {
  if (!error || typeof error !== "object" || (error as { name?: unknown }).name !== "GabrielError") return { code: null, slackError: null };
  const { code, rawSlackError } = error as { code?: unknown; rawSlackError?: unknown };
  return {
    code: typeof code === "string" ? code : null,
    slackError: typeof rawSlackError === "string" && rawSlackError ? rawSlackError : null,
  };
}
