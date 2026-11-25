// When the daemon wakes Lead for ordinary system events (wake-pace.ts, 2026-11-16).
import { describe, expect, it } from "vitest";
import { autoCallUsageLine, wakePaceDecision, type WakePaceFacts } from "../src/wake-pace.js";

const MINUTE = 60_000;
const WARM = 4.5 * MINUTE;
const facts = (over: Partial<WakePaceFacts>): WakePaceFacts => ({
  now: 100 * MINUTE, coldBatchMs: 30 * MINUTE, lastModelCallAt: null, warmMs: WARM, firstWaitingAt: 100 * MINUTE, urgent: false, ...over,
});

describe("wakePaceDecision", () => {
  it("wakes at once when the setting is off", () => {
    expect(wakePaceDecision(facts({ coldBatchMs: 0 }))).toEqual({ wake: true, why: "off" });
  });

  it("wakes at once while the cache is warm, also with a window set", () => {
    expect(wakePaceDecision(facts({ lastModelCallAt: 100 * MINUTE - WARM }))).toEqual({ wake: true, why: "warm" });
    expect(wakePaceDecision(facts({ lastModelCallAt: 100 * MINUTE - WARM - 1 }))).toEqual({ wake: false, at: 130 * MINUTE });
  });

  it("waits for the window on a cold cache, counted from the first waiting event", () => {
    expect(wakePaceDecision(facts({ firstWaitingAt: 90 * MINUTE }))).toEqual({ wake: false, at: 120 * MINUTE });
    expect(wakePaceDecision(facts({ firstWaitingAt: 70 * MINUTE }))).toEqual({ wake: true, why: "window_end" });
    // The daemon was down for hours: what waited that long goes out at once.
    expect(wakePaceDecision(facts({ firstWaitingAt: 0 }))).toEqual({ wake: true, why: "window_end" });
  });

  it("gathers events that arrive close together, warm or cold, when a gather window is set", () => {
    const SECOND = 1_000;
    const warm = { lastModelCallAt: 100 * MINUTE - MINUTE, gatherMs: 20 * SECOND };
    expect(wakePaceDecision(facts({ ...warm, coldBatchMs: 0 }))).toEqual({ wake: false, at: 100 * MINUTE + 20 * SECOND });
    expect(wakePaceDecision(facts({ ...warm, firstWaitingAt: 100 * MINUTE - 20 * SECOND }))).toEqual({ wake: true, why: "gathered" });
    // Cold with a cold window: the longer cold rule holds.
    expect(wakePaceDecision(facts({ gatherMs: 20 * SECOND }))).toEqual({ wake: false, at: 130 * MINUTE });
    // Cold without a cold window: the gather window still merges neighbours.
    expect(wakePaceDecision(facts({ coldBatchMs: 0, gatherMs: 20 * SECOND }))).toEqual({ wake: false, at: 100 * MINUTE + 20 * SECOND });
    expect(wakePaceDecision(facts({ ...warm, urgent: true }))).toEqual({ wake: true, why: "urgent" });
    expect(wakePaceDecision(facts({ ...warm, coldBatchMs: 0, gatherMs: 0 }))).toEqual({ wake: true, why: "off" });
  });

  it("never holds something urgent", () => {
    expect(wakePaceDecision(facts({ urgent: true }))).toEqual({ wake: true, why: "urgent" });
  });

  it("counts an event without a time, or with a time in the future, as arrived now", () => {
    expect(wakePaceDecision(facts({ firstWaitingAt: null }))).toEqual({ wake: false, at: 130 * MINUTE });
    expect(wakePaceDecision(facts({ firstWaitingAt: 500 * MINUTE }))).toEqual({ wake: false, at: 130 * MINUTE });
  });

  // One event every 8 minutes for a day, each handled in one call that ends at once. Without a window every wake is a
  // cold start (8 minutes is longer than the cache lasts). A larger window never makes more cold starts.
  it("makes fewer cold starts with a larger window, and never more", () => {
    const coldStarts = (windowMinutes: number) => {
      let lastCall: number | null = null;
      let cold = 0;
      const waiting: number[] = [];
      for (let now = 0; now < 24 * 60 * MINUTE; now += MINUTE) {
        if (now % (8 * MINUTE) === 0) waiting.push(now);
        if (!waiting.length) continue;
        const decision = wakePaceDecision({ now, coldBatchMs: windowMinutes * MINUTE, lastModelCallAt: lastCall, warmMs: WARM, firstWaitingAt: waiting[0]!, urgent: false });
        if (!decision.wake) continue;
        if (lastCall === null || now - lastCall > WARM) cold += 1;
        lastCall = now;
        waiting.length = 0;
      }
      return cold;
    };
    const counts = [0, 10, 30, 60, 240].map(coldStarts);
    expect(counts[0]).toBe(180);
    expect(counts[2]).toBeLessThanOrEqual(48);
    expect(counts[3]).toBeLessThanOrEqual(24);
    for (let i = 1; i < counts.length; i += 1) expect(counts[i]!).toBeLessThanOrEqual(counts[i - 1]!);
  });
});

describe("autoCallUsageLine", () => {
  it("gives the counts, the user's limits and the pace in one line", () => {
    const line = autoCallUsageLine({
      callsLastHour: 9, callsLastDay: 41, uncachedTokensLastDay: 1_240_000,
      limits: { callsPerHour: 30, callsPerDay: 300, uncachedTokensPerDay: 0 }, coldBatchMinutes: 30,
    });
    expect(line).toContain("最近一小时 9/30 次");
    expect(line).toContain("最近一天 41/300 次");
    expect(line).toContain("没命中缓存的输入 1.2M token");
    expect(line).toContain("缓存冷了以后攒 30 分钟");
    expect(line).toContain("wake_pace.set");
  });

  it("leaves out a limit that is off, and says when nothing waits", () => {
    const line = autoCallUsageLine({
      callsLastHour: 2, callsLastDay: 2, uncachedTokensLastDay: 800,
      limits: { callsPerHour: 0, callsPerDay: 0, uncachedTokensPerDay: 50_000_000 }, coldBatchMinutes: 0,
    });
    expect(line).toContain("最近一小时 2 次");
    expect(line).toContain("没命中缓存的输入 800/50.0M token");
    expect(line).toContain("节奏：不攒");
  });
});
