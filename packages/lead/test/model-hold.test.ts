// 模型暂停（model-hold.ts，2026-11-15）：账号级的失败进入暂停，别的失败不进；用户的一轮答上了才解除。进入和解除各写一行日志。
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

  it("ignores failures that the existing backoffs handle", () => {
    const { made, lines } = hold();
    for (const error of [
      "429 Too Many Requests", "503 Service Unavailable", '403: {"type":"forbidden","message":"Request not allowed"}',
      "getaddrinfo ENOTFOUND api.example.com", "Context overflow: 上下文满了，回答被截成空的",
    ]) {
      expect(made.failed("turn", error), error).toBe(false);
    }
    expect(made.held).toBe(false);
    expect(lines).toEqual([]);
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
