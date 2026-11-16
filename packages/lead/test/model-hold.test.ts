// 模型暂停（model-hold.ts，2026-11-15）：账号级的失败马上进入暂停，用户的一轮答上了才解除；别的失败连续 3 次才进（熔断，见下面）。
// 进入和解除各写一行日志。
import { describe, expect, it } from "vitest";
import { ModelHold } from "../src/model-hold.js";

const DISABLED = "403 This service has been disabled in this account for violation of Terms of Service.";

function hold() {
  const lines: string[] = [];
  const changes: boolean[] = [];
  let now = 1_000;
  const made = new ModelHold({ log: (line) => lines.push(line), onChange: (held) => changes.push(held), now: () => now });
  return { made, lines, changes, advance: (ms: number) => { now += ms; } };
}

describe("ModelHold", () => {
  it("enters on an account-level failure and logs one line", () => {
    const { made, lines, changes } = hold();
    expect(made.failed("turn", DISABLED)).toBe(true);
    expect(made.held).toBe(true);
    expect(made.state).toMatchObject({ source: "turn", since: 1_000 });
    // 再失败一次：还在暂停，不再写日志。
    expect(made.failed("decision", "401 Unauthorized")).toBe(true);
    expect(changes).toEqual([true]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[sched\] model\.hold action=entered source=turn kind=auth error=".*Terms of Service\." until=/u);
  });

  it("does not hold after one failure that is not account-level", () => {
    for (const error of [
      "429 Too Many Requests", "503 Service Unavailable", '403: {"type":"forbidden","message":"Request not allowed"}',
      "getaddrinfo ENOTFOUND api.example.com", "Context overflow: 上下文满了，回答被截成空的",
    ]) {
      const { made, lines } = hold();
      expect(made.failed("turn", error), error).toBe(false);
      expect(made.held).toBe(false);
      expect(lines).toEqual([]);
    }
  });

  it("lifts only when held, with one line that says how long it held", () => {
    const { made, lines, changes, advance } = hold();
    made.lift("user_turn");
    expect(lines).toEqual([]);
    made.failed("compaction", `上下文压缩失败：${DISABLED}`);
    advance(5_000);
    made.lift("user_turn");
    expect(made.held).toBe(false);
    expect(changes).toEqual([true, false]);
    expect(lines[1]).toBe("[sched] model.hold action=lifted by=user_turn source=compaction heldMs=5000");
  });

  it("keeps secrets out of the log line", () => {
    const { made, lines } = hold();
    made.failed("turn", "401 Unauthorized: invalid x-api-key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(lines[0]).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });
});

// 熔断（2026-11-16）：模型两天不可用，daemon 自动调了 7,028 次。连续失败 3 次以后停下，按 5 分钟起、每次加倍、最长 4 小时放一次调用去试。
describe("ModelHold breaker", () => {
  const REFUSED = "Connection error.: connect ECONNREFUSED 127.0.0.1:8317";
  const UPSTREAM_503 = "503 Service Unavailable: upstream connect error";
  const MINUTE = 60_000;

  function breaker(options: { reachable?: () => Promise<boolean> } = {}) {
    const lines: string[] = [];
    const changes: boolean[] = [];
    let now = 0;
    let timer: { at: number; run: () => void } | null = null;
    const made = new ModelHold({
      log: (line) => lines.push(line), onChange: (held) => changes.push(held), now: () => now,
      setTimer: (run, ms) => { timer = { at: now + ms, run }; return () => { timer = null; }; },
      ...options,
    });
    // 往前走 ms：到点的定时器跑一次（跑的时候可能又排了下一个）。
    const advance = async (ms: number) => {
      const end = now + ms;
      while (timer && timer.at <= end) {
        const due = timer;
        timer = null;
        now = due.at;
        due.run();
        await Promise.resolve();
        await Promise.resolve();
      }
      now = end;
    };
    return { made, lines, changes, advance, clock: () => now };
  }

  it("opens after three consecutive failures and says when it tries again", () => {
    const { made, lines, changes } = breaker();
    expect(made.failed("turn", UPSTREAM_503)).toBe(false);
    expect(made.failed("compaction", UPSTREAM_503)).toBe(false);
    expect(made.failed("turn", UPSTREAM_503)).toBe(true);
    expect(made.held).toBe(true);
    expect(made.state).toMatchObject({ kind: "breaker", source: "turn" });
    expect(made.nextAttemptAt()).toBe(5 * MINUTE);
    expect(changes).toEqual([true]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[sched\] model\.hold action=opened failures=3 kind=unavailable retry_in_s=300 /u);
  });

  it("starts the count again after a call that answered", () => {
    const { made } = breaker();
    made.failed("turn", UPSTREAM_503);
    made.failed("turn", UPSTREAM_503);
    made.lift("lead_turn");
    made.failed("turn", UPSTREAM_503);
    made.failed("turn", UPSTREAM_503);
    expect(made.held).toBe(false);
  });

  it("does not count a failure of this machine's network", () => {
    const { made } = breaker();
    for (let i = 0; i < 5; i += 1) made.failed("turn", "getaddrinfo ENOTFOUND api.example.com");
    expect(made.held).toBe(false);
  });

  it("lets one call through when the wait ends, and doubles the wait when that call fails", async () => {
    const { made, changes, advance, clock } = breaker();
    for (let i = 0; i < 3; i += 1) made.failed("turn", UPSTREAM_503);
    await advance(5 * MINUTE - 1);
    expect(made.held).toBe(true);
    await advance(1);
    expect(made.held).toBe(false);
    expect(changes).toEqual([true, false]);
    // 放出去的那一次失败了：重新停下，等 10 分钟。
    expect(made.failed("turn", UPSTREAM_503)).toBe(true);
    expect(made.nextAttemptAt()).toBe(clock() + 10 * MINUTE);
    // 一直失败：等待最长 4 小时。
    for (let i = 0; i < 10; i += 1) {
      await advance(made.nextAttemptAt()! - clock());
      made.failed("turn", UPSTREAM_503);
    }
    expect(made.nextAttemptAt()! - clock()).toBe(4 * 60 * MINUTE);
    // 放出去的那一次答上了：解除，重新数。
    await advance(4 * 60 * MINUTE);
    made.lift("lead_turn");
    expect(made.held).toBe(false);
    expect(made.state).toBeNull();
    expect(made.failed("turn", UPSTREAM_503)).toBe(false);
  });

  it("checks for free every minute while the model service is unreachable, and lets a call through as soon as it is back", async () => {
    let up = false;
    let checks = 0;
    const { made, changes, advance, clock } = breaker({ reachable: async () => { checks += 1; return up; } });
    for (let i = 0; i < 3; i += 1) made.failed("turn", REFUSED);
    // 连不上：每分钟看一眼，不放调用。过了 5 分钟的等待也不放。
    await advance(30 * MINUTE);
    expect(checks).toBe(30);
    expect(made.held).toBe(true);
    expect(changes).toEqual([true]);
    // 模型服务回来了：下一分钟的那一眼看到，马上放一次调用，不等到点。
    up = true;
    await advance(MINUTE);
    expect(made.held).toBe(false);
    expect(changes).toEqual([true, false]);
    // 放出去的调用还是失败（连得上，可是服务不对）：重新停下，按等待（10 分钟）再放，不是每分钟放一次。
    made.failed("turn", REFUSED);
    const reopenedAt = clock();
    await advance(9 * MINUTE);
    expect(made.held).toBe(true);
    await advance(MINUTE);
    expect(made.held).toBe(false);
    expect(clock() - reopenedAt).toBe(10 * MINUTE);
  });

  it("makes no model call at all while the model service stays unreachable for 48 hours", async () => {
    const { made, advance } = breaker({ reachable: async () => false });
    let calls = 0;
    for (let t = 0; t < 48 * 60 * MINUTE; t += 30_000) {
      if (!made.held) {
        calls += 1;
        made.failed("turn", REFUSED);
      }
      await advance(30_000);
    }
    expect(calls).toBe(3);
  });

  it("does not enter the account hold when the system switched to another model", () => {
    const { made } = breaker();
    expect(made.failed("turn", DISABLED, { alternative: true })).toBe(false);
    expect(made.held).toBe(false);
    expect(made.failures).toBe(1);
    // 没有别的模型可换了：整体暂停。
    expect(made.failed("turn", DISABLED)).toBe(true);
    expect(made.state).toMatchObject({ kind: "account" });
  });

  it("makes about twenty calls in 48 hours when every call fails", async () => {
    const { made, advance } = breaker();
    let calls = 0;
    // daemon 每 5 秒看一次有没有事要做；没被拦着就调一次模型，失败。
    for (let t = 0; t < 48 * 60 * MINUTE; t += 5_000) {
      if (!made.held) {
        calls += 1;
        made.failed("turn", UPSTREAM_503);
      }
      await advance(5_000);
    }
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(calls).toBeLessThanOrEqual(25);
  });

  it("keeps an account-level hold until the user's turn answers, with no timed release", async () => {
    const { made, advance } = breaker();
    for (let i = 0; i < 3; i += 1) made.failed("turn", UPSTREAM_503);
    made.failed("turn", DISABLED);
    expect(made.state).toMatchObject({ kind: "account" });
    expect(made.nextAttemptAt()).toBeNull();
    await advance(24 * 60 * MINUTE);
    expect(made.held).toBe(true);
    made.lift("user_turn");
    expect(made.held).toBe(false);
  });

  it("pauses for the budget until the window ends or the user resumes", async () => {
    const { made, lines, advance } = breaker();
    made.pause(60 * MINUTE, "120 automatic calls in the last hour (limit 120)");
    expect(made.held).toBe(true);
    expect(made.state).toMatchObject({ kind: "budget" });
    expect(made.nextAttemptAt()).toBe(60 * MINUTE);
    expect(lines[0]).toMatch(/^\[sched\] model\.hold action=paused kind=budget /u);
    // 模型答上了（用户自己的一轮）不解除预算的暂停。
    made.lift("user_turn");
    expect(made.held).toBe(true);
    made.resume("user");
    expect(made.held).toBe(false);
    made.pause(60 * MINUTE, "again");
    await advance(60 * MINUTE);
    expect(made.held).toBe(false);
  });
});
