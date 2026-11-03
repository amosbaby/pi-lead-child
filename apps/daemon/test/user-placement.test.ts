// 用户的消息放在哪里（lead-tools-and-routing spec D16）：带着外部内容的一轮不吞下用户的消息，用户本人开的一轮除外。
import { describe, expect, it } from "vitest";
import { userMessagePlacement } from "../src/user-placement.js";

const running = { busy: true, external: false, ownUserTurn: false, externalMessage: false, followUp: false };

describe("where a user's message goes while Lead is busy", () => {
  it("starts a turn when Lead is idle", () => {
    expect(userMessagePlacement({ ...running, busy: false })).toBe("start");
    expect(userMessagePlacement({ ...running, busy: false, external: true, externalMessage: true, followUp: true })).toBe("start");
  });

  it("steers or queues into the running turn when that turn read no external content", () => {
    expect(userMessagePlacement(running)).toBe("steer");
    expect(userMessagePlacement({ ...running, followUp: true })).toBe("follow_up");
  });

  // 回归（2026-10-27 21:05）：跟进轮次读了 Slack，用户插话「1 分钟后提醒我」被当成外部的一轮，设提醒被拒。
  it("waits for a turn of its own when a turn the user did not start read external content, whether the user steered or queued", () => {
    expect(userMessagePlacement({ ...running, external: true })).toBe("own_turn_after");
    expect(userMessagePlacement({ ...running, external: true, followUp: true })).toBe("own_turn_after");
  });

  // 回归（2026-11-03）：用户本人的一轮读了 GitHub，用户的两条纠正等到这一轮做完才送到。
  it("steers or queues into the user's own turn that only read connection or conversation results", () => {
    const own = { ...running, ownUserTurn: true, external: true };
    expect(userMessagePlacement(own)).toBe("steer");
    expect(userMessagePlacement({ ...own, followUp: true })).toBe("follow_up");
  });

  it("still waits when the user's own turn carries an external message's text", () => {
    const own = { ...running, ownUserTurn: true, external: true, externalMessage: true };
    expect(userMessagePlacement(own)).toBe("own_turn_after");
    expect(userMessagePlacement({ ...own, followUp: true })).toBe("own_turn_after");
  });
});
