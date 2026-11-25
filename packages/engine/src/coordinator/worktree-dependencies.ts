// 建隔离 worktree 时准备好依赖（lead-tools-and-routing spec D15，#137 第 6 条）。新建的 worktree 没有 node_modules：
// #125 的执行者装不了依赖，类型检查和测试一次都没跑。现在系统在建好 worktree 以后在后台准备依赖（执行者不等它，见下）：
// pnpm 的仓库先用 pnpm 按 lockfile 装（pnpmInstall，2026-10-29）；别的、或者装不上时，把用户 checkout 里的 node_modules
// 按原样克隆过去（macOS 用 APFS 的 clonefile，cp -c；Linux 用 cp --reflink=auto）。
//
// 为什么克隆、不建符号链接：node_modules 里工作区包的链接是相对路径（@pi-lead-child/engine -> ../../packages/engine）。
// 克隆过去以后它们指向 worktree 自己的包；链接到用户 checkout 的 node_modules 则会让测试跑用户 checkout 的代码。
// 另外一个指向目录的符号链接不被 `node_modules/` 这条忽略规则覆盖，曾经被提交进 master（fbb54a7b）。
//
// bun 的仓库（有 bun.lock 或 bun.lockb）同样先用 bun install --frozen-lockfile 装（2026-11-25）：#465 给一个 bun 仓库建
// worktree，克隆 node_modules/.bun 跑了 6 分钟以上还没完，执行者一直在等。bun 有全局缓存，通常快得多；装不上时回到克隆。
//
// npm 的仓库（有 package-lock.json）在 pnpm、bun 之后、克隆之前用 npm ci 装（npmInstall，#493）：#473 一次拷 3 份 node_modules
// 花了约 11 分钟（本机有杀毒软件，拷大量小文件很慢）。命令是 npm ci --prefer-offline --ignore-scripts --no-audit --no-fund，
// 10 分钟超时。npm workspaces 的单仓只在根目录跑一次：npm ci 把依赖提升到根 node_modules，工作区包的链接也由它建，
// 装好就返回，不再对子包克隆。找不到 npm（daemon 的 PATH 来自 launchd）、npm ci 失败或超时，就回到克隆，
// 并把原因写进结果的 fallbackReason（状态文件和活动记录里能看到）。
//
// 执行者不等依赖（2026-11-25）：建好 worktree 就启动，依赖在后台准备。准备做完时写一个状态文件（worktree 的 git 目录里，
// 不在工作区里，不会进提交），提示里给执行者一条等它的命令；准备还在做时也可以查 peekWorktreeDependencies。
//
// 克隆在后台异步做：大仓库在本机要几分钟（有 Sophos 时更久），同步做会卡住 daemon（2026-10-14 的停摆）。
// 只克隆 git 忽略的 node_modules；克隆失败不影响 Run，执行者可以在沙箱里自己装。
import { spawn } from "node:child_process";
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface DependencyPreparation {
  // 克隆过去的 node_modules（相对仓库根目录）。
  cloned: string[];
  // 没有做的原因（不是 Node 项目、已经有依赖、这个系统不支持写时复制……）。做了时为 null。
  skipped: string | null;
  // 出错时的原因。
  error: string | null;
  // 用包管理器装的（例如 pnpm install），没有克隆时写明。克隆的为 undefined。
  installedWith?: string;
  // 先试了包管理器、没成功才回到克隆（或没有可克隆的）时，写明为什么没成功。目前只有 npm 这条路径会写。
  fallbackReason?: string;
}

const pending = new Map<string, Promise<DependencyPreparation>>();
// 已经做完的准备结果（同一个 daemon 进程里）。提示要写依赖现在是什么状态时查它。
const settled = new Map<string, DependencyPreparation>();

/** 状态文件的名字：放在 worktree 的 git 目录里，执行者用 `git rev-parse --git-path` 找到它。 */
export const DEPENDENCY_STATUS_FILE = "plc-deps-status";

// 不往下找的目录：依赖本身、git 的数据、plc 的 worktree 目录。
const SKIP_DIRS = new Set(["node_modules", ".git", ".pi-sessions", "dist", "build", ".next", ".turbo", ".cache"]);

/**
 * 仓库里的 node_modules 目录（相对 root），最多往下找 maxDepth 层。异步读目录：用户的 checkout 目录很多时，
 * 以前同步遍历会占住 daemon 的主线程（2026-11-03）。
 */
export async function findNodeModulesDirs(root: string, maxDepth = 3): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name === "node_modules") {
        found.push(relative(root, path));
        continue;
      }
      if (depth >= maxDepth || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".") || entry.name.endsWith(".plc-workspaces")) continue;
      await walk(path, depth + 1);
    }
  };
  await walk(root, 0);
  return found.sort();
}

function run(
  command: string, args: string[], cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], ...(env ? { env } : {}) });
    let output = "";
    let timedOut = false;
    child.stdout?.on("data", (data: Buffer) => { output += data.toString(); });
    child.stderr?.on("data", (data: Buffer) => { output += data.toString(); });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ code: null, output: error.message, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output: output.slice(-2_000), timedOut });
    });
  });
}

function cloneArgs(source: string, target: string): { command: string; args: string[] } | null {
  if (process.platform === "darwin") return { command: "cp", args: ["-cR", source, target] };
  if (process.platform === "linux") return { command: "cp", args: ["-R", "--reflink=auto", source, target] };
  return null;
}

// pnpm 的可执行文件：daemon 的 PATH 是 launchd 给的，常常没有用户装的 pnpm（~/Library/pnpm）。找不到时为 null。
function pnpmBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    env.PNPM_HOME ? join(env.PNPM_HOME, "pnpm") : null,
    env.HOME ? join(env.HOME, "Library", "pnpm", "pnpm") : null,
    ...(env.PATH ?? "").split(":").filter(Boolean).map((dir) => join(dir, "pnpm")),
  ].filter((path): path is string => Boolean(path));
  return candidates.find((path) => existsSync(path)) ?? null;
}

// pnpm 的仓库先用 pnpm 装（2026-10-29）：一个大的前端仓库 的 node_modules 有十几万个文件，开着 Sophos 克隆了 19 分钟，
// Run #185 一直停在启动前，被当成卡死停掉；克隆来的还是用户 checkout 那个分支的依赖，执行者又自己装了一遍。
// pnpm 按 lockfile 从本机的仓库硬链接，通常一两分钟。daemon 在沙箱外装，能写 pnpm 的仓库、能用 .npmrc 的凭证。
// --ignore-scripts：依赖的安装脚本不在沙箱外跑；要跑时执行者在沙箱里 pnpm rebuild。装不上时回到克隆。
async function pnpmInstall(worktree: string): Promise<DependencyPreparation | null> {
  if (!existsSync(join(worktree, "pnpm-lock.yaml"))) return null;
  const pnpm = pnpmBinary();
  if (!pnpm) return null;
  const result = await run(pnpm, ["install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts", "--reporter=silent"], worktree, 10 * 60_000);
  if (result.code !== 0) return null;
  return { cloned: [], skipped: null, error: null, installedWith: "pnpm install --frozen-lockfile --prefer-offline --ignore-scripts" };
}

// bun 的可执行文件：和 pnpm 一样，daemon 的 PATH 常常没有用户装的 bun（~/.bun/bin）。找不到时为 null。
function bunBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    env.BUN_INSTALL ? join(env.BUN_INSTALL, "bin", "bun") : null,
    env.HOME ? join(env.HOME, ".bun", "bin", "bun") : null,
    ...(env.PATH ?? "").split(":").filter(Boolean).map((dir) => join(dir, "bun")),
  ].filter((path): path is string => Boolean(path));
  return candidates.find((path) => existsSync(path)) ?? null;
}

// bun 的仓库用 bun 装（2026-11-25）：见文件开头。--ignore-scripts 的理由和 pnpm 一样（daemon 在沙箱外装）。
// 装不上（没有 bun、退出码不是 0、超时）时返回 null，调用方回到克隆；先删掉装了一半的 node_modules，不然克隆会跳过它们。
async function bunInstall(worktree: string): Promise<DependencyPreparation | null> {
  if (!existsSync(join(worktree, "bun.lock")) && !existsSync(join(worktree, "bun.lockb"))) return null;
  const bun = bunBinary();
  if (!bun) return null;
  const result = await run(bun, ["install", "--frozen-lockfile", "--ignore-scripts"], worktree, 10 * 60_000);
  if (result.code === 0) return { cloned: [], skipped: null, error: null, installedWith: "bun install --frozen-lockfile --ignore-scripts" };
  await removeInstalledNodeModules(worktree);
  return null;
}

// 装了一半的 node_modules 要删掉，不然克隆会因为目标已存在而跳过它们。只删 git 忽略的：装出来的 node_modules 是忽略的，别的东西不碰。
async function removeInstalledNodeModules(worktree: string): Promise<void> {
  for (const dir of await findNodeModulesDirs(worktree)) {
    const ignored = await run("git", ["-C", worktree, "check-ignore", "-q", dir], worktree, 30_000);
    if (ignored.code === 0) await rm(join(worktree, dir), { recursive: true, force: true });
  }
}

// 系统里装 npm 的固定位置：Homebrew（Apple 芯片、Intel）。测试可以换掉它，免得测到本机真装的 npm。
const DEFAULT_SYSTEM_NPM_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];
let systemNpmDirs = DEFAULT_SYSTEM_NPM_DIRS;

/** 测试用：换掉固定的 npm 目录（不传就恢复）。 */
export function setNpmSystemDirsForTests(dirs?: string[]): void {
  systemNpmDirs = dirs ?? DEFAULT_SYSTEM_NPM_DIRS;
}

function versionParts(name: string): number[] {
  return name.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
}

// nvm 装的 node 版本目录，新的在前。
function nvmNodeBinDirs(env: NodeJS.ProcessEnv): string[] {
  const root = env.NVM_DIR ?? (env.HOME ? join(env.HOME, ".nvm") : null);
  if (!root) return [];
  try {
    return readdirSync(join(root, "versions", "node"))
      .sort((a, b) => {
        const [pa, pb] = [versionParts(a), versionParts(b)];
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
          if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
        }
        return 0;
      })
      .map((version) => join(root, "versions", "node", version, "bin"));
  } catch {
    return [];
  }
}

// npm 的可执行文件：daemon 的 PATH 是 launchd 给的，常常没有用户装的 node 和 npm。按这个顺序找：PATH、当前 nvm 的 NVM_BIN、
// nvm 装的各版本、volta、Homebrew。找不到时为 null。
function npmBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = [
    ...(env.PATH ?? "").split(":").filter(Boolean),
    ...(env.NVM_BIN ? [env.NVM_BIN] : []),
    ...nvmNodeBinDirs(env),
    ...(env.VOLTA_HOME ? [join(env.VOLTA_HOME, "bin")] : env.HOME ? [join(env.HOME, ".volta", "bin")] : []),
    ...systemNpmDirs,
  ];
  for (const dir of dirs) {
    const path = join(dir, "npm");
    if (existsSync(path)) return path;
  }
  return null;
}

// 原因写进一行状态文件，所以压成一行、截短。
function oneLine(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `...${flat.slice(-max)}` : flat;
}

/**
 * npm 的仓库用 npm ci 装（#493）：见文件开头。返回 { installed }：装好了；{ fallback }：该用 npm 但没成功，附原因，调用方回到克隆；
 * null：不是 npm 的仓库（没有 package-lock.json）。
 * npm 是 `#!/usr/bin/env node` 的脚本：daemon 的 PATH 里没有 node 时它自己跑不起来，所以把 npm 所在的目录放到 PATH 最前面
 * （nvm、volta、Homebrew 里 node 和 npm 在同一个目录）。
 */
async function npmInstall(worktree: string): Promise<{ installed: DependencyPreparation } | { fallback: string } | null> {
  if (!existsSync(join(worktree, "package-lock.json"))) return null;
  const npm = npmBinary();
  if (!npm) return { fallback: "找不到 npm（daemon 的 PATH 里没有，nvm、volta、Homebrew 的常见位置也没有）" };
  const timeoutMs = 10 * 60_000;
  const env = { ...process.env, PATH: [dirname(npm), process.env.PATH].filter(Boolean).join(":") };
  const result = await run(npm, ["ci", "--prefer-offline", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], worktree, timeoutMs, env);
  if (result.code === 0) {
    return { installed: { cloned: [], skipped: null, error: null, installedWith: "npm ci --prefer-offline --ignore-scripts --no-audit --no-fund" } };
  }
  await removeInstalledNodeModules(worktree);
  if (result.timedOut) return { fallback: `npm ci 超过 ${timeoutMs / 60_000} 分钟，已停掉` };
  return { fallback: `npm ci 失败：${oneLine(result.output) || `退出码 ${result.code}`}` };
}

async function prepare(source: string, worktree: string): Promise<DependencyPreparation> {
  if (!existsSync(join(worktree, "package.json"))) return { cloned: [], skipped: "不是 Node 项目（没有 package.json）", error: null };
  if (existsSync(join(worktree, "node_modules"))) return { cloned: [], skipped: "worktree 里已经有 node_modules", error: null };
  const installed = await pnpmInstall(worktree);
  if (installed) return installed;
  const bunInstalled = await bunInstall(worktree);
  if (bunInstalled) return bunInstalled;
  const npmResult = await npmInstall(worktree);
  if (npmResult && "installed" in npmResult) return npmResult.installed;
  const because = npmResult ? { fallbackReason: npmResult.fallback } : {};
  const dirs = (await findNodeModulesDirs(source)).filter((dir) => existsSync(join(worktree, dirname(dir), "package.json")));
  if (!dirs.length) return { cloned: [], skipped: "用户的 checkout 里没有装好的依赖", error: null, ...because };
  const cloned: string[] = [];
  for (const dir of dirs) {
    const target = join(worktree, dir);
    if (existsSync(target)) continue;
    // 只克隆 git 忽略的路径：克隆出来的东西不能进提交。
    const ignored = await run("git", ["-C", worktree, "check-ignore", "-q", dir], worktree, 30_000);
    if (ignored.code !== 0) continue;
    const clone = cloneArgs(join(source, dir), target);
    if (!clone) return { cloned, skipped: `这个系统（${process.platform}）不支持写时复制的克隆`, error: null, ...because };
    const result = await run(clone.command, clone.args, worktree, 20 * 60_000);
    if (result.code !== 0) return { cloned, skipped: null, error: `克隆 ${dir} 失败：${result.output.trim() || `退出码 ${result.code}`}`, ...because };
    cloned.push(dir);
  }
  return { cloned, skipped: null, error: null, ...because };
}

function statusLine(result: DependencyPreparation): string {
  const because = result.fallbackReason ? ` (installing with npm did not work: ${oneLine(result.fallbackReason)})` : "";
  if (result.error) return `failed: ${result.error}${because}`;
  if (result.installedWith) return `ready: installed with ${result.installedWith}`;
  if (result.cloned.length) return `ready: cloned ${result.cloned.join(", ")} from the user's checkout${because}`;
  return `none: ${result.skipped ?? "nothing to prepare"}${because}`;
}

// 准备做完时写状态文件；开始时先删掉旧的（同一个 worktree 再准备一次时，不能让执行者读到上一次的结果）。
async function statusFilePath(worktree: string): Promise<string | null> {
  const dir = await run("git", ["-C", worktree, "rev-parse", "--absolute-git-dir"], worktree, 30_000);
  return dir.code === 0 && dir.output.trim() ? join(dir.output.trim(), DEPENDENCY_STATUS_FILE) : null;
}

/**
 * 在后台开始准备一个 worktree 的依赖（source 是用户的 checkout）。同一个 worktree 只做一次。
 * onDone 在做完时调用（记活动、打日志），它出错不影响结果。
 */
export function startWorktreeDependencies(
  source: string, worktree: string, onDone?: (result: DependencyPreparation) => void,
): Promise<DependencyPreparation> {
  const key = resolve(worktree);
  const existing = pending.get(key);
  if (existing) return existing;
  settled.delete(key);
  const statusPath = statusFilePath(key);
  const promise = statusPath
    .then((path) => (path ? rm(path, { force: true }) : undefined))
    .catch(() => undefined)
    .then(() => prepare(resolve(source), key))
    .catch((error: unknown): DependencyPreparation => ({
      cloned: [], skipped: null, error: error instanceof Error ? error.message : String(error),
    }))
    .then(async (result) => {
      settled.set(key, result);
      try {
        const path = await statusPath;
        if (path) await writeFile(path, `${statusLine(result)}\n`);
      } catch {
        // 写不了状态文件时，执行者的等待命令会超时，然后自己装。
      }
      try {
        onDone?.(result);
      } catch {
        // 记录失败不影响依赖本身。
      }
      return result;
    });
  pending.set(key, promise);
  return promise;
}

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export type WorktreeDependencyState =
  | { state: "preparing" }
  | { state: "done"; result: DependencyPreparation };

/** 工作目录所在 worktree 的依赖现在是什么状态（不等）。这个 daemon 没有准备过它时返回 null。 */
export function peekWorktreeDependencies(workdir: string): WorktreeDependencyState | null {
  const target = resolve(workdir);
  for (const [worktree] of pending) {
    if (!within(target, worktree)) continue;
    const result = settled.get(worktree);
    return result ? { state: "done", result } : { state: "preparing" };
  }
  return null;
}

/**
 * 等工作目录所在 worktree 的依赖准备完（工作目录可以是 worktree 里的子目录）。执行者启动不再用它（2026-11-25，见文件开头）；
 * 要等结果的调用方和测试用。没有在准备的时返回 null。等太久（timeoutMs）时返回 null。
 */
export async function awaitWorktreeDependencies(workdir: string, timeoutMs = 20 * 60_000): Promise<DependencyPreparation | null> {
  const target = resolve(workdir);
  for (const [worktree, promise] of pending) {
    if (!within(target, worktree)) continue;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolvePromise) => { timer = setTimeout(() => resolvePromise(null), timeoutMs); });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return null;
}

/** 测试用：忘掉记下的准备。 */
export function forgetWorktreeDependenciesForTests(): void {
  pending.clear();
  settled.clear();
}
