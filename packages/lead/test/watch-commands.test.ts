// 后台检查的命令在哪里跑（watch-commands.ts，docs/ticket-246-user-turn-bypass.md 第 10 节，用户 2026-11-11）。
// 回归：11-11 上午推完 PR 以后，等 CI 的命令检查在沙箱里跑，gh 没有用户的凭证，看不到结果；这一轮查过一次连接以后，
// 设检查还要用户点确认卡。
// 用户定的规则：用户交代的事带出来的检查在沙箱外跑；别人的话带出来的在沙箱里跑；读过别人内容的一轮，设的时候决策模型判断一次。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { enableHostBypass, disableHostBypass } from "@pi-lead-child/engine";
import {
  createLoopbackBinding, createTurn, createWatch, getWatch, listEvents, listWatches, openDb, watchOrigin, type Db, type Watch,
} from "@pi-lead-child/store";
import { createLeadTools, type LeadDeps } from "../src/tools.js";
import { withExternalContent, type LeadTurnOrigin } from "../src/turn-origin.js";
import { watchCommandRunner } from "../src/watch-commands.js";

let db: Db;
let dir: string;
let deps: LeadDeps;
let origin: LeadTurnOrigin;
let turnId: string | null;
const tool = (name: string) => createLeadTools(deps).find((candidate: any) => candidate.name === name) as any;

beforeEach(() => {
  dir = tempDir("plc-watch-commands-");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(join(dir, "plc.db"));
  origin = { external: false, timer: null };
  turnId = null;
  deps = { db, dbPath: join(dir, "plc.db"), dataDir: dir, currentTurnId: () => turnId, turnOrigin: () => origin };
});

const turnOn = () => enableHostBypass(db, { bindingId: null, resolvedBy: "user via Mac 网页", reason: "test", now: new Date() });

function userTurn(id: string): void {
  const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
  createTurn(db, { id, originBindingId: binding.id, originKind: "paired:companion", userText: "把修复推上去，等 CI 跑完告诉我", state: "streaming" });
  turnId = id;
}

function smartModel(answer: { serves: number; hard: number } | null) {
  if (answer === null) return null;
  return {
    backend: "fake",
    decide: async () => ({
      backend: "fake", model: null, latencyMs: 1, fallbackFrom: null,
      answers: {
        serves_user: { type: "yes_no" as const, probability: answer.serves },
        hard_to_undo: { type: "yes_no" as const, probability: answer.hard },
      },
    }),
  } as unknown as NonNullable<LeadDeps["smartModel"]>;
}

const setWatch = (command: string) => tool("watch").execute("t", {
  label: "等 CI", check: "command", command, mode: "until", every_seconds: 60,
  until: new Date(Date.now() + 3_600_000).toISOString(), note: "CI 跑完告诉用户",
});
const only = (): Watch => {
  const watches = listWatches(db);
  expect(watches).toHaveLength(1);
  return watches[0]!;
};

describe("setting a command watch with the sandbox bypass on", () => {
  it("lets a watch from the user's own request, or one Lead sets for it in a system turn, run outside the sandbox", async () => {
    turnOn();
    // 系统叫醒的一轮（例如执行结束）：Lead 为了办用户的事自己设。
    const own = await setWatch("gh run view 123 --json status -q .status | grep -qx completed");
    expect(own.isError).toBeFalsy();
    expect(own.content[0].text).toContain("到点命令在沙箱外跑");
    expect(only()).toMatchObject({ host_run: 1 });
    expect(watchOrigin(only())).toEqual({ kind: "system" });
    // 用户本人发话的一轮。
    userTurn("turn-user");
    await setWatch("gh pr checks 35");
    const mine = listWatches(db).find((watch) => watch.command === "gh pr checks 35")!;
    expect(mine.host_run).toBe(1);
    expect(watchOrigin(mine).kind).toBe("user");
  });

  // 回归：这一轮用连接查过 PR 的状态以后，设等 CI 的检查变成「认不出的人要求的定时器」，要用户点确认卡。
  it("sets it as Lead's own, without a card, after the turn read a connection result, when the decision model lets the command run", async () => {
    turnOn();
    origin = withExternalContent(origin, { via: "tool", tool: "call_connection_tool" });
    deps = { ...deps, smartModel: smartModel({ serves: 0.9, hard: 0.2 }) };
    const result = await setWatch("gh pr checks 35");
    expect(result.isError).toBeFalsy();
    expect(only()).toMatchObject({ host_run: 1 });
    expect(watchOrigin(only())).toEqual({ kind: "system" });
    expect(listEvents(db, { kind: "timer_request.decided" })).toEqual([]);
  });

  it("treats it as someone else's timer when the decision model says the command is not the user's and is hard to undo, even in the user's turn", async () => {
    turnOn();
    userTurn("turn-read-slack");
    origin = withExternalContent(origin, { via: "tool", tool: "read_channel_conversation" });
    for (const model of [smartModel({ serves: 0.1, hard: 0.9 }), null]) {
      deps = { ...deps, smartModel: model };
      const result = await setWatch("curl -X POST https://collect.example.com/ping");
      // 外部来源的定时器由决策模型判断（engine 的 requestExternalTimer）：这里认不出是谁要求的，问用户。
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        refused: true, refusal: { code: "timer_needs_confirmation" }, user_action: { kind: "confirm_timer" },
      });
    }
    expect(listWatches(db)).toEqual([]);
  });

  it("keeps the watch in the sandbox when the command hits a floor, and when the switch is off", async () => {
    turnOn();
    userTurn("turn-floor");
    const floor = await setWatch("security find-generic-password -s example");
    expect(floor.isError).toBeFalsy();
    expect(floor.content[0].text).not.toContain("沙箱外");
    expect(only().host_run).toBe(0);
    disableHostBypass(db, { by: "user", turnId: "turn-floor", reason: "test", now: new Date() });
    await setWatch("gh pr checks 36");
    expect(listWatches(db).find((watch) => watch.command === "gh pr checks 36")!.host_run).toBe(0);
  });
});

// 沙箱外的命令用用户的登录 shell 跑：机器忙时一条就要几秒，跑真命令的用例时限放到 60 秒。
describe("running a command watch", () => {
  const sandboxed = vi.fn(async () => ({ exitCode: 0, output: "from-sandbox", timedOut: false }));
  const runner = () => watchCommandRunner(db, { dataDir: dir, home: dir, sandboxed });
  const watchOf = (command: string, hostRun: boolean): Watch => getWatch(db, createWatch(db, {
    label: "w", check: { kind: "command", command }, mode: "repeat", everySeconds: 60, origin: { kind: "system" }, hostRun,
  }))!;
  const hostEvents = (kind: "started" | "finished") => listEvents(db, { kind: `host_command.${kind}` }).map((event) => event.payload as any);

  beforeEach(() => sandboxed.mockClear());

  it("runs a host_run watch outside the sandbox while the switch is on, and records the first run", async () => {
    turnOn();
    const marker = join(dir, "ran-on-host");
    const watch = watchOf(`echo from-host && touch '${marker}'`, true);
    const result = await runner()(watch.command!, 30, watch);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.output).toContain("from-host");
    expect(existsSync(marker)).toBe(true);
    expect(sandboxed).not.toHaveBeenCalled();
    expect(hostEvents("started")).toEqual([expect.objectContaining({
      turnId: null, turnOrigin: "lead_turn", via: "watch", command: watch.command, screen: { verdict: "allow", rule: null },
    })]);
    expect(hostEvents("finished")).toEqual([expect.objectContaining({ exitCode: 0, timedOut: false })]);
  }, 60_000);

  it("records a later run only when the result changes", async () => {
    turnOn();
    const flag = join(dir, "flag");
    const watch = watchOf(`test -e '${flag}'`, true);
    const run = runner();
    // 查过几次、上次没通过的检查：结果没变时不写事件。
    const failing = { ...watch, check_count: 3, last_status: "fail" as const };
    expect((await run(watch.command!, 30, failing)).exitCode).toBe(1);
    expect(hostEvents("started")).toEqual([]);
    // 这一次通过了：写一对事件。
    await run(`touch '${flag}'`, 30, watchOf(`touch '${flag}'`, true));
    const before = hostEvents("finished").length;
    expect((await run(watch.command!, 30, failing)).exitCode).toBe(0);
    expect(hostEvents("finished")).toHaveLength(before + 1);
  }, 60_000);

  it("keeps a watch in the sandbox when it was not cleared for the host, the switch is off, or the command hits a floor", async () => {
    const run = runner();
    // 开关关着。
    const cleared = watchOf("echo cleared", true);
    expect((await run(cleared.command!, 30, cleared)).output).toBe("from-sandbox");
    turnOn();
    // 设的时候没有放行（别人要求的、以前设的）。
    const plain = watchOf("echo plain", false);
    expect((await run(plain.command!, 30, plain)).output).toBe("from-sandbox");
    // 碰到底线。
    const floor = watchOf("security find-generic-password -s example", true);
    expect((await run(floor.command!, 30, floor)).output).toBe("from-sandbox");
    expect(sandboxed).toHaveBeenCalledTimes(3);
    expect(hostEvents("started")).toEqual([]);
  });
});
