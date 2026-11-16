// Lead 的订阅账号（模型配置方案 C 的 S2，src/subscriptions.ts）：账号名、分工的格子、pi-multi-pass 的 multi-pass.json、
// 按时间段的顺序，以及 D5 的账号失败记录。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  isLeadSubscriptionProvider, nextSubscriptionIndex, readMultiPassConfig, scheduledOrder, SubscriptionAccountTracker,
  subscriptionAccountOf, subscriptionAccounts, subscriptionPool, subscriptionSlotSpec, syncSubscriptionPool, writeMultiPassConfig,
  type MultiPassConfig, type MultiPassPool,
} from "../src/subscriptions.js";

const empty = (): MultiPassConfig => ({ subscriptions: [], pools: [], chains: [], presets: [] });

describe("subscription account names (D4)", () => {
  it("reads <base> as the first account and <base>-<n> as the n-th, and nothing else", () => {
    expect(subscriptionAccountOf("openai-codex")).toEqual({ base: "openai-codex", index: 1 });
    expect(subscriptionAccountOf("openai-codex-3")).toEqual({ base: "openai-codex", index: 3 });
    expect(subscriptionAccountOf("github-copilot-12")).toEqual({ base: "github-copilot", index: 12 });
    for (const other of ["openai", "openai-codex-1", "openai-codex-0", "openai-codex-02", "anthropic", "github-copilot-x", "vibeproxy"]) {
      expect(subscriptionAccountOf(other), other).toBeNull();
    }
    // D7：Lead 只用这两种订阅的 OAuth 登录。
    expect(isLeadSubscriptionProvider("github-copilot-2")).toBe(true);
    expect(isLeadSubscriptionProvider("anthropic")).toBe(false);
  });

  it("counts <base>-<n>/<id> as the same chain slot as <base>/<id> and keeps the effort", () => {
    expect(subscriptionSlotSpec("openai-codex-2/gpt-5.5")).toBe("openai-codex/gpt-5.5");
    expect(subscriptionSlotSpec("github-copilot/claude-sonnet-5(high)")).toBe("github-copilot/claude-sonnet-5(high)");
    expect(subscriptionSlotSpec("vibeproxy/as4/claude-sonnet-5")).toBe("vibeproxy/as4/claude-sonnet-5");
  });
});

describe("multi-pass.json in pi-multi-pass's own format", () => {
  it("keeps the fields it does not know when it writes the file back", () => {
    const dir = tempDir("plc-multi-pass-");
    writeFileSync(join(dir, "multi-pass.json"), JSON.stringify({
      subscriptions: [{ provider: "openai-codex", index: 2, label: "Work" }],
      pools: [], chains: [{ name: "mine" }], presets: [], statusBar: true, tokenKeeper: true,
    }));
    const config = readMultiPassConfig(dir);
    writeMultiPassConfig(dir, { ...config, subscriptions: [...config.subscriptions, { provider: "openai-codex", index: 3, label: "Home" }] });
    const written = JSON.parse(readFileSync(join(dir, "multi-pass.json"), "utf8"));
    expect(written).toMatchObject({ statusBar: true, tokenKeeper: true, chains: [{ name: "mine" }] });
    expect(written.subscriptions).toEqual([
      { provider: "openai-codex", index: 2, label: "Work" }, { provider: "openai-codex", index: 3, label: "Home" },
    ]);
  });

  it("reads a missing file as empty and refuses a broken one instead of overwriting it", () => {
    const dir = tempDir("plc-multi-pass-");
    expect(readMultiPassConfig(dir)).toEqual(empty());
    writeFileSync(join(dir, "multi-pass.json"), "{ not json");
    expect(() => readMultiPassConfig(dir)).toThrow();
  });

  it("lists the accounts in index order and picks the next free index", () => {
    const config: MultiPassConfig = {
      ...empty(),
      subscriptions: [
        { provider: "openai-codex", index: 3, label: "Home" }, { provider: "openai-codex", index: 2 },
        { provider: "github-copilot", index: 2, label: "Personal" },
      ],
    };
    expect(subscriptionAccounts(config, "openai-codex")).toEqual([
      { provider: "openai-codex", index: 1, label: null },
      { provider: "openai-codex-2", index: 2, label: null },
      { provider: "openai-codex-3", index: 3, label: "Home" },
    ]);
    expect(nextSubscriptionIndex(config, "openai-codex")).toBe(4);
    expect(nextSubscriptionIndex(config, "github-copilot", [3])).toBe(4);
  });

  it("creates the pool at two accounts and keeps its members and schedules in step with the accounts", () => {
    const one = syncSubscriptionPool(empty(), "openai-codex");
    expect(one.pools).toEqual([]);
    const two = syncSubscriptionPool({ ...empty(), subscriptions: [{ provider: "openai-codex", index: 2 }] }, "openai-codex");
    expect(subscriptionPool(two, "openai-codex")).toEqual({
      name: "openai-codex", baseProvider: "openai-codex", members: ["openai-codex", "openai-codex-2"], enabled: true, strategy: "round-robin",
    });
    const withSchedule: MultiPassConfig = {
      ...two,
      subscriptions: [{ provider: "openai-codex", index: 3 }],
      pools: [{ ...two.pools[0]!, memberSchedule: { "openai-codex-2": { role: "overflow" } } }],
    };
    const synced = subscriptionPool(syncSubscriptionPool(withSchedule, "openai-codex"), "openai-codex")!;
    expect(synced.members).toEqual(["openai-codex", "openai-codex-3"]);
    expect(synced.memberSchedule).toEqual({});
  });
});

describe("the scheduled order (pi-multi-pass's getScheduledMemberOrder)", () => {
  const pool: MultiPassPool = {
    name: "openai-codex", baseProvider: "openai-codex", enabled: true, strategy: "scheduled",
    members: ["openai-codex", "openai-codex-2", "openai-codex-3", "openai-codex-4"],
    memberSchedule: {
      "openai-codex-2": { role: "preferred", windows: [{ hours: [9, 18], days: ["mon", "tue", "wed", "thu", "fri"] }] },
      "openai-codex-3": { role: "overflow" },
      "openai-codex-4": { role: "preferred", windows: [{ hours: [22, 6] }] },
    },
  };
  const members = pool.members;

  it("puts a preferred account in its window first, default next and overflow last", () => {
    // 2026-11-16 是星期一。
    expect(scheduledOrder(pool, members, new Date(2026, 10, 16, 10, 0))).toEqual(["openai-codex-2", "openai-codex", "openai-codex-3"]);
  });

  it("skips a preferred account outside its window and handles a window across midnight", () => {
    expect(scheduledOrder(pool, members, new Date(2026, 10, 15, 23, 0))).toEqual(["openai-codex-4", "openai-codex", "openai-codex-3"]);
  });
});

describe("the account tracker (D5)", () => {
  it("offers the next untried account that is not cooling down, and none when all were tried", () => {
    let now = 1_000_000;
    const tracker = new SubscriptionAccountTracker({ now: () => now });
    const accounts = ["openai-codex", "openai-codex-2", "openai-codex-3"];
    tracker.failed("openai-codex", "429 Too Many Requests: usage limit reached");
    expect(tracker.nextAccount("openai-codex", accounts)).toBe("openai-codex-2");
    tracker.failed("openai-codex-2", "You have hit your usage limit. Try again in ~5 min");
    expect(tracker.nextAccount("openai-codex-2", accounts)).toBe("openai-codex-3");
    tracker.failed("openai-codex-3", "429 rate limit");
    expect(tracker.nextAccount("openai-codex-3", accounts)).toBeNull();
    expect(tracker.coolingUntil("openai-codex")).toBe(1_000_000 + 5 * 60_000);
    // 成功一次：这次故障结束；冷却按时间过去。
    tracker.succeeded("openai-codex-3");
    expect(tracker.nextAccount("openai-codex-3", accounts)).toBeNull();
    now += 5 * 60_000;
    expect(tracker.coolingUntil("openai-codex")).toBeNull();
    expect(tracker.nextAccount("openai-codex-3", accounts)).toBe("openai-codex");
  });

  it("remembers which account failed last, since pi-multi-pass may already have moved the session on", () => {
    const tracker = new SubscriptionAccountTracker();
    tracker.failed("openai-codex", "429 rate limit");
    expect(tracker.lastFailedAccount()).toBe("openai-codex");
    expect(tracker.usable("openai-codex")).toBe(false);
    expect(tracker.usable("openai-codex-2")).toBe(true);
    tracker.succeeded("openai-codex-2");
    expect(tracker.lastFailedAccount()).toBeNull();
  });

  it("ignores errors that another account would not fix and providers that are not subscription accounts", () => {
    const tracker = new SubscriptionAccountTracker();
    tracker.failed("openai-codex", "503 Service Unavailable");
    tracker.failed("vibeproxy", "429 rate limit");
    expect(tracker.coolingUntil("openai-codex")).toBeNull();
    expect(tracker.coolingUntil("vibeproxy")).toBeNull();
    tracker.failed("github-copilot", "401 Unauthorized");
    expect(tracker.coolingUntil("github-copilot")).not.toBeNull();
  });
});
