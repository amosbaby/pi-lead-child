// The background shadow (user 2026-11-19, .scratch/lead-background-shadow/spec.md).
//
// Each wake of the main Lead session reads its whole context (250–300K tokens). Most background events need a short
// judgment, not that context: on 2026-11-19 five Slack messages that were not for the user cost about 3.1M tokens.
// The shadow is Lead in a small session: the same system prompt, standing orders, core memory and permission rules, a
// short list of tools, and no conversation history. One batch of events gets one new session. Every session starts
// with the same fixed opening, so the provider's prompt cache hits across sessions (magpie keys its cache by the
// conversation opening).
//
// Settings, one kv row (lead.shadow), shared by all devices:
//   - mode: off (the main session handles every background event, as before); trial (the shadow also handles each batch
//     with its actions not run, and the system records what it would have done; the main session still handles the
//     batch); on (the shadow handles the batch, and hands to the main session what it should not handle).
//   - model: provider/model for the shadow. null: the same model as the main session.
//   - shares: for each source, the percent of its background events that go to the shadow (0–100). Sources: channel
//     (external messages from any channel adapter), ticket (ticket, run and blocker events), other (the rest of the system
//     events). The split is by object (a conversation, a ticket), not by event: one conversation always goes to the same
//     side, so a thread is never handled half by each (shadowBucket). The user turns a share up when the shadow does well
//     (user 2026-11-19: 「表现不好我就切掉」). Default: channel 100, the others 0.
//   - gatherSeconds: when the main session's cache is warm, ordinary background events wait this long for each other,
//     then go out as one batch (to the shadow or to the main session). 0: no waiting. Events that someone waits for never
//     wait (the caller's rule, apps/daemon wakeForEvents).
// The operation is lead_shadow.set (engine's ui-actions/lead-shadow.ts): the page route and Lead call the same definition.
// This file does not import index.ts (index.ts re-exports from here).
import { Type, type Static, type TProperties } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const literalUnion = <const T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>(Type.Union(values.map((value) => Type.Literal(value))));

export const LEAD_SHADOW_RESOURCE = "lead-shadow";

export const LEAD_SHADOW_MODES = ["off", "trial", "on"] as const;
export type LeadShadowMode = typeof LEAD_SHADOW_MODES[number];

export const LEAD_SHADOW_SOURCES = ["channel", "ticket", "other"] as const;
export type LeadShadowSource = typeof LEAD_SHADOW_SOURCES[number];

export const LeadShadowSharesSchema = StrictObject({
  channel: Type.Integer({ minimum: 0, maximum: 100 }),
  ticket: Type.Integer({ minimum: 0, maximum: 100 }),
  other: Type.Integer({ minimum: 0, maximum: 100 }),
});
export type LeadShadowShares = Static<typeof LeadShadowSharesSchema>;

/** The longest gather window. A longer wait is a pace (wake_pace), not a gather. */
export const LEAD_SHADOW_MAX_GATHER_SECONDS = 120;

/** provider/model, the same shape as Lead's model specs. The model id can hold more slashes (magpie/codex/gpt-6.1-terra). */
export const LEAD_SHADOW_MODEL_PATTERN = "^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._:@+-]+)+$";

export const LeadShadowDtoSchema = StrictObject({
  mode: literalUnion(LEAD_SHADOW_MODES),
  model: Type.Union([Type.String({ minLength: 3, maxLength: 200, pattern: LEAD_SHADOW_MODEL_PATTERN }), Type.Null()]),
  shares: LeadShadowSharesSchema,
  gatherSeconds: Type.Integer({ minimum: 0, maximum: LEAD_SHADOW_MAX_GATHER_SECONDS }),
});
export type LeadShadowDto = Static<typeof LeadShadowDtoSchema>;

export const DEFAULT_LEAD_SHADOW: LeadShadowDto = { mode: "off", model: null, shares: { channel: 100, ticket: 0, other: 0 }, gatherSeconds: 20 };

/**
 * Which side of the split an object falls on: a number 0–99 from the object key (FNV-1a). The object goes to the shadow
 * when its bucket is below the source's share. The same key always gives the same bucket, so a conversation or a ticket
 * stays on one side, and raising a share only moves objects from the main session to the shadow.
 */
export function shadowBucket(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

const MODEL_RE = new RegExp(LEAD_SHADOW_MODEL_PATTERN);

/** The setting from a stored or received value. Each field that is not valid reads as its default. */
export function normalizeLeadShadow(value: unknown): LeadShadowDto {
  const raw = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  const mode = (LEAD_SHADOW_MODES as readonly unknown[]).includes(raw.mode) ? raw.mode as LeadShadowMode : DEFAULT_LEAD_SHADOW.mode;
  const model = typeof raw.model === "string" && raw.model.length <= 200 && MODEL_RE.test(raw.model) ? raw.model : null;
  const given = raw.shares !== null && typeof raw.shares === "object" ? raw.shares as Record<string, unknown> : {};
  const share = (source: LeadShadowSource): number => {
    const value = given[source];
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100 ? value : DEFAULT_LEAD_SHADOW.shares[source];
  };
  const shares = { channel: share("channel"), ticket: share("ticket"), other: share("other") };
  const gather = raw.gatherSeconds;
  const gatherSeconds = typeof gather === "number" && Number.isInteger(gather) && gather >= 0 && gather <= LEAD_SHADOW_MAX_GATHER_SECONDS
    ? gather : DEFAULT_LEAD_SHADOW.gatherSeconds;
  return { mode, model, shares, gatherSeconds };
}

// lead_shadow.set input (POST /v1/actions/lead_shadow/lead/set). Every field is optional: the ones left out keep their value.
export const SetLeadShadowRequestSchema = StrictObject({
  mode: Type.Optional(LeadShadowDtoSchema.properties.mode),
  model: Type.Optional(LeadShadowDtoSchema.properties.model),
  // Only the sources given change; the others keep their share.
  shares: Type.Optional(Type.Partial(LeadShadowSharesSchema)),
  gatherSeconds: Type.Optional(LeadShadowDtoSchema.properties.gatherSeconds),
});
export type SetLeadShadowRequest = Static<typeof SetLeadShadowRequestSchema>;

// Events the shadow writes (source lead).
//   lead.shadow_handled: record level, one per event the shadow finished in mode on. The main session reads them in its
//     next situation ("the shadow handled N things"), not as a wake.
//   lead.shadow_run: record level, one per shadow session (mode on or trial): the events, the outcome of each, the
//     model, token usage and what the shadow would have done. Never in Lead's context; for reports and the replay check.
export const LEAD_SHADOW_HANDLED_KIND = "lead.shadow_handled";
export const LEAD_SHADOW_RUN_KIND = "lead.shadow_run";
