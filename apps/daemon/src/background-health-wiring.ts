// The daemon's glue between the background jobs and the background health (engine's background-health.ts,
// .scratch/background-models/spec.md D3). Three jobs report their outcomes:
//   - background_model: the decision LLM's calls (lead's smart-model.ts BackgroundModelHooks). A failure says what the
//     call did next: it moved to another cheap model, or there was none.
//   - channel_memory: a real extraction or hand-off to Hindsight (engine's channels/memory.ts onOutcome).
//   - hindsight: a write operation that completed or failed (engine's notes-memory.ts onWriteOutcome).
// It also watches the resolved background model: when it changes without background_model.set (a subscription switch,
// a new release, a model marked broken), Hindsight's automatic slot reconciles as after a set.
import type { BackgroundHealth } from "@pi-lead-child/engine";
import type { BackgroundModelHooks } from "@pi-lead-child/lead";

/** The decision LLM's health hooks: every call outcome goes to the job background_model. */
export function backgroundModelHealthHooks(health: Pick<BackgroundHealth, "report">): Required<BackgroundModelHooks> {
  return {
    onBackgroundFailure: (_model, reasonClass, reason, switchedTo) => {
      health.report("background_model", {
        ok: false, reasonClass, reason, action: switchedTo ? `switched to ${switchedTo}` : "no other cheap model",
      });
    },
    onBackgroundSuccess: () => {
      health.report("background_model", { ok: true });
    },
  };
}

/**
 * Calls onChange when the resolved background model differs from the one seen last time. The first value is the
 * baseline (Hindsight resolves its slot when it starts). Returns the function to call with each newly resolved model.
 */
export function resolvedModelWatch(onChange: (before: string | null, after: string | null) => void): (resolved: string | null) => void {
  let last: { spec: string | null } | null = null;
  return (resolved) => {
    const before = last;
    last = { spec: resolved };
    if (before && before.spec !== resolved) onChange(before.spec, resolved);
  };
}
