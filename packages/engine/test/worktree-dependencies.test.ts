// 建隔离 worktree 时准备依赖（lead-tools-and-routing spec D15，#137 第 6 条）：真的 git 仓库、真的 worktree、真的克隆。
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  awaitWorktreeDependencies, DEPENDENCY_STATUS_FILE, findNodeModulesDirs, forgetWorktreeDependenciesForTests,
  peekWorktreeDependencies, setNpmSystemDirsForTests, startWorktreeDependencies,
} from "../src/coordinator/worktree-dependencies.js";

const supported = process.platform === "darwin" || process.platform === "linux";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// 一个像这个仓库的 Node 单仓：根目录和一个工作区包各有 node_modules，工作区包的链接是相对路径。
function monorepo(): { repo: string; worktree: string } {
  const base = tempDir("plc-deps-");
  const repo = join(base, "repo");
  mkdirSync(join(repo, "packages", "lib", "src"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
  writeFileSync(join(repo, "packages", "lib", "package.json"), JSON.stringify({ name: "lib" }));
  writeFileSync(join(repo, "packages", "lib", "src", "index.js"), "export const where = 'repo';\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  git(base, "init", "-q", repo);
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  mkdirSync(join(repo, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  symlinkSync("../packages/lib", join(repo, "node_modules", "lib"));
  mkdirSync(join(repo, "packages", "lib", "node_modules", "dep"), { recursive: true });
  writeFileSync(join(repo, "packages", "lib", "node_modules", "dep", "index.js"), "module.exports = 2;\n");
  const worktree = join(base, "repo.plc-workspaces", "item-1");
  mkdirSync(join(base, "repo.plc-workspaces"));
  git(repo, "worktree", "add", "-q", "-b", "plc/item-1", worktree, "HEAD");
  return { repo, worktree };
}

afterEach(() => forgetWorktreeDependenciesForTests());

describe("findNodeModulesDirs", () => {
  it("finds the root and workspace packages' node_modules, not nested ones", async () => {
    const { repo } = monorepo();
    expect(await findNodeModulesDirs(repo)).toEqual(["node_modules", join("packages", "lib", "node_modules")]);
  });
});

describe.runIf(supported)("startWorktreeDependencies", () => {
  it("clones the user's installed dependencies into a new worktree, keeping workspace links pointing at the worktree", async () => {
    const { repo, worktree } = monorepo();
    const seen: unknown[] = [];
    void startWorktreeDependencies(repo, worktree, (result) => seen.push(result));
    // 执行者从 worktree 里的子目录启动，也要等到。
    const result = await awaitWorktreeDependencies(join(worktree, "packages", "lib"));
    expect(result).toEqual({ cloned: ["node_modules", join("packages", "lib", "node_modules")], skipped: null, error: null });
    expect(seen).toEqual([result]);
    expect(readFileSync(join(worktree, "node_modules", "left-pad", "index.js"), "utf8")).toContain("1");
    // 工作区包的链接还是相对路径，指向 worktree 自己的包，不是用户 checkout 的。
    expect(lstatSync(join(worktree, "node_modules", "lib")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(worktree, "node_modules", "lib"))).toBe("../packages/lib");
    // 克隆出来的东西被 git 忽略，不会进提交。
    expect(git(worktree, "status", "--porcelain")).toBe("");
  }, 60_000);

  it("skips a worktree that is not a Node project or already has dependencies", async () => {
    const { repo, worktree } = monorepo();
    mkdirSync(join(worktree, "node_modules"));
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result.cloned).toEqual([]);
    expect(result.skipped).toMatch(/已经有 node_modules/);
    expect(await awaitWorktreeDependencies(tempDir("plc-deps-other-"))).toBeNull();
  }, 60_000);

  it("does not clone a node_modules that git would not ignore", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, ".gitignore"), "\n");
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result.cloned).toEqual([]);
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
  }, 60_000);
});

// 2026-10-29：#185 克隆 一个大的前端仓库 的 node_modules 用了 19 分钟，被当成卡死停掉。pnpm 的仓库先用 pnpm 按 lockfile 装。
const pnpm = [process.env.HOME ? join(process.env.HOME, "Library", "pnpm", "pnpm") : "", ...(process.env.PATH ?? "").split(":").map((dir) => join(dir, "pnpm"))]
  .find((path) => path && existsSync(path));
describe.runIf(Boolean(pnpm))("startWorktreeDependencies in a pnpm repository", () => {
  it("installs with pnpm from the lockfile instead of cloning the user's node_modules", async () => {
    const source = tempDir("plc-deps-pnpm-source-");
    const worktree = tempDir("plc-deps-pnpm-worktree-");
    for (const dir of [source, worktree]) {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0", private: true }));
      writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n");
    }
    mkdirSync(join(source, "node_modules", "from-user-checkout"), { recursive: true });
    const result = await startWorktreeDependencies(source, worktree);
    expect(result).toMatchObject({ cloned: [], error: null, installedWith: expect.stringContaining("pnpm install --frozen-lockfile") });
    expect(existsSync(join(worktree, "node_modules", "from-user-checkout"))).toBe(false);
  }, 120_000);
});

// 2026-11-25：#465 给一个 bun 仓库建 worktree，克隆 node_modules/.bun 跑了 6 分钟以上。bun 的仓库先用 bun install 装，装不上再克隆。
// 用一个假的 bun（脚本）代替真的：它记下参数，按退出码和是否留下装了一半的 node_modules 表现。
function fakeBun(body: string): string {
  const home = tempDir("plc-deps-bun-home-");
  mkdirSync(join(home, "bin"));
  const script = join(home, "bin", "bun");
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, 0o755);
  return home;
}

describe.runIf(supported)("startWorktreeDependencies in a bun repository", () => {
  const savedBunInstall = process.env.BUN_INSTALL;
  afterEach(() => {
    if (savedBunInstall === undefined) delete process.env.BUN_INSTALL;
    else process.env.BUN_INSTALL = savedBunInstall;
  });

  it("installs with bun install --frozen-lockfile instead of cloning the user's node_modules", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "bun.lock"), "{}\n");
    const argsFile = join(tempDir("plc-deps-bun-args-"), "args");
    process.env.BUN_INSTALL = fakeBun(`echo "$@" > ${argsFile}\nmkdir -p node_modules/from-bun`);
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toMatchObject({ cloned: [], error: null, installedWith: expect.stringContaining("bun install --frozen-lockfile") });
    expect(readFileSync(argsFile, "utf8")).toContain("install --frozen-lockfile");
    expect(existsSync(join(worktree, "node_modules", "from-bun"))).toBe(true);
    // 没有克隆用户 checkout 的依赖。
    expect(existsSync(join(worktree, "node_modules", "left-pad"))).toBe(false);
  }, 60_000);

  it("also treats a bun.lockb lockfile as a bun repository", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "bun.lockb"), "");
    process.env.BUN_INSTALL = fakeBun("mkdir -p node_modules/from-bun");
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result.installedWith).toContain("bun install --frozen-lockfile");
  }, 60_000);

  it("falls back to cloning when bun install fails, and drops the half-installed node_modules first", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "bun.lock"), "{}\n");
    process.env.BUN_INSTALL = fakeBun("mkdir -p node_modules/half-installed\nexit 1");
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toEqual({ cloned: ["node_modules", join("packages", "lib", "node_modules")], skipped: null, error: null });
    expect(existsSync(join(worktree, "node_modules", "half-installed"))).toBe(false);
    expect(readFileSync(join(worktree, "node_modules", "left-pad", "index.js"), "utf8")).toContain("1");
  }, 60_000);

  it("writes a status file in the worktree's git directory when preparation ends, and peek shows the state", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "bun.lock"), "{}\n");
    const gate = join(tempDir("plc-deps-bun-gate-"), "go");
    process.env.BUN_INSTALL = fakeBun(`while [ ! -e ${gate} ]; do sleep 0.05; done\nmkdir -p node_modules/from-bun`);
    const done = startWorktreeDependencies(repo, worktree);
    const statusFile = join(git(worktree, "rev-parse", "--absolute-git-dir"), DEPENDENCY_STATUS_FILE);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(peekWorktreeDependencies(join(worktree, "packages", "lib"))).toEqual({ state: "preparing" });
    expect(existsSync(statusFile)).toBe(false);
    writeFileSync(gate, "");
    const result = await done;
    expect(peekWorktreeDependencies(worktree)).toEqual({ state: "done", result });
    expect(readFileSync(statusFile, "utf8")).toMatch(/^ready: installed with bun install --frozen-lockfile/);
    // 状态文件在 git 目录里，不会进提交。
    expect(git(worktree, "status", "--porcelain")).toBe("?? bun.lock");
    expect(peekWorktreeDependencies(tempDir("plc-deps-other-"))).toBeNull();
  }, 60_000);
});

// #493：npm 的仓库（有 package-lock.json）在 pnpm、bun 之后、克隆之前用 npm ci 装；#473 拷 3 份 node_modules 花了约 11 分钟。
// 用假的 npm（脚本）代替真的：它记下参数和 PATH，按退出码和是否留下装了一半的 node_modules 表现。
function fakeNpmBin(body: string, dir = tempDir("plc-deps-npm-bin-")): string {
  const script = join(dir, "npm");
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, 0o755);
  return dir;
}

describe.runIf(supported)("startWorktreeDependencies in an npm repository", () => {
  const saved = { ...process.env };
  const realPath = (process.env.PATH ?? "").split(":").filter(Boolean);
  // 一个找不到 npm 的环境：PATH 里去掉有 npm 的目录（git 要留着），没有 nvm、volta，也没有 Homebrew 的固定目录。
  function withoutNpm(): void {
    process.env.PATH = realPath.filter((dir) => !existsSync(join(dir, "npm"))).join(":");
    process.env.HOME = tempDir("plc-deps-npm-home-");
    for (const key of ["NVM_BIN", "NVM_DIR", "VOLTA_HOME"]) delete process.env[key];
    setNpmSystemDirsForTests([]);
  }
  afterEach(() => {
    process.env = { ...saved };
    setNpmSystemDirsForTests();
  });

  it("installs once at the root with npm ci instead of cloning any node_modules, workspace packages included", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "package-lock.json"), "{}\n");
    withoutNpm();
    const out = tempDir("plc-deps-npm-out-");
    const bin = fakeNpmBin(`echo "$@" > ${out}/args\necho "$PATH" > ${out}/path\npwd >> ${out}/calls\nmkdir -p node_modules/from-npm`);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toEqual({
      cloned: [], skipped: null, error: null, installedWith: "npm ci --prefer-offline --ignore-scripts --no-audit --no-fund",
    });
    expect(readFileSync(join(out, "args"), "utf8").trim()).toBe("ci --prefer-offline --ignore-scripts --no-audit --no-fund --loglevel=error");
    // monorepo 只在根目录跑一次，npm 所在的目录在 PATH 最前面（脚本是 env node，要找得到 node）。
    expect(readFileSync(join(out, "calls"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(join(out, "path"), "utf8").startsWith(`${bin}:`)).toBe(true);
    expect(existsSync(join(worktree, "node_modules", "from-npm"))).toBe(true);
    // 没有拷用户 checkout 的依赖：不管是根的还是工作区包的。
    expect(existsSync(join(worktree, "node_modules", "left-pad"))).toBe(false);
    expect(existsSync(join(worktree, "packages", "lib", "node_modules"))).toBe(false);
  }, 60_000);

  it("skips npm and clones when npm cannot be found, and says why", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "package-lock.json"), "{}\n");
    withoutNpm();
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toMatchObject({ cloned: ["node_modules", join("packages", "lib", "node_modules")], skipped: null, error: null });
    expect(result.fallbackReason).toMatch(/找不到 npm/);
    expect(readFileSync(join(git(worktree, "rev-parse", "--absolute-git-dir"), DEPENDENCY_STATUS_FILE), "utf8"))
      .toMatch(/^ready: cloned node_modules.*\(installing with npm did not work: 找不到 npm/);
  }, 60_000);

  it("falls back to cloning when npm ci fails, drops the half-installed node_modules and says why", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "package-lock.json"), "{}\n");
    withoutNpm();
    process.env.PATH = `${fakeNpmBin("mkdir -p node_modules/half-installed\necho 'npm error code EUSAGE' >&2\necho 'npm error lock file is out of sync' >&2\nexit 1")}:${process.env.PATH}`;
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toMatchObject({ cloned: ["node_modules", join("packages", "lib", "node_modules")], skipped: null, error: null });
    expect(result.fallbackReason).toMatch(/^npm ci 失败：npm error code EUSAGE npm error lock file is out of sync$/);
    expect(existsSync(join(worktree, "node_modules", "half-installed"))).toBe(false);
    expect(readFileSync(join(worktree, "node_modules", "left-pad", "index.js"), "utf8")).toContain("1");
  }, 60_000);

  it("does not use npm in a repository without package-lock.json, and leaves no fallback reason", async () => {
    const { repo, worktree } = monorepo();
    withoutNpm();
    const out = tempDir("plc-deps-npm-out-");
    process.env.PATH = `${fakeNpmBin(`echo called > ${out}/called`)}:${process.env.PATH}`;
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toEqual({ cloned: ["node_modules", join("packages", "lib", "node_modules")], skipped: null, error: null });
    expect(existsSync(join(out, "called"))).toBe(false);
  }, 60_000);

  it("finds npm in the newest nvm node version and in a fixed system directory when PATH has none", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "package-lock.json"), "{}\n");
    withoutNpm();
    const out = tempDir("plc-deps-npm-out-");
    for (const version of ["v18.19.0", "v20.9.0", "v9.0.0"]) {
      fakeNpmBin(`echo ${version} > ${out}/version\nmkdir -p node_modules/from-npm`, (() => {
        const dir = join(process.env.HOME as string, ".nvm", "versions", "node", version, "bin");
        mkdirSync(dir, { recursive: true });
        return dir;
      })());
    }
    const nvm = await startWorktreeDependencies(repo, worktree);
    expect(nvm.installedWith).toContain("npm ci");
    expect(readFileSync(join(out, "version"), "utf8").trim()).toBe("v20.9.0");

    forgetWorktreeDependenciesForTests();
    rmSync(join(worktree, "node_modules"), { recursive: true, force: true });
    withoutNpm();
    setNpmSystemDirsForTests([fakeNpmBin("mkdir -p node_modules/from-system")]);
    const system = await startWorktreeDependencies(repo, worktree);
    expect(system.installedWith).toContain("npm ci");
    expect(existsSync(join(worktree, "node_modules", "from-system"))).toBe(true);
  }, 60_000);
});
