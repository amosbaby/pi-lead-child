// /compact in the message box (2026-11-18): the composer turns it into lead_context / compact, not a message to Lead.
// Syntax: /compact [model words] [-- instructions]. The daemon resolves the model words against the catalog.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  CompactLeadContextRequestSchema, CompactLeadContextResultSchema, compactModelKey, parseCompactCommand, resolveCompactModel,
  UI_ACTION_INPUT_SCHEMAS, UI_ACTION_TARGET_TYPES,
} from "../src/index.ts";

describe("parseCompactCommand", () => {
  it.each([
    ["/compact", {}],
    ["  /COMPACT  ", {}],
    ["/compact acme/gpt-6-luna", { model: "acme/gpt-6-luna" }],
    // Review 2026-11-18 (item 1): the user's own words name the model; they are never instructions.
    ["/compact gpt 6 luna", { model: "gpt 6 luna" }],
    ["/compact luna", { model: "luna" }],
    ["/compact gpt-6-luna", { model: "gpt-6-luna" }],
    ["/compact 用 gpt 6 luna", { model: "用 gpt 6 luna" }],
    // Instructions only after a standalone "--".
    ["/compact vibeproxy/as4/claude-haiku-5 -- keep the details of ticket 12", {
      model: "vibeproxy/as4/claude-haiku-5", instructions: "keep the details of ticket 12",
    }],
    ["/compact -- 保留工单 12 的细节", { instructions: "保留工单 12 的细节" }],
    ["/compact gpt 6 luna --\nkeep the plan -- and the dates", { model: "gpt 6 luna", instructions: "keep the plan -- and the dates" }],
    ["/compact my--model", { model: "my--model" }],
  ] as const)("%s", (text, expected) => {
    const parsed = parseCompactCommand(text);
    expect(parsed).toEqual(expected);
    expect(Value.Check(CompactLeadContextRequestSchema, parsed)).toBe(true);
  });

  it.each(["compact", "/compactly", "/model", "please /compact", "/compact-now"])("is not the command: %s", (text) => {
    expect(parseCompactCommand(text)).toBeNull();
  });

  it("keeps long instructions within the limit of the request", () => {
    const parsed = parseCompactCommand(`/compact -- ${"x".repeat(5_000)}`);
    expect(Value.Check(CompactLeadContextRequestSchema, parsed)).toBe(true);
  });
});

describe("resolveCompactModel", () => {
  const catalog = [
    { spec: "openai-codex/gpt-6-luna" },
    { spec: "vibeproxy/as4/claude-haiku-5", name: "Claude Haiku 5" },
    { spec: "vibeproxy/as4/claude-sonnet-5" },
    { spec: "magpie/deepseek-v4.1-flash" },
  ];

  it("normalizes the words: lowercase, letters and digits only", () => {
    expect(compactModelKey("用 GPT 6 Luna")).toBe("gpt6luna");
  });

  it.each([
    ["openai-codex/gpt-6-luna", "openai-codex/gpt-6-luna"],
    ["openai-codex/gpt-6-luna(high)", "openai-codex/gpt-6-luna"],
    ["gpt 6 luna", "openai-codex/gpt-6-luna"],
    ["用 gpt 6 luna", "openai-codex/gpt-6-luna"],
    ["GPT-6-LUNA", "openai-codex/gpt-6-luna"],
    ["claude haiku 5", "vibeproxy/as4/claude-haiku-5"],
    ["as4/claude-sonnet-5", "vibeproxy/as4/claude-sonnet-5"],
    ["deepseek v4.1 flash", "magpie/deepseek-v4.1-flash"],
  ])("one match: %s", (words, spec) => {
    expect(resolveCompactModel(words, catalog)).toEqual({ kind: "one", spec });
  });

  it("refuses words that match several models and lists them as provider/id", () => {
    const several = [{ spec: "auto/gpt-6-luna" }, { spec: "codex/gpt-6-luna" }, { spec: "copilot/gpt-6-luna" }, { spec: "codex/gpt-6" }];
    expect(resolveCompactModel("gpt 6 luna", several)).toEqual({
      kind: "many", candidates: ["auto/gpt-6-luna", "codex/gpt-6-luna", "copilot/gpt-6-luna"],
    });
  });

  it("refuses words that match no model, with at most 5 close ones and never the whole catalog", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ spec: `acme/luna-${index}` })).concat([{ spec: "acme/zzz" }]);
    const resolved = resolveCompactModel("luna", many);
    expect(resolved.kind).toBe("none");
    expect(resolved.kind === "none" && resolved.candidates.length).toBe(5);
    expect(resolved.kind === "none" && resolved.candidates.every((spec) => spec.startsWith("acme/luna-"))).toBe(true);
    expect(resolveCompactModel("qqqq", catalog)).toEqual({ kind: "none", candidates: [] });
  });
});

describe("the lead_context operation on the wire", () => {
  it("is a UI action target with a compact input", () => {
    expect(UI_ACTION_TARGET_TYPES).toContain("lead_context");
    expect(UI_ACTION_INPUT_SCHEMAS.lead_context.compact).toBe(CompactLeadContextRequestSchema);
    expect(Value.Check(CompactLeadContextRequestSchema, { model: "acme/gpt-6-luna", extra: true })).toBe(false);
  });

  it("answers now, after the turn, nothing to compact, held, or a refused model", () => {
    const base = { model: "acme/m", tokensBefore: null, existing: false, requestApplied: true, candidates: [], reason: null };
    for (const applied of ["now", "after_turn", "nothing_to_compact", "held", "model_ambiguous", "model_unknown"]) {
      expect(Value.Check(CompactLeadContextResultSchema, { ...base, applied })).toBe(true);
    }
    expect(Value.Check(CompactLeadContextResultSchema, { ...base, applied: "later" })).toBe(false);
  });
});
