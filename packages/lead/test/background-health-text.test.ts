// 后台任务健康事件给 Lead 的文字（.scratch/background-models spec D3）：失败事件写明什么失败了、从什么时候起、
// 系统做了什么、Lead 能做什么，和折进来的其他任务；恢复事件在当前局面里只有一句。
import { describe, expect, it } from "vitest";
import { BACKGROUND_FAILING_KIND } from "@pi-lead-child/protocol";
import { backgroundRecoveredNote, leadEventBlock } from "../src/index.js";

const since = new Date(2026, 10, 20, 9, 0, 0).toISOString();

function failingEvent(payload: Record<string, unknown>) {
  return {
    seq: 42, kind: BACKGROUND_FAILING_KIND, source: "system", entityKey: "background:background_model",
    occurredAt: new Date(2026, 10, 20, 9, 6, 0).toISOString(), level: "tell",
    payload: {
      job: "background_model", reasonClass: "quota", reason: "429 <quota> exceeded", since, failures: 4,
      action: "switched to model cheap-b", operation: "background_model.set", folded: [], afterHold: false, ...payload,
    },
    rootCause: { code: "quota", scope: "background", message: "429 quota exceeded" },
  };
}

describe("background health text for Lead", () => {
  it("says what failed, since when, what the system did and what Lead can do", () => {
    const block = leadEventBlock(failingEvent({}));
    expect(block).toContain('topic="background_health"');
    expect(block).toContain("事件 #42");
    expect(block).toContain("（background_model）从 11-20 09:00 起一直失败");
    expect(block).toContain("失败了 4 次，原因类别 quota");
    expect(block).toContain("最近一次的原因：429 &lt;quota> exceeded");
    expect(block).toContain("系统已经做了：switched to model cheap-b");
    expect(block).toContain("perform_action(target_type='background_model', action='set')");
    expect(block).toContain("6 小时内不会再为它叫醒你");
    expect(block).not.toContain("另外还有");
  });

  it("lists the folded jobs, says when the event waited for the hold, and has a plain next step without an operation", () => {
    const block = leadEventBlock(failingEvent({
      job: "hindsight", operation: null, action: null, afterHold: true,
      folded: [{ job: "channel_memory", reasonClass: "auth", reason: "401", since }],
    }));
    expect(block).toContain("系统没有自动处理它");
    expect(block).toContain("没有你能直接用的操作");
    expect(block).toContain("暂停解除以后还在失败");
    expect(block).toContain("另外还有 1 个后台任务也转为失败");
    expect(block).toContain("（channel_memory）：原因类别 auth");
  });

  it("writes one sentence for a recovery", () => {
    const note = backgroundRecoveredNote({
      job: "channel_memory", reasonClass: "auth", since, recoveredAt: new Date(2026, 10, 20, 9, 30, 0).toISOString(), failures: 5,
    });
    expect(note).toContain("（channel_memory）在 11-20 09:30 恢复了");
    expect(note).toContain("失败了 5 次");
  });
});
