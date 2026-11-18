// /compact in the message box (2026-11-18): the composer turns it into lead_context / compact, not a message to Lead.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  CompactLeadContextRequestSchema, CompactLeadContextResultSchema, parseCompactCommand, UI_ACTION_INPUT_SCHEMAS, UI_ACTION_TARGET_TYPES,
} from "../src/index.ts";

describe("parseCompactCommand", () => {
  it.each([
    ["/compact", {}],
    ["  /COMPACT  ", {}],
    ["/compact acme/gpt-6-luna", { model: "acme/gpt-6-luna" }],
    ["/compact vibeproxy/as4/claude-haiku-5 keep the details of ticket 12", {
      model: "vibeproxy/as4/claude-haiku-5", instructions: "keep the details of ticket 12",
    }],
    // No slash in the first word: it is not a model, all of it is instructions.
    ["/compact 保留工单 12 的细节", { instructions: "保留工单 12 的细节" }],
    ["/compact\nkeep the plan", { instructions: "keep the plan" }],
  ] as const)("%s", (text, expected) => {
    const parsed = parseCompactCommand(text);
    expect(parsed).toEqual(expected);
    expect(Value.Check(CompactLeadContextRequestSchema, parsed)).toBe(true);
  });

  it.each(["compact", "/compactly", "/model", "please /compact", "/compact-now"])("is not the command: %s", (text) => {
    expect(parseCompactCommand(text)).toBeNull();
  });

  it("keeps long instructions within the limit of the request", () => {
    const parsed = parseCompactCommand(`/compact ${"x".repeat(5_000)}`);
    expect(Value.Check(CompactLeadContextRequestSchema, parsed)).toBe(true);
  });
});

describe("the lead_context operation on the wire", () => {
  it("is a UI action target with a compact input", () => {
    expect(UI_ACTION_TARGET_TYPES).toContain("lead_context");
    expect(UI_ACTION_INPUT_SCHEMAS.lead_context.compact).toBe(CompactLeadContextRequestSchema);
    expect(Value.Check(CompactLeadContextRequestSchema, { model: "acme/gpt-6-luna", extra: true })).toBe(false);
  });

  it("answers now, after the turn, nothing to compact, or held", () => {
    for (const applied of ["now", "after_turn", "nothing_to_compact", "held"]) {
      expect(Value.Check(CompactLeadContextResultSchema, { applied, model: "acme/m", tokensBefore: null, existing: false, reason: null })).toBe(true);
    }
    expect(Value.Check(CompactLeadContextResultSchema, { applied: "later", model: "acme/m", tokensBefore: 1, existing: false, reason: null })).toBe(false);
  });
});
