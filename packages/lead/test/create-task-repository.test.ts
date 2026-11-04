// 建单时写明的仓库本机没有（2026-11-03）：以前 create_task 等 clone 完才返回。四张工单一张张建，三次 clone 各等了
// 13–17 秒，Lead 那一轮多等了 45 秒。现在建单只用 ls-remote 确认连得上，clone 在后台跑，执行者开跑前等它。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getItem, listActivities, openDb, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { RuntimeRegistry, type AgentRuntime, type RuntimeEvent, type RuntimeHandle, type RuntimeStartRequest } from "@pi-lead-child/runtime";
import { createLeadTools, runningChildren, type LeadDeps } from "../src/tools.js";

let db: Db;
let dir: string;
let home: string;
let deps: LeadDeps;
let runtime: CapturingRuntime;
let saved: Record<"HOME" | "GIT_CONFIG_GLOBAL" | "PATH" | "PLC_DATA_DIR" | "PLC_CHILD_LINGER_MS", string | undefined>;

class CapturingRuntime implements AgentRuntime {
  readonly id = "codex" as const;
  readonly capabilities = {
    streaming: true, steering: false, resume: false, interrupt: true, approvals: false, mcp: false, executableReadOnlyReview: true,
  };
  readonly requests: RuntimeStartRequest[] = [];

  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    this.requests.push(request);
    async function* events(): AsyncIterable<RuntimeEvent> {
      yield { runId: request.runId, seq: 1, occurredAt: new Date().toISOString(), type: "run.started", runtime: "codex", model: null };
      yield { runId: request.runId, seq: 2, occurredAt: new Date().toISOString(), type: "run.completed", exitCode: 0 };
    }
    return {
      pid: null,
      events: events(),
      interrupt: async () => {},
      wait: async () => ({ ok: true, exitCode: 0, signal: null, externalSessionId: null, errorCode: null, errorMessage: null }),
    };
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.test", "-c", "user.name=T", ...args], { encoding: "utf8" }).trim();
}

function tool(name: string) {
  const found = createLeadTools(deps).find((candidate: any) => candidate.name === name) as any;
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

// 一个本地的 bare 仓库，假装是 https://github.com/acme/demo：git 的 insteadOf 把地址换成它。
function fakeGithub(): void {
  const seed = join(dir, "seed");
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  writeFileSync(join(seed, "Dockerfile"), "FROM node:22\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "seed");
  mkdirSync(join(dir, "github", "acme"), { recursive: true });
  execFileSync("git", ["clone", "-q", "--bare", seed, join(dir, "github", "acme", "demo.git")]);
  const config = join(dir, "gitconfig");
  writeFileSync(config, `[url "${join(dir, "github", "acme")}/"]\n\tinsteadOf = https://github.com/acme/\n`);
  process.env.GIT_CONFIG_GLOBAL = config;
}

// PATH 上放一个 git 替身：git clone 等到测试写出 release 文件（最多 10 秒），像网络慢的时候；别的命令直接交给真的 git。
function heldClone(release: string): void {
  const real = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
  const bin = join(dir, "slow-git-bin");
  mkdirSync(bin, { recursive: true });
  const pause = `n=0; while [ ! -f "${release}" ] && [ $n -lt 100 ]; do sleep 0.1; n=$((n + 1)); done`;
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" clone "*) ${pause} ;; esac\nexec "${real}" "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
}

function decisions(itemId: number): Array<Record<string, unknown>> {
  return listActivities(db, itemId)
    .filter((activity) => activity.kind === "decision")
    .map((activity) => JSON.parse(activity.payload) as Record<string, unknown>);
}

beforeEach(() => {
  saved = {
    HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, PATH: process.env.PATH,
    PLC_DATA_DIR: process.env.PLC_DATA_DIR, PLC_CHILD_LINGER_MS: process.env.PLC_CHILD_LINGER_MS,
  };
  dir = tempDir("plc-create-task-repo-");
  home = join(dir, "home");
  mkdirSync(home);
  process.env.HOME = home;
  // 数据目录不能包住工单的工作目录（assertExternalChildWorkdir）：和 home 分开放。
  const dataDir = join(dir, "data");
  mkdirSync(dataDir);
  process.env.PLC_DATA_DIR = dataDir;
  process.env.PLC_CHILD_LINGER_MS = "0";
  db = openDb(join(dataDir, "plc.db"));
  runtime = new CapturingRuntime();
  deps = { db, dbPath: join(dataDir, "plc.db"), dataDir, runtimeRegistry: new RuntimeRegistry([runtime]) };
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  db.close();
});

describe("create_task with a repository that is not on this Mac", () => {
  it("returns before the clone ends, and the executor starts in a worktree of the clone", async () => {
    fakeGithub();
    // clone 一直等着，直到测试放行：create_task 和 spawn_child 都要在 clone 完成以前返回。以前的 create_task 要等满 10 秒。
    const release = join(dir, "release-clone");
    heldClone(release);
    const clonePath = join(home, "Workspace", "acme", "demo");

    const created = await tool("create_task").execute("call", {
      title: "Bump the base image", brief: "Use Node 24", repository: "acme/demo", runtime: "codex",
    });
    const reply = created.content[0].text as string;
    expect(reply).toContain("仓库 acme/demo 本机没有，正在后台 clone");
    const itemId = Number(/created task #(\d+)/.exec(reply)![1]);
    expect(getItem(db, itemId)!.workdir).toBe(clonePath);
    expect(existsSync(clonePath)).toBe(false);
    expect(decisions(itemId)).toContainEqual(expect.objectContaining({
      decision: "ticket_repository", repository: "github.com/acme/demo", path: clonePath, cloning: true,
    }));

    // spawn_child 不等 clone：它马上返回，执行者在 clone 完以后才开始。
    await tool("spawn_child").execute("call", { ticket_id: itemId, runtime: "codex", reason: "start" });
    expect(runtime.requests).toHaveLength(0);
    expect(existsSync(clonePath)).toBe(false);

    writeFileSync(release, "");
    await vi.waitFor(() => expect(runtime.requests).toHaveLength(1), { timeout: 20_000 });
    const workdir = runtime.requests[0]!.workdir;
    expect(workdir.startsWith(`${realpathSync(clonePath)}.plc-workspaces`)).toBe(true);
    expect(existsSync(join(workdir, "Dockerfile"))).toBe(true);
    expect(decisions(itemId)).toContainEqual(expect.objectContaining({ decision: "ticket_repository_cloned", path: clonePath }));
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false), { timeout: 10_000 });
  });

  it("refuses at once when the repository cannot be read, and creates no ticket", async () => {
    fakeGithub();
    await expect(tool("create_task").execute("call", {
      title: "Bump the base image", brief: "Use Node 24", repository: "acme/missing", runtime: "codex",
    })).rejects.toThrow(/连不上 acme\/missing，或者没有读它的权限/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 0 });
    expect(existsSync(join(home, "Workspace", "acme", "missing"))).toBe(false);
  });

  it("uses a checkout that is already on this Mac without cloning", async () => {
    fakeGithub();
    const existing = join(home, "Workspace", "acme", "demo");
    execFileSync("git", ["clone", "-q", "https://github.com/acme/demo", existing]);
    const created = await tool("create_task").execute("call", {
      title: "Bump the base image", brief: "Use Node 24", repository: "acme/demo", runtime: "codex",
    });
    const reply = created.content[0].text as string;
    expect(reply).not.toContain("正在后台 clone");
    const itemId = Number(/created task #(\d+)/.exec(reply)![1]);
    expect(getItem(db, itemId)!.workdir).toBe(existing);
    expect(decisions(itemId)).toContainEqual(expect.objectContaining({ decision: "ticket_repository", path: existing, cloned: false }));
  });
});
