// 建隔离 worktree 时准备依赖（lead-tools-and-routing spec D15，#137 第 6 条）：真的 git 仓库、真的 worktree、真的克隆。
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { dependenciesNote } from "../src/children/manager.js";
import {
  awaitWorktreeDependencies, DEPENDENCY_STATUS_FILE, findNodeModulesDirs, forgetWorktreeDependenciesForTests,
  peekWorktreeDependencies, readDependencyStatus, setSystemBinDirsForTests, startWorktreeDependencies,
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

describe.runIf(supported)("readDependencyStatus", () => {
  it("reads the status line from the worktree's git directory, and is null when there is none", () => {
    const { worktree } = monorepo();
    expect(readDependencyStatus(worktree)).toBeNull();
    writeFileSync(join(git(worktree, "rev-parse", "--absolute-git-dir"), DEPENDENCY_STATUS_FILE), "ready: installed with npm ci\n");
    expect(readDependencyStatus(worktree)).toBe("ready: installed with npm ci");
    expect(readDependencyStatus(tempDir("plc-deps-not-a-worktree-"))).toBeNull();
  });
});

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
    // 行为和以前一样（克隆、先删装了一半的）；2026-11-25 起结果里多了退回的原因。
    expect(result).toEqual({
      cloned: ["node_modules", join("packages", "lib", "node_modules")], skipped: null, error: null, fallbackReason: "bun install 失败：退出码 1",
    });
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
function fakeBin(name: string, body: string, dir = tempDir(`plc-deps-${name}-bin-`)): string {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, name);
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, 0o755);
  return dir;
}
const fakeNpmBin = (body: string, dir?: string): string => fakeBin("npm", body, dir);

// 一个找不到 npm、yarn、corepack 的环境：PATH 只有 git 和系统的 /usr/bin:/bin，没有 nvm、volta，也没有 Homebrew 的固定目录。
function withoutPackageManagers(): void {
  const gitDir = tempDir("plc-deps-git-bin-");
  symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), join(gitDir, "git"));
  process.env.PATH = `${gitDir}:/usr/bin:/bin`;
  process.env.HOME = tempDir("plc-deps-home-");
  for (const key of ["NVM_BIN", "NVM_DIR", "VOLTA_HOME"]) delete process.env[key];
  setSystemBinDirsForTests([]);
}

describe.runIf(supported)("startWorktreeDependencies in an npm repository", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    setSystemBinDirsForTests();
  });

  it("installs once at the root with npm ci instead of cloning any node_modules, workspace packages included", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "package-lock.json"), "{}\n");
    withoutPackageManagers();
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
    withoutPackageManagers();
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toMatchObject({ cloned: ["node_modules", join("packages", "lib", "node_modules")], skipped: null, error: null });
    expect(result.fallbackReason).toMatch(/找不到 npm/);
    expect(readFileSync(join(git(worktree, "rev-parse", "--absolute-git-dir"), DEPENDENCY_STATUS_FILE), "utf8"))
      .toMatch(/^ready: cloned node_modules.*\(installing with the package manager did not work: 找不到 npm/);
  }, 60_000);

  it("falls back to cloning when npm ci fails, drops the half-installed node_modules and says why", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "package-lock.json"), "{}\n");
    withoutPackageManagers();
    process.env.PATH = `${fakeNpmBin("mkdir -p node_modules/half-installed\necho 'npm error code EUSAGE' >&2\necho 'npm error lock file is out of sync' >&2\nexit 1")}:${process.env.PATH}`;
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toMatchObject({ cloned: ["node_modules", join("packages", "lib", "node_modules")], skipped: null, error: null });
    expect(result.fallbackReason).toMatch(/^npm ci 失败：npm error code EUSAGE npm error lock file is out of sync$/);
    expect(existsSync(join(worktree, "node_modules", "half-installed"))).toBe(false);
    expect(readFileSync(join(worktree, "node_modules", "left-pad", "index.js"), "utf8")).toContain("1");
  }, 60_000);

  it("does not use npm in a repository without package-lock.json, and leaves no fallback reason", async () => {
    const { repo, worktree } = monorepo();
    withoutPackageManagers();
    const out = tempDir("plc-deps-npm-out-");
    process.env.PATH = `${fakeNpmBin(`echo called > ${out}/called`)}:${process.env.PATH}`;
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toEqual({ cloned: ["node_modules", join("packages", "lib", "node_modules")], skipped: null, error: null });
    expect(existsSync(join(out, "called"))).toBe(false);
  }, 60_000);

  it("finds npm in the newest nvm node version and in a fixed system directory when PATH has none", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "package-lock.json"), "{}\n");
    withoutPackageManagers();
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
    withoutPackageManagers();
    setSystemBinDirsForTests([fakeNpmBin("mkdir -p node_modules/from-system")]);
    const system = await startWorktreeDependencies(repo, worktree);
    expect(system.installedWith).toContain("npm ci");
    expect(existsSync(join(worktree, "node_modules", "from-system"))).toBe(true);
  }, 60_000);
});

// #499：--ignore-scripts 装完以后 better-sqlite3 没有原生程序（build/Release/better_sqlite3.node），测试一开始全部失败。
// 装完后只为这张表里的包补一步 `<包管理器> rebuild <包名>`，别的包的安装脚本不跑。
// 假的包管理器：install / ci 装出 better-sqlite3（可以带或不带原生程序），rebuild 记下参数，再装出原生程序。
const SQLITE = "node_modules/better-sqlite3";
const fakeInstaller = (installCommand: string, out: string, opts: { builtAtInstall?: boolean; rebuildExit?: number } = {}): string => [
  `case "$1" in`,
  `  ${installCommand}) mkdir -p ${SQLITE}/build/Release; echo '{"name":"better-sqlite3"}' > ${SQLITE}/package.json`,
  opts.builtAtInstall ? `    : > ${SQLITE}/build/Release/better_sqlite3.node` : `    rmdir ${SQLITE}/build/Release ${SQLITE}/build`,
  `    ;;`,
  `  rebuild) echo "$@" >> ${out}/rebuild-calls`,
  `    if [ "${opts.rebuildExit ?? 0}" != "0" ]; then echo 'gyp ERR! build error' >&2; exit ${opts.rebuildExit ?? 0}; fi`,
  `    mkdir -p ${SQLITE}/build/Release; : > ${SQLITE}/build/Release/better_sqlite3.node ;;`,
  `esac`,
].join("\n");

describe.runIf(supported)("native packages after an install without scripts", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    setSystemBinDirsForTests();
  });

  it("npm: rebuilds only better-sqlite3 when npm ci left it without its native binary", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "package-lock.json"), "{}\n");
    withoutPackageManagers();
    const out = tempDir("plc-deps-native-out-");
    process.env.PATH = `${fakeNpmBin(fakeInstaller("ci", out))}:${process.env.PATH}`;
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toEqual({
      cloned: [], skipped: null, error: null, rebuilt: ["better-sqlite3"],
      installedWith: "npm ci --prefer-offline --ignore-scripts --no-audit --no-fund",
    });
    // 只点名这一个包，不是不带包名的 `npm rebuild`（那会跑所有包的安装脚本）。
    expect(readFileSync(join(out, "rebuild-calls"), "utf8").trim().split("\n")).toEqual(["rebuild better-sqlite3"]);
    expect(existsSync(join(worktree, SQLITE, "build", "Release", "better_sqlite3.node"))).toBe(true);
    expect(readFileSync(join(git(worktree, "rev-parse", "--absolute-git-dir"), DEPENDENCY_STATUS_FILE), "utf8"))
      .toBe("ready: installed with npm ci --prefer-offline --ignore-scripts --no-audit --no-fund (rebuilt native packages: better-sqlite3)\n");
  }, 60_000);

  it("npm: does not rebuild when the native binary is already there", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "package-lock.json"), "{}\n");
    withoutPackageManagers();
    const out = tempDir("plc-deps-native-out-");
    process.env.PATH = `${fakeNpmBin(fakeInstaller("ci", out, { builtAtInstall: true }))}:${process.env.PATH}`;
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toEqual({
      cloned: [], skipped: null, error: null, installedWith: "npm ci --prefer-offline --ignore-scripts --no-audit --no-fund",
    });
    expect(existsSync(join(out, "rebuild-calls"))).toBe(false);
  }, 60_000);

  it("npm: keeps the install as ready when the rebuild fails, and says so in the result and the status file", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "package-lock.json"), "{}\n");
    withoutPackageManagers();
    const out = tempDir("plc-deps-native-out-");
    process.env.PATH = `${fakeNpmBin(fakeInstaller("ci", out, { rebuildExit: 1 }))}:${process.env.PATH}`;
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toMatchObject({ cloned: [], error: null, installedWith: expect.stringContaining("npm ci") });
    expect(result.rebuilt).toBeUndefined();
    expect(result.rebuildError).toMatch(/better-sqlite3.*npm rebuild 失败：gyp ERR! build error/);
    // 装好的 node_modules 不删。
    expect(existsSync(join(worktree, SQLITE, "package.json"))).toBe(true);
    expect(readFileSync(join(git(worktree, "rev-parse", "--absolute-git-dir"), DEPENDENCY_STATUS_FILE), "utf8"))
      .toMatch(/^ready: installed with npm ci .*\(native packages not built: .*gyp ERR! build error/);
  }, 60_000);

  it("pnpm: rebuilds only better-sqlite3 with pnpm rebuild", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    withoutPackageManagers();
    const out = tempDir("plc-deps-native-out-");
    process.env.PNPM_HOME = fakeBin("pnpm", fakeInstaller("install", out));
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toMatchObject({ cloned: [], error: null, rebuilt: ["better-sqlite3"], installedWith: expect.stringContaining("pnpm install") });
    expect(readFileSync(join(out, "rebuild-calls"), "utf8").trim().split("\n")).toEqual(["rebuild better-sqlite3"]);
  }, 60_000);

  it("bun: has no rebuild command, so it reports the missing native binary instead of running something else", async () => {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "bun.lock"), "{}\n");
    withoutPackageManagers();
    const out = tempDir("plc-deps-native-out-");
    const home = tempDir("plc-deps-bun-home-");
    fakeBin("bun", fakeInstaller("install", out), join(home, "bin"));
    process.env.BUN_INSTALL = home;
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toMatchObject({ cloned: [], error: null, installedWith: expect.stringContaining("bun install") });
    expect(result.rebuilt).toBeUndefined();
    expect(result.rebuildError).toMatch(/better-sqlite3.*bun.*没有补编译的命令/);
    expect(existsSync(join(out, "rebuild-calls"))).toBe(false);
  }, 60_000);
});

// #502：#499 之前建的工作区已经有 node_modules（npm ci --ignore-scripts 装的，better-sqlite3 没有原生程序）。
// 以前「已经有 node_modules」就直接跳过，执行者一开始跑测试就失败。现在派发时发现缺原生程序就补编译，不重装别的。
describe.runIf(supported)("a worktree that already has node_modules without the native binary (#502)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    setSystemBinDirsForTests();
  });

  // 旧工作区：装好了 better-sqlite3 的包，没有 build/Release/*.node。
  function oldWorktree(opts: { built?: boolean; lockfile?: string | null } = {}): { repo: string; worktree: string } {
    const { repo, worktree } = monorepo();
    if (opts.lockfile !== null) writeFileSync(join(worktree, opts.lockfile ?? "package-lock.json"), "{}\n");
    mkdirSync(join(worktree, SQLITE, "build", "Release"), { recursive: true });
    writeFileSync(join(worktree, SQLITE, "package.json"), '{"name":"better-sqlite3"}\n');
    if (opts.built) writeFileSync(join(worktree, SQLITE, "build", "Release", "better_sqlite3.node"), "");
    else rmSync(join(worktree, SQLITE, "build"), { recursive: true });
    return { repo, worktree };
  }

  it("rebuilds only better-sqlite3 and does not reinstall anything", async () => {
    const { repo, worktree } = oldWorktree();
    withoutPackageManagers();
    const out = tempDir("plc-deps-old-out-");
    process.env.PATH = `${fakeNpmBin(`echo "$@" >> ${out}/all-calls\n${fakeInstaller("ci", out)}`)}:${process.env.PATH}`;
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toMatchObject({ cloned: [], error: null, rebuilt: ["better-sqlite3"] });
    expect(result.rebuildError).toBeUndefined();
    // 只跑了 rebuild，没有 npm ci，也没有克隆用户的 node_modules。
    expect(readFileSync(join(out, "all-calls"), "utf8").trim().split("\n")).toEqual(["rebuild better-sqlite3"]);
    expect(existsSync(join(worktree, SQLITE, "build", "Release", "better_sqlite3.node"))).toBe(true);
    expect(existsSync(join(worktree, "node_modules", "left-pad"))).toBe(false);
    expect(readFileSync(join(git(worktree, "rev-parse", "--absolute-git-dir"), DEPENDENCY_STATUS_FILE), "utf8"))
      .toBe("ready: node_modules was already in the worktree (rebuilt native packages: better-sqlite3)\n");
  }, 60_000);

  it("does nothing when the native binary is already there, and the status says the dependencies are ready", async () => {
    const { repo, worktree } = oldWorktree({ built: true });
    withoutPackageManagers();
    const out = tempDir("plc-deps-old-out-");
    process.env.PATH = `${fakeNpmBin(`echo "$@" >> ${out}/all-calls`)}:${process.env.PATH}`;
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result.cloned).toEqual([]);
    expect(result.skipped).toMatch(/已经有 node_modules/);
    expect(result.rebuilt).toBeUndefined();
    expect(existsSync(join(out, "all-calls"))).toBe(false);
    // 执行者看到的状态不是「none:」（那会让它自己重装一遍）。
    expect(readFileSync(join(git(worktree, "rev-parse", "--absolute-git-dir"), DEPENDENCY_STATUS_FILE), "utf8"))
      .toBe("ready: node_modules was already in the worktree\n");
  }, 60_000);

  it("keeps node_modules and says so when the rebuild fails", async () => {
    const { repo, worktree } = oldWorktree();
    withoutPackageManagers();
    const out = tempDir("plc-deps-old-out-");
    process.env.PATH = `${fakeNpmBin(fakeInstaller("ci", out, { rebuildExit: 1 }))}:${process.env.PATH}`;
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result.rebuilt).toBeUndefined();
    expect(result.rebuildError).toMatch(/better-sqlite3.*npm rebuild 失败：gyp ERR! build error/);
    expect(existsSync(join(worktree, SQLITE, "package.json"))).toBe(true);
    expect(readFileSync(join(git(worktree, "rev-parse", "--absolute-git-dir"), DEPENDENCY_STATUS_FILE), "utf8"))
      .toMatch(/^ready: node_modules was already in the worktree \(native packages not built: .*gyp ERR! build error/);
  }, 60_000);

  it("rebuilds with pnpm in a pnpm repository", async () => {
    const { repo, worktree } = oldWorktree({ lockfile: "pnpm-lock.yaml" });
    withoutPackageManagers();
    const out = tempDir("plc-deps-old-out-");
    process.env.PNPM_HOME = fakeBin("pnpm", fakeInstaller("install", out));
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toMatchObject({ cloned: [], error: null, rebuilt: ["better-sqlite3"] });
    expect(readFileSync(join(out, "rebuild-calls"), "utf8").trim().split("\n")).toEqual(["rebuild better-sqlite3"]);
  }, 60_000);

  // PR #85 评审第 2 条：有 .pnpmfile.cjs 的 pnpm 仓库，daemon 不在沙箱外跑 pnpm；旧工作区的补编译也一样，交给执行者在沙箱里补。
  it("does not run pnpm rebuild outside the sandbox when the repository has .pnpmfile.cjs", async () => {
    const { repo, worktree } = oldWorktree({ lockfile: "pnpm-lock.yaml" });
    writeFileSync(join(worktree, ".pnpmfile.cjs"), "module.exports = { hooks: {} };\n");
    withoutPackageManagers();
    const out = tempDir("plc-deps-old-out-");
    process.env.PNPM_HOME = fakeBin("pnpm", fakeInstaller("install", out));
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result.rebuilt).toBeUndefined();
    expect(result.rebuildError).toMatch(/better-sqlite3.*\.pnpmfile\.cjs/);
    expect(existsSync(join(out, "rebuild-calls"))).toBe(false);
    expect(existsSync(join(worktree, SQLITE, "build", "Release", "better_sqlite3.node"))).toBe(false);
  }, 60_000);

  it("says what is missing when the repository has no lockfile, so no package manager is known", async () => {
    const { repo, worktree } = oldWorktree({ lockfile: null });
    withoutPackageManagers();
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result.rebuilt).toBeUndefined();
    expect(result.rebuildError).toMatch(/better-sqlite3.*没有锁文件/);
  }, 60_000);
});

// 2026-11-25：包管理器按锁文件认（PACKAGE_MANAGERS），加了 yarn：1（classic）和 2 及以上（berry）分开，PnP 没有 node_modules 可拷。
// 假的 yarn 记下参数和 YARN_ENABLE_SCRIPTS，再装出一个 node_modules。
describe.runIf(supported)("startWorktreeDependencies in a yarn repository", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    setSystemBinDirsForTests();
  });

  const YARN1_LOCK = "# yarn lockfile v1\n";
  const BERRY_LOCK = "__metadata:\n  version: 8\n";
  const LEFT_PAD_CLONED = { cloned: ["node_modules", join("packages", "lib", "node_modules")], skipped: null, error: null };

  // worktree 里放锁文件、package.json（可带 packageManager）和 .yarnrc.yml，PATH 里放一个假的 yarn。返回它记录的目录。
  function yarnRepo(options: { lock: string; packageManager?: string; yarnrc?: string; yarnBody?: string; extraLocks?: Record<string, string> }): {
    repo: string; worktree: string; out: string;
  } {
    const { repo, worktree } = monorepo();
    writeFileSync(join(worktree, "yarn.lock"), options.lock);
    for (const [name, content] of Object.entries(options.extraLocks ?? {})) writeFileSync(join(worktree, name), content);
    writeFileSync(join(worktree, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"], ...(options.packageManager ? { packageManager: options.packageManager } : {}) }));
    if (options.yarnrc !== undefined) writeFileSync(join(worktree, ".yarnrc.yml"), options.yarnrc);
    withoutPackageManagers();
    const out = tempDir("plc-deps-yarn-out-");
    const body = options.yarnBody ?? `echo "$@" > ${out}/args\necho "$YARN_ENABLE_SCRIPTS" > ${out}/scripts\nmkdir -p node_modules/from-yarn`;
    process.env.PATH = `${fakeBin("yarn", body)}:${process.env.PATH}`;
    return { repo, worktree, out };
  }

  it("installs a yarn 1 (classic) repository with the classic command and no clone", async () => {
    const { repo, worktree, out } = yarnRepo({ lock: YARN1_LOCK });
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toEqual({
      cloned: [], skipped: null, error: null,
      installedWith: "yarn install --frozen-lockfile --prefer-offline --ignore-scripts --non-interactive",
    });
    expect(readFileSync(join(out, "args"), "utf8").trim()).toBe("install --frozen-lockfile --prefer-offline --ignore-scripts --non-interactive");
    expect(readFileSync(join(out, "scripts"), "utf8").trim()).toBe("");
    expect(existsSync(join(worktree, "node_modules", "from-yarn"))).toBe(true);
    expect(existsSync(join(worktree, "node_modules", "left-pad"))).toBe(false);
  }, 60_000);

  it.each([
    ["there is a .yarnrc.yml", { lock: YARN1_LOCK, yarnrc: "nodeLinker: node-modules\n" }],
    ["yarn.lock has __metadata", { lock: BERRY_LOCK, yarnrc: "nodeLinker: node-modules\n" }],
  ])("installs a yarn berry repository with yarn install --immutable and scripts off when %s", async (_why, options) => {
    const { repo, worktree, out } = yarnRepo(options);
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toEqual({ cloned: [], skipped: null, error: null, installedWith: "YARN_ENABLE_SCRIPTS=false yarn install --immutable" });
    expect(readFileSync(join(out, "args"), "utf8").trim()).toBe("install --immutable");
    expect(readFileSync(join(out, "scripts"), "utf8").trim()).toBe("false");
  }, 60_000);

  it("a yarn 1 packageManager field wins over a stray .yarnrc.yml", async () => {
    const { repo, worktree, out } = yarnRepo({ lock: YARN1_LOCK, packageManager: "yarn@1.22.19", yarnrc: "nodeLinker: node-modules\n" });
    await startWorktreeDependencies(repo, worktree);
    expect(readFileSync(join(out, "args"), "utf8")).toContain("--frozen-lockfile");
  }, 60_000);

  it("says a PnP repository cannot fall back to copying when yarn install fails, and does not pretend it worked", async () => {
    // nodeLinker 没写：berry 默认就是 PnP。
    const { repo, worktree } = yarnRepo({ lock: BERRY_LOCK, yarnBody: "echo 'YN0028: lockfile would have been modified' >&2\nexit 1" });
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result.cloned).toEqual([]);
    expect(result.installedWith).toBeUndefined();
    expect(result.error).toMatch(/^PnP 仓库，不能退回拷贝：yarn install（berry） 失败：YN0028/);
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
    expect(readFileSync(join(git(worktree, "rev-parse", "--absolute-git-dir"), DEPENDENCY_STATUS_FILE), "utf8")).toMatch(/^failed: PnP 仓库，不能退回拷贝/);
  }, 60_000);

  it("also treats nodeLinker: pnp as PnP, and a missing yarn in a PnP repository as an error, not a skip", async () => {
    const { repo, worktree } = yarnRepo({ lock: BERRY_LOCK, yarnrc: "nodeLinker: pnp\n" });
    withoutPackageManagers();
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toMatchObject({ cloned: [], error: expect.stringMatching(/^PnP 仓库，不能退回拷贝：找不到 yarn/) });
  }, 60_000);

  it("keeps a successful PnP install as a success", async () => {
    const { repo, worktree } = yarnRepo({ lock: BERRY_LOCK, yarnrc: "nodeLinker: pnp\n", yarnBody: "echo '' > .pnp.cjs" });
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toMatchObject({ cloned: [], error: null, installedWith: "YARN_ENABLE_SCRIPTS=false yarn install --immutable" });
  }, 60_000);

  it("falls back to cloning when yarn install fails in a node-modules repository, and says why", async () => {
    const { repo, worktree } = yarnRepo({
      lock: YARN1_LOCK, yarnBody: "mkdir -p node_modules/half-installed\necho 'error An unexpected error occurred' >&2\nexit 1",
    });
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toMatchObject(LEFT_PAD_CLONED);
    expect(result.fallbackReason).toBe("yarn install（classic） 失败：error An unexpected error occurred");
    expect(existsSync(join(worktree, "node_modules", "half-installed"))).toBe(false);
  }, 60_000);

  it("skips yarn and clones when yarn cannot be found, and says why", async () => {
    const { repo, worktree } = yarnRepo({ lock: YARN1_LOCK });
    withoutPackageManagers();
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result).toMatchObject(LEFT_PAD_CLONED);
    expect(result.fallbackReason).toMatch(/^找不到 yarn/);
  }, 60_000);

  it("runs yarn through corepack when packageManager names yarn and no yarn command exists", async () => {
    const { repo, worktree } = yarnRepo({ lock: YARN1_LOCK, packageManager: "yarn@1.22.19" });
    withoutPackageManagers();
    const out = tempDir("plc-deps-corepack-out-");
    process.env.PATH = `${fakeBin("corepack", `echo "$@" > ${out}/args\nmkdir -p node_modules/from-corepack`)}:${process.env.PATH}`;
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result.installedWith).toBe("yarn install --frozen-lockfile --prefer-offline --ignore-scripts --non-interactive");
    expect(readFileSync(join(out, "args"), "utf8").trim()).toBe("yarn install --frozen-lockfile --prefer-offline --ignore-scripts --non-interactive");
  }, 60_000);

  it("finds yarn in ~/.yarn/bin when PATH has none", async () => {
    const { repo, worktree } = yarnRepo({ lock: YARN1_LOCK });
    withoutPackageManagers();
    fakeBin("yarn", "mkdir -p node_modules/from-home-yarn", join(process.env.HOME as string, ".yarn", "bin"));
    expect((await startWorktreeDependencies(repo, worktree)).installedWith).toContain("yarn install");
    expect(existsSync(join(worktree, "node_modules", "from-home-yarn"))).toBe(true);
  }, 60_000);

  // PR #85 评审第 4 条：~/.yarn/bin 里只有 yarn 没有 node。yarn 是 `#!/usr/bin/env node` 的脚本，PATH 里没有 node 就跑不起来，
  // 所以要从 nvm、volta、Homebrew 这些目录里再找一个有 node 的放到 PATH 前面。假的 yarn 在找不到 node 时失败，真装不出来。
  it("puts a directory that has node on PATH when yarn comes from ~/.yarn/bin, which has no node", async () => {
    const { repo, worktree } = yarnRepo({ lock: YARN1_LOCK });
    withoutPackageManagers();
    const nodeDir = fakeBin("node", "exit 0");
    setSystemBinDirsForTests([nodeDir]);
    fakeBin(
      "yarn",
      `[ "$(command -v node)" = "${nodeDir}/node" ] || { echo "env: node: No such file or directory" >&2; exit 127; }\nmkdir -p node_modules/from-home-yarn`,
      join(process.env.HOME as string, ".yarn", "bin"),
    );
    const result = await startWorktreeDependencies(repo, worktree);
    expect(result.installedWith).toContain("yarn install");
    expect(result.fallbackReason).toBeUndefined();
    expect(existsSync(join(worktree, "node_modules", "from-home-yarn"))).toBe(true);
  }, 60_000);

  // PR #85 评审第 2 条（2026-11-26）：berry 的 yarnPath 和插件、pnpm 的 .pnpmfile.cjs 是仓库自带的 JS，安装时会被运行。
  // daemon 在沙箱外装，所以碰到它们就不装也不克隆，状态写成 none:，提示让执行者在沙箱里自己装。
  describe("a repository that carries its own install-time JavaScript", () => {
    const NOT_RUN = "install-was-run";

    async function expectSkipped(repo: string, worktree: string, out: string, reason: RegExp): Promise<void> {
      const result = await startWorktreeDependencies(repo, worktree);
      expect(existsSync(join(out, NOT_RUN))).toBe(false);
      expect(result).toMatchObject({ cloned: [], error: null, skipped: expect.stringMatching(reason) });
      expect(result.installedWith).toBeUndefined();
      expect(existsSync(join(worktree, "node_modules"))).toBe(false);
      const line = readFileSync(join(git(worktree, "rev-parse", "--absolute-git-dir"), DEPENDENCY_STATUS_FILE), "utf8");
      expect(line).toMatch(/^none: /);
      // 执行者看到的提示：没准备，让它自己装。
      const note = dependenciesNote(worktree);
      expect(note).toContain("Dependencies were not prepared");
      expect(note).toContain("install them here yourself");
      expect(note).toMatch(reason);
    }

    const calledBody = (out: string): string => `echo run > ${out}/${NOT_RUN}\nmkdir -p node_modules/from-yarn`;

    it("does not install a yarn berry repository whose .yarnrc.yml sets yarnPath", async () => {
      const { repo, worktree, out } = yarnRepo({ lock: BERRY_LOCK, yarnrc: "nodeLinker: node-modules\nyarnPath: .yarn/releases/yarn-4.1.0.cjs\n" });
      process.env.PATH = `${fakeBin("yarn", calledBody(out))}:${process.env.PATH}`;
      await expectSkipped(repo, worktree, out, /yarnPath/);
    }, 60_000);

    it("does not install a yarn berry repository whose .yarnrc.yml lists plugins", async () => {
      const { repo, worktree, out } = yarnRepo({ lock: BERRY_LOCK, yarnrc: "nodeLinker: node-modules\nplugins:\n  - path: .yarn/plugins/x.cjs\n" });
      process.env.PATH = `${fakeBin("yarn", calledBody(out))}:${process.env.PATH}`;
      await expectSkipped(repo, worktree, out, /plugins/);
    }, 60_000);

    it("does not install when package.json packageManager says yarn 2 or later", async () => {
      const { repo, worktree, out } = yarnRepo({ lock: BERRY_LOCK, packageManager: "yarn@4.1.0+sha224.abc" });
      process.env.PATH = `${fakeBin("yarn", calledBody(out))}:${process.env.PATH}`;
      await expectSkipped(repo, worktree, out, /packageManager/);
    }, 60_000);

    it("ignores yarnPath and plugins that are only in a comment", async () => {
      const { repo, worktree, out } = yarnRepo({ lock: BERRY_LOCK, yarnrc: "nodeLinker: node-modules\n# yarnPath: x.cjs\n# plugins:\n" });
      const result = await startWorktreeDependencies(repo, worktree);
      expect(result.installedWith).toBe("YARN_ENABLE_SCRIPTS=false yarn install --immutable");
      expect(readFileSync(join(out, "args"), "utf8").trim()).toBe("install --immutable");
    }, 60_000);

    it("does not install a pnpm repository that has .pnpmfile.cjs", async () => {
      const { repo, worktree } = monorepo();
      writeFileSync(join(worktree, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      writeFileSync(join(worktree, ".pnpmfile.cjs"), "module.exports = { hooks: {} };\n");
      withoutPackageManagers();
      const out = tempDir("plc-deps-pnpm-out-");
      delete process.env.PNPM_HOME; // 找 pnpm 先看它，不然会用到本机真装的
      process.env.PATH = `${fakeBin("pnpm", calledBody(out))}:${process.env.PATH}`;
      await expectSkipped(repo, worktree, out, /\.pnpmfile\.cjs/);
    }, 60_000);

    it("still installs a pnpm repository without .pnpmfile.cjs", async () => {
      const { repo, worktree } = monorepo();
      writeFileSync(join(worktree, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      withoutPackageManagers();
      const out = tempDir("plc-deps-pnpm-out-");
      delete process.env.PNPM_HOME; // 找 pnpm 先看它，不然会用到本机真装的
      process.env.PATH = `${fakeBin("pnpm", `echo "$@" > ${out}/args\nmkdir -p node_modules/from-pnpm`)}:${process.env.PATH}`;
      const result = await startWorktreeDependencies(repo, worktree);
      expect(result.fallbackReason).toBeUndefined();
      expect(result.installedWith).toBe("pnpm install --frozen-lockfile --prefer-offline --ignore-scripts");
      expect(readFileSync(join(out, "args"), "utf8")).toContain("--frozen-lockfile");
    }, 60_000);

    it("keeps installing yarn 1 even when it has a .pnpmfile.cjs, since only pnpm runs that file", async () => {
      const { repo, worktree } = yarnRepo({ lock: YARN1_LOCK, packageManager: "yarn@1.22.19" });
      writeFileSync(join(worktree, ".pnpmfile.cjs"), "module.exports = {};\n");
      const result = await startWorktreeDependencies(repo, worktree);
      expect(result.installedWith).toContain("yarn install --frozen-lockfile");
    }, 60_000);
  });

  describe("when a repository has several lockfiles", () => {
    // npm 和 yarn 都是假的，各记下自己被叫过。
    function both(packageManager?: string): { repo: string; worktree: string; out: string } {
      const made = yarnRepo({ lock: YARN1_LOCK, ...(packageManager ? { packageManager } : {}), extraLocks: { "package-lock.json": "{}\n" } });
      process.env.PATH = `${fakeNpmBin(`echo npm > ${made.out}/called\nmkdir -p node_modules/from-npm`)}:${process.env.PATH}`;
      process.env.PATH = `${fakeBin("yarn", `echo yarn > ${made.out}/called\nmkdir -p node_modules/from-yarn`)}:${process.env.PATH}`;
      return made;
    }

    it("follows the packageManager field and says so", async () => {
      const { repo, worktree, out } = both("yarn@1.22.19");
      const result = await startWorktreeDependencies(repo, worktree);
      expect(readFileSync(join(out, "called"), "utf8").trim()).toBe("yarn");
      expect(result.selectionNote).toBe("有几种锁文件（npm、yarn），package.json 的 packageManager 字段写的是 yarn，选了 yarn");
      expect(readFileSync(join(git(worktree, "rev-parse", "--absolute-git-dir"), DEPENDENCY_STATUS_FILE), "utf8")).toContain("选了 yarn");
    }, 60_000);

    it("uses the fixed order when there is no packageManager field, and says so", async () => {
      const { repo, worktree, out } = both();
      const result = await startWorktreeDependencies(repo, worktree);
      expect(readFileSync(join(out, "called"), "utf8").trim()).toBe("npm");
      expect(result.selectionNote).toBe("有几种锁文件（npm、yarn），package.json 没有 packageManager 字段，按固定顺序（pnpm、bun、npm、yarn）选了 npm");
    }, 60_000);

    it("uses the fixed order when the packageManager field names a manager whose lockfile is missing", async () => {
      const { repo, worktree, out } = both("pnpm@9.0.0");
      const result = await startWorktreeDependencies(repo, worktree);
      expect(readFileSync(join(out, "called"), "utf8").trim()).toBe("npm");
      expect(result.selectionNote).toContain("packageManager 字段写的是 pnpm，但它的锁文件不在其中");
    }, 60_000);

    it("only tries the chosen manager: when it fails the repository is cloned, the other one is not tried", async () => {
      const { repo, worktree, out } = both("yarn@1.22.19");
      process.env.PATH = `${fakeBin("yarn", `echo yarn > ${out}/called\nexit 1`)}:${process.env.PATH}`;
      const result = await startWorktreeDependencies(repo, worktree);
      expect(readFileSync(join(out, "called"), "utf8").trim()).toBe("yarn");
      expect(result).toMatchObject(LEFT_PAD_CLONED);
      expect(result.fallbackReason).toMatch(/^yarn install（classic） 失败/);
      expect(result.selectionNote).toContain("选了 yarn");
    }, 60_000);
  });
});
