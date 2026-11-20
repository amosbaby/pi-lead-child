// The daemon's glue to the background health (background-health-wiring.ts): what the decision LLM's hooks report, and
// when a change of the resolved background model makes Hindsight's automatic slot reconcile.
import { describe, expect, it } from "vitest";
import type { BackgroundCallResult } from "@pi-lead-child/engine";
import { backgroundModelHealthHooks, resolvedModelWatch } from "../src/background-health-wiring.js";

describe("backgroundModelHealthHooks", () => {
  it("reports a failure with what the call did next, and a success as ok, on the job background_model", () => {
    const reports: Array<[string, BackgroundCallResult]> = [];
    const hooks = backgroundModelHealthHooks({ report: (job, result) => { reports.push([job, result]); } });
    hooks.onBackgroundFailure("magpie/a", "config", "404 unknown model", "magpie/b");
    hooks.onBackgroundFailure("magpie/b", "quota", "429 quota", null);
    hooks.onBackgroundSuccess("magpie/b");
    expect(reports).toEqual([
      ["background_model", { ok: false, reasonClass: "config", reason: "404 unknown model", action: "switched to magpie/b" }],
      ["background_model", { ok: false, reasonClass: "quota", reason: "429 quota", action: "no other cheap model" }],
      ["background_model", { ok: true }],
    ]);
  });
});

describe("resolvedModelWatch", () => {
  it("takes the first value as the baseline and calls back only when the resolved model changes", () => {
    const changes: Array<[string | null, string | null]> = [];
    const watch = resolvedModelWatch((before, after) => changes.push([before, after]));
    watch("magpie/luna");
    watch("magpie/luna");
    expect(changes).toEqual([]);
    watch("magpie/terra");
    watch(null);
    watch(null);
    watch("magpie/luna");
    expect(changes).toEqual([["magpie/luna", "magpie/terra"], ["magpie/terra", null], [null, "magpie/luna"]]);
  });

  it("treats null as a real first value", () => {
    const changes: Array<[string | null, string | null]> = [];
    const watch = resolvedModelWatch((before, after) => changes.push([before, after]));
    watch(null);
    watch("magpie/luna");
    expect(changes).toEqual([[null, "magpie/luna"]]);
  });
});
