// 部署闸门（2026-10-19 用户决定）：只部署已提交的代码。
// supervisor 重启时运行主 checkout 里 apps/daemon/dist 的构建产物。#89、#92、#93、#95 的 child 直接在主 checkout 里
// 改代码、构建，Lead 随后请求重启，没有提交过的代码就上线了。现在：
//   · 构建时（apps/daemon/scripts/build.ts）在 dist 里写 build-info.json：从哪个 commit 构建、构建时源码有没有改动；
//   · supervisor 的维护入口（每条重启路径：Lead 的 request_runtime_maintenance、换 Lead 模型后的重启、
//     plc daemon restart/upgrade）检查下面几件事，有一件不满足就拒绝，并说明原因：
//     主 checkout 没有没提交的改动；dist 是从一个已提交、构建时没有改动、在当前分支历史里的 commit 构建的。
//     崩溃后的自动拉起不拦截，只记警告（supervisor 的 spawnDaemon）。
//   · 主 checkout 干净，dist 却没有构建记录、构建时有改动，或者构建的 commit 是 HEAD 的祖先、HEAD 已经往前走了
//     （2026-11-02：修复合并后重启，跑的还是旧 dist）：维护在停机之前先从 HEAD 构建（buildDaemonDist），构建失败就不停机。
//     dist 来自别的分支、commit 不在仓库里、git 说不清的，照旧拒绝，不自动构建。
// 「没提交的改动」只看会进构建的代码：packages/、apps/ 下的改动和没被忽略的新文件，以及仓库根目录下的文件
// （package.json、package-lock.json、tsconfig.json 这类）。不算的：docs/、artifacts/、.scratch/、.claude/（它们不进 dist，
// 而且有的测试会改写 artifacts/ 里的证据文件），以及测试文件（test/ 目录下的、*.test.* 和 *.spec.*）。
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const BUILD_INFO_FILE = "build-info.json";

export interface BuildProvenance {
  version: 1;
  commit: string;
  // 构建时源码有没有没提交的改动。为 true 的构建不能部署。
  dirty: boolean;
  dirtyFiles: string[];
  builtAt: string;
}

export interface DeployReadiness {
  ready: boolean;
  // 不能部署的原因，每条一句。ready 时为空。
  reasons: string[];
  head: string | null;
  build: BuildProvenance | null;
  // 主 checkout 干净，dist 没有构建记录、构建时有改动，或者落后于 HEAD（构建的 commit 是 HEAD 的祖先）：
  // 维护会先从 HEAD 重新构建。不是拒绝。
  rebuild: boolean;
}

const SOURCE_DIRS = ["packages/", "apps/"];
const TEST_DIRS = new Set(["test", "tests", "__tests__"]);

// 测试文件不进 dist：只改了测试的 checkout 照样可以部署。
function isTestFile(path: string): boolean {
  if (path.split("/").slice(0, -1).some((segment) => TEST_DIRS.has(segment))) return true;
  const name = basename(path);
  return name.includes(".test.") || name.includes(".spec.");
}

// 跑一条 git 命令，返回 stdout。可注入，测试用它模拟超时。
export type GitExec = (root: string, args: string[], timeoutMs: number) => string;
const GIT_TIMEOUT_MS = 10_000;

const execGit: GitExec = (root, args, timeoutMs) => execFileSync("git", ["-C", root, ...args], {
  encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"],
});

function gitRaw(root: string, args: string[], exec = execGit, timeoutMs = GIT_TIMEOUT_MS): string {
  return exec(root, args, timeoutMs);
}

function git(root: string, args: string[], exec = execGit, timeoutMs = GIT_TIMEOUT_MS): string {
  return gitRaw(root, args, exec, timeoutMs).trim();
}

// git 失败属于哪一类。闸门只在 git 明确回答了的时候才下结论：
//   · timeout / killed：execFileSync 超时（code ETIMEDOUT）或者 git 被信号杀掉（status 为 null）。git 没有回答，什么都不能说；
//   · missing：退出码 128，stderr 是 Not a valid object name（cat-file -e 找不到这个对象）；
//   · not_ancestor：退出码 1（merge-base --is-ancestor 的「不是祖先」）；
//   · other：别的错误，原样报出来。
export type GitFailureKind = "timeout" | "killed" | "missing" | "not_ancestor" | "other";
export function gitFailureKind(error: unknown): GitFailureKind {
  if (!error || typeof error !== "object") return "other";
  const e = error as { code?: unknown; status?: unknown; signal?: unknown; stderr?: unknown };
  if (e.code === "ETIMEDOUT") return "timeout";
  if (e.status === null && e.signal) return "killed";
  if (e.status === 128 && /Not a valid object name/.test(String(e.stderr ?? ""))) return "missing";
  if (e.status === 1) return "not_ancestor";
  return "other";
}

// 「无法判断」的原因，接在提示后面的括号里。
function gitFailureNote(kind: GitFailureKind, error: unknown): string {
  if (kind === "timeout") return "git 超时";
  if (kind === "killed") return `git 被 ${String((error as { signal?: unknown }).signal)} 终止`;
  return `git 出错：${error instanceof Error ? error.message : String(error)}`;
}

/** 主 checkout 里没提交的改动（按上面的口径），最多列 limit 个。 */
export function uncommittedSourceChanges(root: string, limit = 20, exec = execGit, timeoutMs = GIT_TIMEOUT_MS): string[] {
  // 不能 trim：porcelain 每行的前两个字符是状态，第一个可能是空格。
  const lines = gitRaw(root, ["status", "--porcelain", "--untracked-files=all"], exec, timeoutMs).split("\n").filter(Boolean);
  const changed = lines.filter((line) => {
    // 改名写成「旧 -> 新」，两边都算。
    const paths = line.slice(3).split(" -> ").map((path) => path.replace(/^"|"$/g, ""));
    return paths.some((path) => !isTestFile(path) && (SOURCE_DIRS.some((dir) => path.startsWith(dir))
      || (!line.startsWith("??") && !path.includes("/"))));
  });
  return changed.slice(0, limit).map((line) => line.slice(3));
}

export function headCommit(root: string): string {
  return git(root, ["rev-parse", "HEAD"]);
}

export function buildProvenance(root: string, now = new Date()): BuildProvenance {
  const dirtyFiles = uncommittedSourceChanges(root);
  return { version: 1, commit: git(root, ["rev-parse", "HEAD"]), dirty: dirtyFiles.length > 0, dirtyFiles, builtAt: now.toISOString() };
}

/** 构建开始时调用：构建中途失败时，dist 里不能留着上一次构建的记录，否则闸门会把半新半旧的 dist 当成干净的。 */
export function clearBuildProvenance(distDir: string): void {
  rmSync(join(distDir, BUILD_INFO_FILE), { force: true });
}

/** startCommit：构建开始时的 HEAD。构建期间 HEAD 变了，dist 里可能混着两个 commit 的代码，按有改动记。 */
export function writeBuildProvenance(root: string, distDir: string, startCommit?: string): BuildProvenance {
  const provenance = buildProvenance(root);
  if (startCommit && startCommit !== provenance.commit) {
    provenance.dirty = true;
    provenance.dirtyFiles = [...provenance.dirtyFiles, `HEAD 在构建期间从 ${startCommit} 变成了 ${provenance.commit}`];
  }
  const path = join(distDir, BUILD_INFO_FILE);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(provenance, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
  return provenance;
}

export function readBuildProvenance(distDir: string): BuildProvenance | null {
  const path = join(distDir, BUILD_INFO_FILE);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<BuildProvenance>;
    if (value.version !== 1 || typeof value.commit !== "string" || typeof value.dirty !== "boolean") return null;
    return { version: 1, commit: value.commit, dirty: value.dirty, dirtyFiles: value.dirtyFiles ?? [], builtAt: value.builtAt ?? "" };
  } catch {
    return null;
  }
}

export interface DeployReadinessOptions {
  execGit?: GitExec;
  // 每条 git 命令最多等多久。默认 10 秒。
  timeoutMs?: number;
}

/** 现在能不能从 root 的 dist 部署。只读：不改 checkout，不构建。 */
export function deployReadiness(root: string, distDir: string, options: DeployReadinessOptions = {}): DeployReadiness {
  const exec = options.execGit ?? execGit;
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const run = (args: string[]) => git(root, args, exec, timeoutMs);
  const reasons: string[] = [];
  let head: string | null = null;
  let clean = false;
  try {
    head = run(["rev-parse", "HEAD"]);
    const changes = uncommittedSourceChanges(root, 20, exec, timeoutMs);
    if (changes.length) {
      reasons.push(`主 checkout ${root} 有没提交的改动：${changes.join("、")}。先提交（或者撤销）这些改动，再重新构建。`);
    } else {
      clean = true;
    }
  } catch (error) {
    reasons.push(`读不了主 checkout ${root} 的 git 状态：${error instanceof Error ? error.message : String(error)}`);
  }
  const build = readBuildProvenance(distDir);
  // git 明确回答了：dist 的 commit 在仓库里，并且是 HEAD 的祖先（或者就是 HEAD）。
  let inHistory = false;
  if (!build) {
    reasons.push(`${join(distDir, BUILD_INFO_FILE)} 不存在：无法确认 dist 来自哪个 commit。在干净的 checkout 上重新运行 npm run build。`);
  } else {
    if (build.dirty) {
      reasons.push(`dist 构建时源码有没提交的改动（${build.dirtyFiles.join("、") || "未列出"}），不是从一个已提交的 commit 构建的。提交以后重新构建。`);
    }
    // 只有 git 明确说「没有这个对象」「不是祖先」时才报那两句；超时等情况报「无法判断」，照样拒绝部署。
    try {
      run(["cat-file", "-e", `${build.commit}^{commit}`]);
      try {
        run(["merge-base", "--is-ancestor", build.commit, "HEAD"]);
        inHistory = true;
      } catch (error) {
        const kind = gitFailureKind(error);
        reasons.push(kind === "not_ancestor"
          ? `dist 的构建 commit ${build.commit} 不在主 checkout 当前分支的历史里（HEAD 是 ${head ?? "未知"}）。在当前分支上重新构建。`
          : `无法判断 dist 的构建 commit ${build.commit} 是否在主 checkout 当前分支的历史里（${gitFailureNote(kind, error)}）。先不部署，稍后再试。`);
      }
    } catch (error) {
      const kind = gitFailureKind(error);
      reasons.push(kind === "missing"
        ? `dist 的构建 commit ${build.commit} 不在这个仓库里。`
        : `无法判断 dist 的构建 commit ${build.commit} 是否在这个仓库里（${gitFailureNote(kind, error)}）。先不部署，稍后再试。`);
    }
  }
  const rebuild = clean && head !== null && (!build || (inHistory && (build.dirty || build.commit !== head)));
  return { ready: reasons.length === 0, reasons, head, build, rebuild };
}

const BUILD_TIMEOUT_MS = 5 * 60_000;
const BUILD_KILL_GRACE_MS = 10_000;
const BUILD_OUTPUT_KEPT = 4_096;
// 构建只拿这几个环境变量：supervisor 的环境里有从钥匙串和 config.json 读进来的密钥（main.ts），构建用不着。
const BUILD_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "USER", "LANG"];

/**
 * 从 root 当前的 checkout 构建 plc 的 cli 和 daemon 的 dist（等于 npm run build，daemon 最后，它写构建记录）。
 * 失败时 reject，带上输出的最后几行。每一步到时先 SIGTERM，killGraceMs 后 SIGKILL，无论如何都会结束。
 */
export async function buildDaemonDist(root: string, timeoutMs = BUILD_TIMEOUT_MS, killGraceMs = BUILD_KILL_GRACE_MS): Promise<void> {
  for (const app of ["cli", "daemon"]) await runBuildScript(join(root, "apps", app), app, timeoutMs, killGraceMs);
}

function runBuildScript(cwd: string, app: string, timeoutMs: number, killGraceMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(BUILD_ENV_KEYS.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])));
    // 不用 tsx 命令行：它要开一个 IPC socket，沙箱里 listen 会 EPERM。
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/build.ts"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const keep = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-BUILD_OUTPUT_KEPT); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    timers.push(setTimeout(() => child.kill("SIGTERM"), timeoutMs));
    timers.push(setTimeout(() => child.kill("SIGKILL"), timeoutMs + killGraceMs));
    // SIGKILL 以后 close 还没来（例如别的进程还占着输出管道）：也结束，不让维护一直卡着。
    timers.push(setTimeout(() => settle(new Error(`apps/${app} 构建超过时限 ${timeoutMs}ms，SIGKILL 以后还没结束`)), timeoutMs + 2 * killGraceMs));
    child.once("error", (error) => settle(error));
    child.once("close", (code, signal) => {
      if (code === 0) return settle();
      const tail = output.split("\n").map((line) => line.trim()).filter(Boolean).slice(-5).join(" | ");
      const how = signal ? `被 ${signal} 终止（时限 ${timeoutMs}ms）` : `退出码 ${code}`;
      settle(new Error(`apps/${app} 构建${how}${tail ? `：${tail}` : ""}`));
    });
  });
}
