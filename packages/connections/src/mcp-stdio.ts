// 本地 MCP（npx、uvx 在本机起的 stdio 进程，.scratch/lead-self-install/spec.md D3）的客户端。
// 帧、超时、按进程组关停用 pi 自带的 @earendil-works/pi-mcp（McpClient、StdioTransport），不自己写。
// 这里只管 hub 要的几件事：按需起进程（第一次读工具或调用时）、闲一段时间停掉、进程退出后下一次调用再起，
// 以及给进程一份干净的环境：只有白名单里的变量，daemon 自己环境里的密钥不传进去。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { McpClient, McpConnectionClosedError, StdioTransport, type CallToolResult, type Tool } from "@earendil-works/pi-mcp";
import { localMcpCommand, type LocalMcpLaunch } from "@pi-lead-child/protocol";
import { McpTransportError, type McpCallResult, type McpContent, type McpTool } from "./mcp-client.js";

// hub 用的客户端：远程的 McpHttpClient 和这里的 McpStdioClient 都是它。
export interface McpSessionClient {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
  close(): Promise<void>;
}

// 第一次起进程时 npx、uvx 要下载包，给得宽一些。
export const STDIO_CONNECT_TIMEOUT_MS = 120_000;
export const STDIO_IDLE_MS = 10 * 60_000;
const STDERR_TAIL = 2_000;

// 传给进程的环境变量：只有这几个（daemon 的环境里有密钥，不传）。
const ENV_ALLOWLIST = ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM"] as const;

/** 本地 MCP 的连接行的 server_url（唯一键）：stdio:npm:<包>@<版本>，bin 不是缺省或者带参数时后面加它们的短哈希。 */
export function localServerUrl(launch: LocalMcpLaunch): string {
  const base = `stdio:${launch.registry}:${launch.package}@${launch.version}`;
  if (launch.bin === launch.package && launch.args.length === 0) return base;
  const hash = createHash("sha256").update(JSON.stringify([launch.bin, launch.args])).digest("hex").slice(0, 10);
  return `${base}#${hash}`;
}

export function isLocalServerUrl(url: string): boolean {
  return url.startsWith("stdio:");
}

/**
 * 找 npx、uvx。npx 先找 daemon 自己的 Node 旁边的那一个（和 daemon 同一个版本），再找 PATH；uvx 找 PATH 和几个常见的安装位置。
 * 找不到时为 null。
 */
export function findLocalExecutable(name: "npx" | "uvx", env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.HOME ?? homedir();
  const candidates = [
    ...(name === "npx" ? [join(dirname(process.execPath), "npx")] : []),
    ...(env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, name)),
    ...(name === "uvx" ? [join(home, ".local", "bin", "uvx"), join(home, ".cargo", "bin", "uvx"), "/opt/homebrew/bin/uvx", "/usr/local/bin/uvx"] : []),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

/** 给进程的环境：白名单里的变量，PATH 前面加上 daemon 的 Node 所在目录（npx 是 #!/usr/bin/env node），再关掉安装脚本和更新提示。 */
export function localMcpEnv(executable: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = env[key];
    if (typeof value === "string") result[key] = value;
  }
  const path = [dirname(process.execPath), dirname(executable), ...(env.PATH ?? "/usr/bin:/bin").split(delimiter)];
  result.PATH = [...new Set(path.filter(Boolean))].join(delimiter);
  // 依赖的安装脚本也不跑（审查只看得到这个包自己的）。
  result.npm_config_ignore_scripts = "true";
  result.npm_config_audit = "false";
  result.npm_config_fund = "false";
  result.NO_UPDATE_NOTIFIER = "1";
  result.UV_NO_PROGRESS = "1";
  return result;
}

export interface McpStdioClientOptions {
  launch: LocalMcpLaunch;
  // 进程的工作目录（hub 给 <数据目录>/mcp/<连接编号>，空目录）。没有时建。
  cwd: string;
  // 找 npx、uvx。缺省 findLocalExecutable。
  findExecutable?: (name: "npx" | "uvx") => string | null;
  // 测试用：直接给命令和参数，不经过 npx、uvx。
  command?: { executable: string; args: string[] };
  env?: NodeJS.ProcessEnv;
  connectTimeoutMs?: number;
  idleMs?: number;
  requestTimeoutMs?: number;
  toolCallTimeoutMs?: number;
  log?: (line: string) => void;
}

function toTool(tool: Tool): McpTool {
  const raw = tool as unknown as Record<string, unknown>;
  return {
    name: tool.name,
    ...(typeof raw.title === "string" ? { title: raw.title } : {}),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    inputSchema: raw.inputSchema && typeof raw.inputSchema === "object" ? raw.inputSchema as Record<string, unknown> : { type: "object" },
    ...(raw.annotations && typeof raw.annotations === "object" ? { annotations: raw.annotations as McpTool["annotations"] } : {}),
  };
}

function toResult(result: CallToolResult): McpCallResult {
  const raw = result as unknown as { content?: unknown; isError?: unknown; structuredContent?: unknown };
  return {
    content: Array.isArray(raw.content) ? raw.content as McpContent[] : [],
    isError: raw.isError === true,
    ...(raw.structuredContent !== undefined ? { structuredContent: raw.structuredContent } : {}),
  };
}

export class McpStdioClient implements McpSessionClient {
  readonly #options: McpStdioClientOptions;
  #client: McpClient | null = null;
  #connecting: Promise<McpClient> | null = null;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #stderr = "";
  #closed = false;
  #busy = 0;

  constructor(options: McpStdioClientOptions) {
    this.#options = options;
  }

  /** 最近一次进程的 stderr 末尾（起不来时放进错误里）。 */
  get stderrTail(): string {
    return this.#stderr;
  }

  async listTools(): Promise<McpTool[]> {
    return this.#use(async (client) => (await client.listTools({ timeoutMs: this.#options.requestTimeoutMs ?? 30_000 })).map(toTool));
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    return this.#use(async (client) => toResult(await client.callTool(name, args, {
      ...(signal ? { signal } : {}), timeoutMs: this.#options.toolCallTimeoutMs ?? 120_000,
    })), false);
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#stop();
  }

  // 用一次连接：没起时起；进程退出了（连接关了）时，只读的请求重起一次再试，调用不重试（可能已经做了）。
  async #use<T>(run: (client: McpClient) => Promise<T>, retry = true): Promise<T> {
    this.#busy += 1;
    this.#clearIdle();
    try {
      try {
        return await run(await this.#ready());
      } catch (error) {
        if (!(error instanceof McpConnectionClosedError) || !retry || this.#closed) throw this.#wrap(error);
        this.#client = null;
        return await run(await this.#ready());
      }
    } catch (error) {
      throw this.#wrap(error);
    } finally {
      this.#busy -= 1;
      this.#armIdle();
    }
  }

  #wrap(error: unknown): Error {
    if (error instanceof McpTransportError) return error;
    if (error instanceof McpConnectionClosedError) {
      return new McpTransportError(`the local MCP server exited${this.#stderr ? `: ${this.#stderr.slice(-300)}` : ""}`);
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  #ready(): Promise<McpClient> {
    if (this.#closed) return Promise.reject(new McpTransportError("the local MCP connection is closed"));
    if (this.#client && this.#client.connectionState === "connected") return Promise.resolve(this.#client);
    this.#connecting ??= this.#start().finally(() => { this.#connecting = null; });
    return this.#connecting;
  }

  async #start(): Promise<McpClient> {
    const options = this.#options;
    const command = options.command ?? (() => {
      const { executable, args } = localMcpCommand(options.launch);
      const path = (options.findExecutable ?? ((name) => findLocalExecutable(name, options.env)))(executable);
      if (!path) throw new McpTransportError(`${executable} is not installed on this computer`);
      return { executable: path, args };
    })();
    mkdirSync(options.cwd, { recursive: true, mode: 0o700 });
    this.#stderr = "";
    const transport = new StdioTransport({
      command: command.executable,
      args: command.args,
      cwd: options.cwd,
      env: localMcpEnv(command.executable, options.env),
      inheritEnv: false,
      stderr: "pipe",
      onStderr: (chunk) => { this.#stderr = `${this.#stderr}${chunk}`.slice(-STDERR_TAIL); },
    });
    const client = new McpClient({ name: "pi-lead-child", version: "1", requestTimeoutMs: options.requestTimeoutMs ?? 30_000 });
    client.onClose(() => {
      if (this.#client === client) this.#client = null;
    });
    const timeoutMs = options.connectTimeoutMs ?? STDIO_CONNECT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new McpTransportError(`the local MCP server did not start within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
        }),
      ]);
    } catch (error) {
      await client.close().catch(() => {});
      const tail = this.#stderr.trim().slice(-300);
      const message = error instanceof Error ? error.message : String(error);
      throw new McpTransportError(`starting the local MCP server failed: ${message}${tail ? ` (stderr: ${tail})` : ""}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (this.#closed) {
      await client.close().catch(() => {});
      throw new McpTransportError("the local MCP connection is closed");
    }
    this.#client = client;
    options.log?.(`[connections] local MCP ${options.launch.package}@${options.launch.version} started`);
    return client;
  }

  async #stop(): Promise<void> {
    this.#clearIdle();
    const client = this.#client ?? (this.#connecting ? await this.#connecting.catch(() => null) : null);
    this.#client = null;
    if (client) await client.close().catch(() => {});
  }

  #clearIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  // 闲下来一段时间就停掉进程，下次用时再起。
  #armIdle(): void {
    if (this.#busy > 0 || this.#closed || !this.#client) return;
    this.#clearIdle();
    this.#idleTimer = setTimeout(() => {
      this.#options.log?.(`[connections] local MCP ${this.#options.launch.package} idle, stopping it`);
      void this.#stop();
    }, this.#options.idleMs ?? STDIO_IDLE_MS);
    this.#idleTimer.unref?.();
  }
}
