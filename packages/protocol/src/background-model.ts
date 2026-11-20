// The model that background work uses (.scratch/background-models/spec.md, user 2026-11-20).
//
// Background work is every model call that Lead does not make in a turn: the decision LLM (smart-model.ts in lead:
// channel memory, summaries, urgency), the compaction summary when it cannot use the provider's cache, and Hindsight's
// automatic summary slot. It must be a cheap model. Before, the code picked the newest model with "haiku" in its id. After
// the move to a gateway without haiku, the decision LLM used Lead's own, most expensive model.
//
// - Cheap is computed from the prices in Lead's model catalog (lead's background-model.ts cheapModels), never a fixed
//   list: the set changes when the user switches a subscription or a provider releases a model.
// - Setting, one kv row (lead.background_model), shared by all devices: { model: "provider/id" | null }. null is
//   automatic: the first cheap model. When no model is cheap: the cheapest priced model that is not more expensive than
//   Lead's model; else Lead's model.
// - The operation is background_model.set (engine's ui-actions/background-model.ts): the page route and Lead call the
//   same definition. lead_allowed, not a rule change. Lead may choose only a model that is cheap now; the user may
//   choose any model of the catalog.
// This file does not import index.ts (index.ts re-exports from here).
import { Type, type Static, type TProperties } from "typebox";
import { LEAD_SHADOW_MODEL_PATTERN } from "./lead-shadow.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const literalUnion = <const T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>(Type.Union(values.map((value) => Type.Literal(value))));

export const BACKGROUND_MODEL_RESOURCE = "background-model";

const ModelSpecSchema = Type.String({ minLength: 3, maxLength: 200, pattern: LEAD_SHADOW_MODEL_PATTERN });

export const BackgroundModelSettingSchema = StrictObject({
  model: Type.Union([ModelSpecSchema, Type.Null()]),
});
export type BackgroundModelSetting = Static<typeof BackgroundModelSettingSchema>;

export const DEFAULT_BACKGROUND_MODEL: BackgroundModelSetting = { model: null };

const MODEL_RE = new RegExp(LEAD_SHADOW_MODEL_PATTERN);

/** The setting from a stored or received value. Anything that is not a provider/model string reads as automatic. */
export function normalizeBackgroundModel(value: unknown): BackgroundModelSetting {
  const model = value !== null && typeof value === "object" ? (value as { model?: unknown }).model : undefined;
  if (typeof model !== "string") return { ...DEFAULT_BACKGROUND_MODEL };
  const trimmed = model.trim();
  return trimmed.length >= 3 && trimmed.length <= 200 && MODEL_RE.test(trimmed) ? { model: trimmed } : { ...DEFAULT_BACKGROUND_MODEL };
}

// background_model.set input (POST /v1/actions/background_model/lead/set).
export const SetBackgroundModelRequestSchema = BackgroundModelSettingSchema;
export type SetBackgroundModelRequest = Static<typeof SetBackgroundModelRequestSchema>;

/**
 * How the background model was chosen:
 *   setting: the stored choice; cheap: automatic, the first cheap model; cheapest: automatic, no model is cheap, the
 *   cheapest priced model that is not more expensive than Lead's; main: Lead's own model; none: no model is known.
 */
export const BACKGROUND_MODEL_SOURCES = ["setting", "cheap", "cheapest", "main", "none"] as const;
export type BackgroundModelSource = typeof BACKGROUND_MODEL_SOURCES[number];

// What background_model.read returns, and what the settings page will show.
export const BackgroundModelStateSchema = StrictObject({
  // The stored choice (null: automatic).
  setting: Type.Union([Type.String(), Type.Null()]),
  // The model background work uses now (provider/id), and how it was chosen.
  resolved: Type.Union([Type.String(), Type.Null()]),
  source: literalUnion(BACKGROUND_MODEL_SOURCES),
  // Lead's model, the reference for "cheap".
  main: Type.Union([Type.String(), Type.Null()]),
  // The cheap models now, in the order of the automatic choice.
  cheap: Type.Array(Type.String()),
  // Models that failed with a configuration or quota error and are skipped until `until` (ISO).
  broken: Type.Array(StrictObject({ model: Type.String(), until: Type.String(), reason: Type.String() })),
});
export type BackgroundModelState = Static<typeof BackgroundModelStateSchema>;

// The health of one background job (engine's background-health.ts): the background model, channel memory, Hindsight.
// The settings page shows it; background_model.read returns it.
export const BACKGROUND_JOB_STATES = ["ok", "failing"] as const;
export const BackgroundJobStateSchema = StrictObject({
  // background_model, channel_memory, hindsight (other job names may appear).
  job: Type.String(),
  state: literalUnion(BACKGROUND_JOB_STATES),
  // When the current failing episode started (ISO); null when ok.
  since: Type.Union([Type.String(), Type.Null()]),
  // The class of the latest failure (machine text, e.g. config, quota, timeout); null when ok.
  reasonClass: Type.Union([Type.String(), Type.Null()]),
  // The latest failure, redacted and capped; null when ok.
  reason: Type.Union([Type.String(), Type.Null()]),
  // What the system did (e.g. "switched to provider/model"); null when ok or nothing.
  action: Type.Union([Type.String(), Type.Null()]),
  // Today's (local date) reported calls and failures.
  callsToday: Type.Integer({ minimum: 0 }),
  failuresToday: Type.Integer({ minimum: 0 }),
});
export type BackgroundJobState = Static<typeof BackgroundJobStateSchema>;

// What background_model.read returns: the model state and the health of each background job.
export const BackgroundModelReadResultSchema = StrictObject({
  ...BackgroundModelStateSchema.properties,
  jobs: Type.Array(BackgroundJobStateSchema),
});
export type BackgroundModelReadResult = Static<typeof BackgroundModelReadResultSchema>;
