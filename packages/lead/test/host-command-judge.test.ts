// 免沙箱开着、这一轮带着外部内容时的模型判断（host-command-judge.ts，docs/ticket-246-user-turn-bypass.md 第 10 节）。
// 决策的边界：「不是用户交代的」而且「难撤回」才要用户确认；问不成时也要确认。交给模型的文字里没有外部内容的原文。
import { describe, expect, it } from "vitest";
import type { SmartModel } from "@pi-lead-child/engine";
import {
  HOST_COMMAND_JUDGE_PURPOSE, hostCommandJudgeState, hostCommandQuestions, judgeHostCommand, type HostCommandJudgeInput,
} from "../src/host-command-judge.js";

const input: HostCommandJudgeInput = {
  command: "git push origin HEAD:refs/heads/fix-tests", cwd: "/Users/alice/work/acme-x", reason: "用户让我把修复推上去",
  userRequests: ["把修复推到 PR 分支", "CI 为什么红了"], sources: ["tool call_connection_tool", "message from slack"],
};

function model(answers: { serves: unknown; hard: unknown } | Error) {
  const seen: Array<{ state: string; names: string[]; purpose: string | undefined }> = [];
  const fake = {
    backend: "fake-jev",
    decide: async (state: string, questions: Record<string, unknown>, opts?: { purpose?: string }) => {
      seen.push({ state, names: Object.keys(questions), purpose: opts?.purpose });
      if (answers instanceof Error) throw answers;
      return {
        backend: "fake-jev", model: null, latencyMs: 1, fallbackFrom: null,
        answers: {
          serves_user: { type: "yes_no", probability: answers.serves },
          hard_to_undo: { type: "yes_no", probability: answers.hard },
        },
      };
    },
  };
  return { fake: fake as unknown as SmartModel, seen };
}

describe("judgeHostCommand", () => {
  it("asks for the user's confirmation only when the command is not the user's and is hard to undo", async () => {
    const table: Array<[serves: number, hard: number, ask: boolean]> = [
      [0.9, 0.9, false], // 用户交代的，难撤回：跑。
      [0.9, 0.1, false],
      [0.1, 0.1, false], // 不是用户交代的，但撤得回：跑。
      [0.1, 0.9, true],
      [0.49, 0.5, true], // 边界：0.5 算「是」。
      [0.5, 0.5, false],
      // LLM 兜底只有是和否：「是」合成为 0.8，「否」合成为 0.2。
      [0.2, 0.8, true],
      [0.8, 0.8, false],
    ];
    for (const [serves, hard, ask] of table) {
      const judgement = await judgeHostCommand(input, model({ serves, hard }).fake);
      expect(judgement, `${serves}/${hard}`).toEqual({ by: "smart_model", ask, servesUser: serves, hardToUndo: hard, backend: "fake-jev" });
    }
  });

  it("gives the model the user's own words, the sources by name, the command and the reason, and both questions", async () => {
    const { fake, seen } = model({ serves: 0.9, hard: 0.1 });
    await judgeHostCommand(input, fake);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.purpose).toBe(HOST_COMMAND_JUDGE_PURPOSE);
    expect(seen[0]!.names).toEqual(Object.keys(hostCommandQuestions()));
    expect(seen[0]!.state).toBe(hostCommandJudgeState(input));
    for (const part of ["1. 把修复推到 PR 分支", "2. CI 为什么红了", "tool call_connection_tool; message from slack", input.command, input.cwd, input.reason!]) {
      expect(seen[0]!.state).toContain(part);
    }
  });

  it("says so in the text when there are no user messages or no reason", () => {
    const state = hostCommandJudgeState({ command: "ls", cwd: "/tmp", userRequests: [], sources: [] });
    expect(state).toContain("newest first:\n(none)");
    expect(state).toContain("(unknown)");
    expect(state).not.toContain("stated reason");
  });

  // 真模型评估（2026-11-11）：LLM 兜底偶尔回答的不是一个 JSON 对象。再问一次。
  it("asks once more when the first answer fails, and gives up after the second", async () => {
    let calls = 0;
    const flaky = {
      backend: "llm",
      decide: async () => {
        calls += 1;
        if (calls === 1) throw new Error("llm: invalid answer: reply is not a single JSON object");
        return {
          backend: "llm", model: null, latencyMs: 1, fallbackFrom: null,
          answers: { serves_user: { type: "yes_no", probability: 0.8 }, hard_to_undo: { type: "yes_no", probability: 0.2 } },
        };
      },
    } as unknown as SmartModel;
    expect(await judgeHostCommand(input, flaky)).toMatchObject({ by: "smart_model", ask: false });
    expect(calls).toBe(2);
    const failing = model(new Error("jev: HTTP 403"));
    expect(await judgeHostCommand(input, failing.fake)).toEqual({ by: "unavailable", reason: "jev: HTTP 403" });
    expect(failing.seen).toHaveLength(2);
  });

  it("is unavailable, with the reason, when there is no model, the model fails or its answer is not usable", async () => {
    expect(await judgeHostCommand(input, null)).toEqual({ by: "unavailable", reason: "没有配置决策模型" });
    expect(await judgeHostCommand(input, { backend: "none" } as unknown as SmartModel)).toMatchObject({ by: "unavailable" });
    expect(await judgeHostCommand(input, model(new Error("jev: timeout after 8000ms")).fake))
      .toEqual({ by: "unavailable", reason: "jev: timeout after 8000ms" });
    expect(await judgeHostCommand(input, model({ serves: "yes", hard: 0.9 }).fake)).toMatchObject({ by: "unavailable" });
    expect(await judgeHostCommand(input, model({ serves: 0.9, hard: Number.NaN }).fake)).toMatchObject({ by: "unavailable" });
  });
});
