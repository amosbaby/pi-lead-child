// 运行包的冒烟测试（设计文档 P0-2、第 8.1 节）：从运行包启动 supervisor，等 daemon 在 plc.sock 上回答 status，
// 检查两个进程的名字都是 lead-agent，再停掉。另外检查 pi 和 plc 能用运行包自带的 Node 运行。
// 运行时按路径加载的文件（工单 #260：1.1.1、1.1.2 的运行包里没有 pi 扩展，pi 执行器起不来）：每一项都要在包里，
// 运行包自己的 ops selfcheck 要从 dist 里找到它们，pi 要真的加载全部扩展和 skill 目录。
//
// 隔离：这台机器上可能有用户正在用的服务，冒烟不能碰它们。
// - 数据目录（PLC_DATA_DIR）和 HOME 都是新建的临时目录。daemon 用全新的数据目录启动时，记忆模块会卸载 Hindsight 的
//   launchd 任务并删掉 ~/Library/LaunchAgents 里它的 plist（memory-controller.ts 的 reconcile → stopService）。
//   临时 HOME 让删除落在临时目录里；
// - PATH 最前面放一个假的 launchctl（还有 security、osascript、open），它只记下调用、返回失败。launchctl 的 label 不分数据目录，
//   真的 bootout 会停掉用户的服务。supervisor 和 daemon 都按名字调用这些命令，PATH 里排在系统目录前面的先被找到；
// - 不继承调用者的 PLC_* 变量（例如 PLC_DEV 会让 supervisor 改跑源码）。
// - 不碰真钥匙串（工单 #243）。假的 security 只接住按名字调用的命令；进程自己通过 Security.framework 发出的调用照样会碰到
//   真钥匙串，HOME 换掉以后还可能弹窗请用户新建登录钥匙串。所以保险库改用数据目录里的密钥文件（PLC_VAULT_KEY_SOURCE=file），
//   也不让 Node 去读系统钥匙串里的根证书（去掉 NODE_USE_SYSTEM_CA）。冒烟结束时，假 security 只要收到过 add-generic-password
//   就判失败。
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { RUNTIME_ASSETS } from "@pi-lead-child/core";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { promisify } from "node:util";
import { RUNTIME_ASSET_FILES } from "./pack.js";
import { PRODUCT, RELEASE_FILE } from "./release.js";

const execFileAsync = promisify(execFile);

export const SMOKE_TIMEOUT_MS = 60_000;
export const PROCESS_NAME = "lead-agent";
// macOS 的 sockaddr_un.sun_path 是 104 字节，含结尾的 0。
export const MAX_SOCKET_PATH_BYTES = 103;
// 假命令：记下参数，返回失败。security 的 44 是「钥匙串里没有这一项」。
// security -i 的命令在标准输入里：假的 security 记下每一行的第一个词（命令名），不记后面的参数，密钥不进记录。
export const STUB_COMMANDS: Record<string, number> = { launchctl: 1, security: 44, osascript: 1, open: 1 };

export interface SmokeDirs {
  home: string;
  dataDir: string;
  stubBin: string;
  stubLog: string;
}

// 冒烟进程的环境里要去掉的变量：PLC_* 以外的。
const DROPPED_ENV = new Set(["NODE_OPTIONS", "NODE_USE_SYSTEM_CA"]);

/**
 * 冒烟进程的环境：去掉调用者的 PLC_*、NODE_OPTIONS 和 NODE_USE_SYSTEM_CA，HOME 和数据目录换成临时目录，假命令排在 PATH 最前面，
 * 保险库用文件密钥。
 */
export function smokeEnv(base: NodeJS.ProcessEnv, dirs: SmokeDirs): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith("PLC_") || DROPPED_ENV.has(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: dirs.home,
    PATH: [dirs.stubBin, ...(base.PATH ?? "").split(delimiter).filter(Boolean)].join(delimiter),
    PLC_DATA_DIR: dirs.dataDir,
    PLC_SMOKE_STUB_LOG: dirs.stubLog,
    PLC_GATEWAY_PORT: "0",
    PLC_GATEWAY_HOST: "127.0.0.1",
    PLC_DESKTOP_NOTIFY: "off",
    PLC_OPEN_FILES: "off",
    PLC_MEMORY_BACKEND: "sqlite",
    PLC_VAULT_KEY_SOURCE: "file",
  };
}

export function stubScript(name: string, exitCode: number): string {
  const stdinCommands = name === "security"
    ? `if [ "$1" = -i ]; then while read -r command rest; do printf '%s -i %s\\n' ${name} "$command" >> "$PLC_SMOKE_STUB_LOG"; done; fi\n`
    : "";
  return `#!/bin/sh\nprintf '%s %s\\n' ${name} "$*" >> "$PLC_SMOKE_STUB_LOG"\n${stdinCommands}exit ${exitCode}\n`;
}

/** 假 security 的调用记录里写钥匙串的那些行。冒烟不能写真钥匙串，有一行就判失败。 */
export function keychainWrites(stubCalls: string[]): string[] {
  return stubCalls.filter((line) => line.startsWith("security ") && line.includes("add-generic-password"));
}

function writeStubs(dirs: SmokeDirs): void {
  mkdirSync(dirs.stubBin, { recursive: true });
  for (const [name, code] of Object.entries(STUB_COMMANDS)) {
    const path = join(dirs.stubBin, name);
    writeFileSync(path, stubScript(name, code));
    chmodSync(path, 0o755);
  }
  writeFileSync(dirs.stubLog, "");
}

/** ps -o comm= 的输出是可执行文件的路径（macOS）或名字（Linux），取最后一段。 */
export function commandName(psOutput: string): string {
  return basename(psOutput.trim());
}

export async function processName(pid: number): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-o", "comm=", "-p", String(pid)]);
  return commandName(stdout);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(timeoutMs: number, probe: () => Promise<T | null>, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error(`${Math.round(timeoutMs / 1000)} 秒内没有等到${what}`);
    await delay(200);
  }
}

/** 在本机 socket 上发一条 JSONL 请求，等对应的回答。连不上或超时返回 null。 */
export function localRequest(sockPath: string, payload: Record<string, unknown>, timeoutMs = 2_000): Promise<{ success: boolean; data?: any; error?: string } | null> {
  return new Promise((resolve) => {
    const id = `smoke-${process.pid}-${Date.now()}`;
    const socket = connect(sockPath);
    let buffer = "";
    const finish = (value: { success: boolean; data?: any; error?: string } | null) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("error", () => finish(null));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message?.type === "response" && (message.id === id || message.id === undefined)) return finish(message);
        } catch { /* 不是 JSON 的行：接着等 */ }
      }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ ...payload, id })}\n`));
  });
}

function tail(path: string, lines = 40): string {
  try {
    return readFileSync(path, "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function recordedDaemonPid(dataDir: string): number | null {
  try {
    const pid = Number((JSON.parse(readFileSync(join(dataDir, "supervisor-state.json"), "utf8")) as { daemonPid?: unknown }).daemonPid);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** 运行包自己的 ops selfcheck（apps/daemon/src/ops.ts）。不通过时抛错，错误里带每一项检查。 */
export async function runtimeSelfcheck(leadAgent: string, runtime: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  const ops = join(runtime, "apps", "daemon", "dist", "ops.mjs");
  let stdout: string;
  try {
    stdout = (await execFileAsync(leadAgent, [ops, "selfcheck"], { cwd, env, timeout: 30_000 })).stdout;
  } catch (error) {
    stdout = (error as { stdout?: string }).stdout ?? "";
    if (!stdout) throw new Error(`ops selfcheck 没有运行：${(error as Error).message}`);
  }
  const report = JSON.parse(stdout) as { ok?: boolean; checks?: Array<{ name: string; ok: boolean; detail: string }> };
  const checks = report.checks ?? [];
  const assets = checks.find((check) => check.name === "runtime assets");
  if (!report.ok || !assets) {
    throw new Error(`ops selfcheck 没有通过：${checks.map((check) => `${check.name} ${check.ok ? "ok" : "失败"}（${check.detail}）`).join("；") || stdout}`);
  }
  // 运行包里只有 dist，没有源码。
  if (!/ in dist$/.test(assets.detail)) throw new Error(`ops selfcheck 没有从 dist 解析运行时资源：${assets.detail}`);
  return assets.detail;
}

export interface PiLoadResult {
  extensions: string[];
  skills: string[];
}

/**
 * 用运行包的 Node 以 RPC 模式起一次 pi，加载全部扩展和 skill 目录，问一次 get_commands。
 * pi 加载扩展失败时直接退出（退出码 1，stderr 是 "Failed to load extension"），没有回答；skill 出现在 get_commands 里。
 */
export function piLoadsExtensions(o: {
  leadAgent: string; pi: string; extensions: string[]; skillDirs: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number;
}): Promise<PiLoadResult> {
  return new Promise((resolve, reject) => {
    const args = [o.pi, "--mode", "rpc", "--no-session", "-ne", ...o.extensions.flatMap((path) => ["-e", path]), ...o.skillDirs.flatMap((dir) => ["--skill", dir])];
    const child = spawn(o.leadAgent, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, value?: PiLoadResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error(`pi 在 ${Math.round(o.timeoutMs / 1000)} 秒内没有回答 get_commands：${stderr.trim()}`)), o.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      for (let newline = stdout.indexOf("\n"); newline >= 0; newline = stdout.indexOf("\n")) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        let message: { type?: string; id?: string; success?: boolean; error?: string; data?: { commands?: Array<{ name: string; source?: string; sourceInfo?: { path?: string } }> } };
        try { message = JSON.parse(line); } catch { continue; }
        if (message.type !== "response" || message.id !== "smoke-commands") continue;
        if (!message.success) return finish(new Error(`pi 的 get_commands 失败：${message.error ?? line}`));
        const skills = (message.data?.commands ?? []).filter((command) => command.source === "skill");
        const empty = o.skillDirs.filter((dir) => !skills.some((skill) => skill.sourceInfo?.path?.startsWith(`${dir}/`)));
        if (empty.length) return finish(new Error(`pi 没有从这些目录加载到 skill：${empty.join("、")}`));
        return finish(null, { extensions: o.extensions.map((path) => basename(path)), skills: skills.map((skill) => skill.name) });
      }
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => finish(new Error(`pi 在回答 get_commands 以前退出了（${code ?? signal}）：${stderr.trim()}`)));
    child.stdin.write(`${JSON.stringify({ id: "smoke-commands", type: "get_commands" })}\n`);
  });
}

export interface SmokeOptions {
  runtimeDir: string;
  // 临时目录建在这里，缺省是系统的临时目录。
  workDir?: string;
  timeoutMs?: number;
  // supervisor 和 daemon 停下以后，等它们留下的别的进程退出最多多久（毫秒）。缺省 DRAIN_TIMEOUT_MS。测试用短的。
  drainMs?: number;
  log?: (line: string) => void;
}

export interface SmokeResult {
  ok: true;
  version: string;
  supervisorPid: number;
  daemonPid: number;
  processNames: { supervisor: string; daemon: string };
  piVersion: string;
  /** ops selfcheck 对运行时资源的说明，例如 "8 found in dist"。 */
  runtimeAssets: string;
  piLoad: PiLoadResult;
  statusAfterMs: number;
  stubCalls: string[];
  /** supervisor 和 daemon 停下以后还在跑、等不到它退出、被冒烟杀掉的进程（pid 和命令）。通常是空的。 */
  stragglers: string[];
}

// supervisor 和 daemon 停下以后还在跑的进程（2026-11-11，v1.3.0 的发版）：冒烟的每一项都过了，最后删临时目录时报
// ENOTEMPTY，打包失败、什么都没上传。daemon 被停下的那一刻，它起的子进程（例如探测执行器版本的命令）可能还没跑完，
// 接着往临时的 HOME 或数据目录里写文件，和删目录撞在一起。
// supervisor 是 detached 起的，自己是进程组的组长；daemon 要么在它的组里，要么自己是组长。所以看这两个进程组：
// 先等组里的进程自己退出，等不到就记下它们是谁、整组杀掉。跑到别的进程组里的进程这里看不到，靠下面删目录时的重试。
export const DRAIN_TIMEOUT_MS = 10_000;

/** 这个进程组里还有没有活着的进程。 */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 这些进程组里现在的进程，每个一行：pid 和命令（可执行文件的路径）。 */
async function groupProcesses(pgids: readonly number[]): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,pgid=,comm="], { timeout: 10_000 });
    return stdout.split("\n").map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null && pgids.includes(Number(match[2])))
      .map((match) => `${match[1]} ${match[3]!.trim()}`);
  } catch {
    return [];
  }
}

/** 等这些进程组里的进程都退出。到时限还有的：整组杀掉，返回它们是谁。 */
async function drainGroups(pgids: readonly number[], timeoutMs: number, log: (line: string) => void): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (pgids.some(groupAlive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  if (!pgids.some(groupAlive)) return [];
  const left = await groupProcesses(pgids);
  log(`supervisor 和 daemon 停下以后还有 ${left.length} 个进程在跑，${Math.round(timeoutMs / 1000)} 秒没有退出，杀掉了：${left.join("；") || "（查不到是谁）"}`);
  for (const pgid of pgids) {
    try { process.kill(-pgid, "SIGKILL"); } catch { /* 已经没有了 */ }
  }
  const killedBy = Date.now() + 5_000;
  while (pgids.some(groupAlive) && Date.now() < killedBy) await new Promise((resolve) => setTimeout(resolve, 50));
  return left;
}

/**
 * 删掉冒烟的临时目录。删不干净不算冒烟失败，也不能盖住真正的失败原因：记下原因和还剩什么（下一次能看出是谁在写）。
 * 重试是给刚被杀掉、文件句柄还没放完的进程，和跑到别的进程组里的进程留的。
 */
function removeWorkDir(work: string, log: (line: string) => void): void {
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    let left: string[] = [];
    try { left = readdirSync(work, { recursive: true }).map(String).slice(0, 20); } catch { /* 读不了就不列 */ }
    log(`临时目录 ${work} 没有删干净（${(error as Error).message}）。还剩：${left.join("、") || "（读不出）"}`);
  }
}

export async function smokeRuntime(o: SmokeOptions): Promise<SmokeResult> {
  const log = o.log ?? (() => {});
  const timeoutMs = o.timeoutMs ?? SMOKE_TIMEOUT_MS;
  const runtime = o.runtimeDir;
  const releasePath = join(runtime, RELEASE_FILE);
  if (!existsSync(releasePath)) throw new Error(`${runtime} 不是运行包：没有 ${RELEASE_FILE}`);
  const release = JSON.parse(readFileSync(releasePath, "utf8")) as { product?: string; version?: string };
  if (release.product !== PRODUCT) throw new Error(`${releasePath} 的 product 是 ${release.product}，不是 ${PRODUCT}`);
  const leadAgent = join(runtime, "bin", PROCESS_NAME);
  const supervisorEntry = join(runtime, "apps", "daemon", "dist", "supervisor.mjs");
  for (const path of [leadAgent, supervisorEntry, join(runtime, "bin", "plc"), ...RUNTIME_ASSET_FILES.map((file) => join(runtime, file))]) {
    if (!existsSync(path)) throw new Error(`运行包里缺少 ${path}`);
  }

  const work = mkdtempSync(join(o.workDir ?? tmpdir(), "bl-smoke-"));
  const dirs: SmokeDirs = {
    home: join(work, "home"), dataDir: join(work, "data"), stubBin: join(work, "stub-bin"), stubLog: join(work, "stub-calls.log"),
  };
  let supervisor: ChildProcess | null = null;
  let daemonPid: number | null = null;
  let succeeded = false;
  const supervisorLog = join(work, "supervisor.log");
  try {
    mkdirSync(dirs.home, { recursive: true });
    mkdirSync(dirs.dataDir, { recursive: true, mode: 0o700 });
    writeStubs(dirs);
    const supervisorSock = join(dirs.dataDir, "supervisor.sock");
    if (Buffer.byteLength(supervisorSock) > MAX_SOCKET_PATH_BYTES) {
      throw new Error(`临时数据目录的 socket 路径有 ${Buffer.byteLength(supervisorSock)} 字节，超过 ${MAX_SOCKET_PATH_BYTES}：${supervisorSock}。换一个短一点的临时目录`);
    }
    const env = smokeEnv(process.env, dirs);

    // pi 由 daemon 按 node_modules/.bin/pi 找到；它是 #!/usr/bin/env node 的脚本，这里显式用 lead-agent 运行。
    const pi = await execFileAsync(leadAgent, [join(runtime, "node_modules", ".bin", "pi"), "--version"], { cwd: work, env, timeout: 30_000 });
    const piVersion = `${pi.stdout}${pi.stderr}`.match(/\d+\.\d+\.\d+\S*/)?.[0];
    if (!piVersion) throw new Error(`pi --version 没有输出版本号：${pi.stdout}${pi.stderr}`);
    log(`pi --version：${piVersion}`);
    const runtimeAssets = await runtimeSelfcheck(leadAgent, runtime, env, work);
    log(`ops selfcheck 通过，运行时资源：${runtimeAssets}`);
    // 和 pi 执行器一样的扩展（runtime 的 pi.ts）加上 Lead 的 sol-pi-lead；skill 是执行者的 child-skills 和 Lead 的 skill。
    const asset = (name: keyof typeof RUNTIME_ASSETS) => join(runtime, "apps", "daemon", "dist", ...RUNTIME_ASSETS[name].dist);
    const piLoad = await piLoadsExtensions({
      leadAgent, pi: join(runtime, "node_modules", ".bin", "pi"), cwd: work, env, timeoutMs,
      extensions: Object.entries(RUNTIME_ASSETS).filter(([, entry]) => entry.kind === "extension")
        .map(([name]) => asset(name as keyof typeof RUNTIME_ASSETS)),
      skillDirs: [join(asset("child-skills"), "executor", "skills"), asset("lead-skills")],
    });
    log(`pi 加载了扩展 ${piLoad.extensions.join("、")}，skill ${piLoad.skills.length} 个`);
    await execFileAsync(join(runtime, "bin", "plc"), ["--help"], { cwd: work, env, timeout: 30_000 });
    log("bin/plc --help 正常退出");

    const started = Date.now();
    const out = openSync(supervisorLog, "a");
    try {
      supervisor = spawn(leadAgent, [supervisorEntry], { cwd: runtime, env, stdio: ["ignore", out, out], detached: true });
    } finally {
      closeSync(out);
    }
    const spawned = supervisor;
    const supervisorPid = spawned.pid;
    if (!supervisorPid) throw new Error("supervisor 没有启动");
    const status = await until(timeoutMs, async () => {
      if (spawned.exitCode !== null || spawned.signalCode !== null) {
        throw new Error(`supervisor 退出了（${spawned.exitCode ?? spawned.signalCode}）`);
      }
      const answer = await localRequest(join(dirs.dataDir, "plc.sock"), { type: "status" });
      return answer?.success ? answer.data as { pid?: number } : null;
    }, " plc.sock 回答 status");
    const statusAfterMs = Date.now() - started;
    daemonPid = Number(status.pid) || null;
    if (!daemonPid) throw new Error(`plc.sock 的 status 没有 pid：${JSON.stringify(status)}`);
    log(`plc.sock 在 ${statusAfterMs} 毫秒后回答了 status（daemon pid ${daemonPid}）`);

    const processNames = { supervisor: await processName(supervisorPid), daemon: await processName(daemonPid) };
    for (const [role, name] of Object.entries(processNames)) {
      if (name !== PROCESS_NAME) throw new Error(`${role} 的进程名是 ${name}，不是 ${PROCESS_NAME}`);
    }
    log(`进程名：supervisor=${processNames.supervisor}，daemon=${processNames.daemon}`);

    // 和 launchd 停服务一样发 SIGTERM：supervisor 先停 daemon，再退出（supervisor/src/main.ts 的 stop）。
    spawned.kill("SIGTERM");
    await until(30_000, async () => (spawned.exitCode !== null || spawned.signalCode !== null ? true : null), " supervisor 退出");
    const stoppedDaemon = daemonPid;
    await until(15_000, async () => (alive(stoppedDaemon) ? null : true), " daemon 退出");
    log("supervisor 和 daemon 都已停止");
    const stragglers = await drainGroups([supervisorPid, stoppedDaemon], o.drainMs ?? DRAIN_TIMEOUT_MS, log);

    const stubCalls = readFileSync(dirs.stubLog, "utf8").split("\n").filter(Boolean);
    const writes = keychainWrites(stubCalls);
    if (writes.length) throw new Error(`冒烟进程想往钥匙串里写密钥：${writes.join("；")}`);
    succeeded = true;
    return {
      ok: true, version: release.version ?? "", supervisorPid, daemonPid, processNames, piVersion, runtimeAssets, piLoad, statusAfterMs, stubCalls,
      stragglers,
    };
  } catch (error) {
    const logs = [`--- supervisor 输出（${supervisorLog}）---`, tail(supervisorLog)];
    const logDir = join(dirs.dataDir, "logs");
    if (existsSync(logDir)) {
      for (const file of readdirSync(logDir)) {
        if (statSync(join(logDir, file)).isFile()) logs.push(`--- ${file} ---`, tail(join(logDir, file)));
      }
    }
    throw new Error(`${(error as Error).message}\n${logs.join("\n")}`);
  } finally {
    // 没有正常停下来的进程：整组杀掉，不留在机器上。
    if (supervisor?.pid && supervisor.exitCode === null && supervisor.signalCode === null) {
      try { process.kill(-supervisor.pid, "SIGKILL"); } catch { /* 已经退出 */ }
    }
    // daemon 没回答 status 时，它的 pid 只记在 supervisor 的状态文件里。
    const leftover = daemonPid ?? recordedDaemonPid(dirs.dataDir);
    if (!succeeded && leftover && alive(leftover)) {
      try { process.kill(leftover, "SIGKILL"); } catch { /* 已经退出 */ }
    }
    // 失败的冒烟里它们留下的别的进程：整组杀掉（成功的冒烟上面已经等过、杀过了）。
    for (const pgid of [supervisor?.pid, leftover]) {
      if (!succeeded && pgid && groupAlive(pgid)) {
        try { process.kill(-pgid, "SIGKILL"); } catch { /* 已经没有了 */ }
      }
    }
    removeWorkDir(work, log);
  }
}
