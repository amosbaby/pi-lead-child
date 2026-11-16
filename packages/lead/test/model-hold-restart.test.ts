// The model hold and the budget across a daemon restart (2026-11-16). Both lived only in memory: each restart gave Lead
// three more failed calls before the breaker opened, and a budget that started at zero. On 2026-11-15 the daemon
// restarted about 400 times in a crash loop. Here one "machine" keeps the saved state (the daemon keeps it in the
// database) and each boot() is a new daemon process that restores it.
import { describe, expect, it } from "vitest";
import { AutoCallBudget, type AutoCallBudgetSnapshot } from "../src/auto-call-budget.js";
import { ModelHold, type ModelHoldSnapshot } from "../src/model-hold.js";

const UPSTREAM_503 = "503 Service Unavailable: upstream connect error";
const DISABLED = "403 This service has been disabled in this account for violation of Terms of Service.";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function machine() {
  let now = 0;
  let saved: unknown = null;
  let timer: { at: number; run: () => void } | null = null;
  const lines: string[] = [];
  // A new daemon process: the timers of the old one are gone, the saved state is read back.
  const boot = () => {
    timer = null;
    const changes: boolean[] = [];
    const made = new ModelHold({
      log: (line) => lines.push(line), onChange: (held) => changes.push(held), now: () => now,
      setTimer: (run, ms) => { timer = { at: now + ms, run }; return () => { timer = null; }; },
      // What the daemon does: JSON into a kv row.
      onPersist: (snapshot) => { saved = JSON.parse(JSON.stringify(snapshot)); },
    });
    const restored = made.restore(saved);
    return { made, changes, restored };
  };
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
  return { boot, advance, lines, clock: () => now, saved: () => saved as ModelHoldSnapshot | null, corrupt: (value: unknown) => { saved = value; } };
}

describe("the model hold across a daemon restart", () => {
  it("keeps an open breaker: no automatic call until the wait ends, then one, and the wait still doubles", async () => {
    const world = machine();
    const first = world.boot();
    for (let i = 0; i < 3; i += 1) first.made.failed("turn", UPSTREAM_503);
    expect(first.made.held).toBe(true);
    await world.advance(2 * MINUTE);

    const second = world.boot();
    expect(second.restored).toBe(true);
    expect(second.made.held).toBe(true);
    expect(second.changes).toEqual([true]);
    expect(second.made.failures).toBe(3);
    expect(second.made.nextAttemptAt()).toBe(5 * MINUTE);
    expect(world.lines.at(-1)).toMatch(/^\[sched\] model\.hold action=restored kind=breaker failures=3 retry_in_s=180 /u);
    await world.advance(3 * MINUTE - 1);
    expect(second.made.held).toBe(true);
    await world.advance(1);
    expect(second.made.held).toBe(false);
    // The one call fails: 10 minutes now. A restart in that wait keeps the 10 minutes.
    expect(second.made.failed("turn", UPSTREAM_503)).toBe(true);
    expect(second.made.nextAttemptAt()).toBe(world.clock() + 10 * MINUTE);
    const third = world.boot();
    expect(third.made.nextAttemptAt()).toBe(world.clock() + 10 * MINUTE);
    await world.advance(10 * MINUTE);
    expect(third.made.failed("turn", UPSTREAM_503)).toBe(true);
    expect(third.made.nextAttemptAt()).toBe(world.clock() + 20 * MINUTE);
  });

  it("lets a restart after the wait ended make one call, not three", async () => {
    const world = machine();
    const first = world.boot();
    for (let i = 0; i < 3; i += 1) first.made.failed("turn", UPSTREAM_503);
    // The daemon is down for two hours.
    await world.advance(2 * HOUR);
    const second = world.boot();
    expect(second.made.held).toBe(true);
    await world.advance(0);
    expect(second.made.held).toBe(false);
    expect(second.made.failed("turn", UPSTREAM_503)).toBe(true);
    expect(second.made.held).toBe(true);
  });

  // The crash loop of 2026-11-15: about 400 restarts while every model call failed.
  it("makes three calls in a crash loop of 400 restarts, where the hold in memory made 1,200", async () => {
    const crashLoop = async (persist: boolean) => {
      const world = machine();
      let calls = 0;
      for (let restart = 0; restart < 400; restart += 1) {
        if (!persist) world.corrupt(null);
        const { made } = world.boot();
        // After each start the daemon wakes Lead for its events until something stops it.
        for (let wake = 0; wake < 5 && !made.held; wake += 1) {
          calls += 1;
          made.failed("turn", UPSTREAM_503);
        }
        await world.advance(500);
      }
      return calls;
    };
    expect(await crashLoop(false)).toBe(1_200);
    expect(await crashLoop(true)).toBe(3);
  });

  it("keeps an account-level hold until the user's turn answers, and tells the daemon only once per process", async () => {
    const world = machine();
    world.boot().made.failed("turn", DISABLED);
    for (let restart = 0; restart < 3; restart += 1) {
      await world.advance(6 * HOUR);
      const { made, changes } = world.boot();
      expect(made.held).toBe(true);
      expect(made.state).toMatchObject({ kind: "account", retryAt: null, since: 0 });
      expect(changes).toEqual([true]);
    }
    const last = world.boot();
    last.made.lift("user_turn");
    expect(world.saved()).toMatchObject({ state: null, failures: 0 });
    expect(world.boot().restored).toBe(false);
  });

  it("keeps a budget pause until its window ends, and drops one whose window ended while the daemon was down", async () => {
    const world = machine();
    world.boot().made.pause(HOUR, "4 automatic model calls in the last hour (limit 4)");
    await world.advance(20 * MINUTE);
    const second = world.boot();
    expect(second.made.state).toMatchObject({ kind: "budget", retryAt: HOUR });
    await world.advance(40 * MINUTE);
    expect(second.made.held).toBe(false);
    expect(world.saved()).toMatchObject({ state: null });

    world.boot().made.pause(world.clock() + HOUR, "again");
    await world.advance(2 * HOUR + 1);
    // No timer ran in the old process (it was down); the new one sees that the window ended.
    world.corrupt({ ...world.saved()!, state: { kind: "budget", since: 0, source: "turn", error: "again", retryAt: world.clock() - 1 } });
    const third = world.boot();
    expect(third.restored).toBe(false);
    expect(third.made.held).toBe(false);
  });

  it("carries the count of failures over a restart, but not failures older than the longest wait", async () => {
    const world = machine();
    const first = world.boot();
    first.made.failed("turn", UPSTREAM_503);
    first.made.failed("turn", UPSTREAM_503);
    const second = world.boot();
    expect(second.made.held).toBe(false);
    expect(second.made.failures).toBe(2);
    expect(second.made.failed("turn", UPSTREAM_503)).toBe(true);

    const other = machine();
    const a = other.boot();
    a.made.failed("turn", UPSTREAM_503);
    a.made.failed("turn", UPSTREAM_503);
    await other.advance(4 * HOUR + 1);
    const b = other.boot();
    expect(b.made.failures).toBe(0);
    expect(b.made.failed("turn", UPSTREAM_503)).toBe(false);
  });

  it("ignores a saved value that is not a snapshot", () => {
    for (const value of [null, "x", 7, [], {}, { version: 2, at: 0, state: null, failures: 0, reopens: 0 },
      { version: 1, at: 0, failures: 3, reopens: 0, state: { kind: "breaker", since: 0, source: "turn", error: "e", retryAt: null } },
      { version: 1, at: 0, failures: -1, reopens: 0, state: null },
      { version: 1, at: 0, failures: 3, reopens: 0, state: { kind: "nope", since: 0, source: "turn", error: "e", retryAt: 5 } }]) {
      const world = machine();
      world.corrupt(value);
      const { made, restored } = world.boot();
      expect(restored, JSON.stringify(value)).toBe(false);
      expect(made.held).toBe(false);
      expect(made.failures).toBe(0);
    }
  });

  it("saves on each change, and not on a success that changes nothing", () => {
    let writes = 0;
    const made = new ModelHold({ log: () => {}, now: () => 0, setTimer: () => () => {}, onPersist: () => { writes += 1; } });
    made.lift("lead_turn");
    made.lift("user_turn");
    expect(writes).toBe(0);
    made.failed("turn", UPSTREAM_503);
    expect(writes).toBe(1);
    made.lift("lead_turn");
    expect(writes).toBe(2);
    made.lift("lead_turn");
    expect(writes).toBe(2);
  });
});

describe("the budget for automatic calls across a daemon restart", () => {
  it("goes on counting: a restart does not give a new budget", () => {
    let now = 0;
    let saved: AutoCallBudgetSnapshot | null = null;
    const limits = { callsPerHour: 10, callsPerDay: 0, uncachedTokensPerDay: 0 };
    const boot = () => new AutoCallBudget({ limits, now: () => now, saved, onRecord: (calls) => { saved = JSON.parse(JSON.stringify(calls)) as AutoCallBudgetSnapshot; } });
    // Six calls, a restart, then the limit is four calls away, not ten.
    let budget = boot();
    for (let i = 0; i < 6; i += 1) { now += MINUTE; expect(budget.record(1_000)).toBeNull(); }
    budget = boot();
    expect(budget.usage()).toEqual({ callsLastHour: 6, callsLastDay: 6, uncachedTokensLastDay: 6_000 });
    for (let i = 0; i < 3; i += 1) { now += MINUTE; expect(budget.record(1_000)).toBeNull(); }
    now += MINUTE;
    expect(budget.record(1_000)).toMatchObject({ limit: "callsPerHour" });
    // A restart while over the limit: still over.
    expect(boot().exceeded()).toMatchObject({ limit: "callsPerHour" });
  });

  it("drops saved calls that left the window, and ignores a saved value that is not a list of calls", () => {
    const now = 30 * HOUR;
    const saved = [[1 * HOUR, 500], [29 * HOUR, 700], [now + HOUR, 900], ["x", 1], [2, "y"], 5, null];
    expect(new AutoCallBudget({ now: () => now, saved }).snapshot()).toEqual([[29 * HOUR, 700]]);
    for (const value of [null, "x", {}, 5]) expect(new AutoCallBudget({ now: () => now, saved: value }).snapshot()).toEqual([]);
  });
});

describe("the error that callers get while a hold is on", () => {
  // 2026-11-16: a budget pause was reported as "the Lead model account failed".
  it("names the kind of hold", async () => {
    const { MODEL_HOLD_ERROR, modelHoldError } = await import("../src/model-hold.js");
    expect(modelHoldError({ kind: "account", retryAt: null })).toBe(MODEL_HOLD_ERROR);
    expect(modelHoldError(null)).toBe(MODEL_HOLD_ERROR);
    expect(modelHoldError({ kind: "budget", retryAt: Date.UTC(2026, 10, 16, 7, 48, 8) }))
      .toBe("model hold: the budget for automatic model calls is used up; automatic model calls wait until 2026-11-16T07:48:08.000Z");
    expect(modelHoldError({ kind: "breaker", retryAt: Date.UTC(2026, 10, 16, 8, 0, 0) }))
      .toBe("model hold: model calls keep failing; the next automatic model call is at 2026-11-16T08:00:00.000Z");
  });
});
