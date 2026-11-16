// How soon Lead wakes for ordinary system events (user 2026-11-16: 「这个值能否暴露一个工具由 lead 自行决策」).
//
// Each wake reads Lead's whole context. While the provider still holds that context in its prompt cache, a wake is
// cheap (a cache read). After the cache has expired, a wake pays the full input price for the whole context again.
// So the setting is about cold wakes only:
// - coldBatchMinutes = 0 (default): Lead wakes for each event at once, as before.
// - coldBatchMinutes > 0: when an ordinary event arrives and Lead's cache is cold, the daemon waits until that many
//   minutes after the first waiting event, then wakes Lead once for everything that arrived. While the cache is warm,
//   Lead still wakes at once.
// What never waits: the user's own messages, someone waiting in an external channel, reminders, the user's own
// follow-ups, and events at level interrupt.
// - Stored in plc.db kv (lead.wake-pace), one JSON row (store's wake-pace.ts). Not a secret, shared by all devices.
// - The operation is wake_pace.set (engine's ui-actions/wake-pace.ts): the page and Lead call the same definition.
//   lead_allowed, changes rules: Lead cannot change it in a turn that read external content.
// This file does not import index.ts (index.ts re-exports from here).
import { Type, type Static, type TProperties } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const WAKE_PACE_RESOURCE = "wake-pace";

/** The longest wait: 4 hours. A longer wait is a digest, not a pace. */
export const WAKE_PACE_MAX_MINUTES = 240;

export const WakePaceDtoSchema = StrictObject({
  coldBatchMinutes: Type.Integer({ minimum: 0, maximum: WAKE_PACE_MAX_MINUTES }),
});
export type WakePaceDto = Static<typeof WakePaceDtoSchema>;

export const DEFAULT_WAKE_PACE: WakePaceDto = { coldBatchMinutes: 0 };

/** The setting from a stored or received value. Anything that is not a whole number in range reads as the default. */
export function normalizeWakePace(value: unknown): WakePaceDto {
  const minutes = value !== null && typeof value === "object" ? (value as { coldBatchMinutes?: unknown }).coldBatchMinutes : undefined;
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 0 || minutes > WAKE_PACE_MAX_MINUTES) return { ...DEFAULT_WAKE_PACE };
  return { coldBatchMinutes: minutes };
}

// wake_pace.set input (POST /v1/actions/wake_pace/lead/set).
export const SetWakePaceRequestSchema = WakePaceDtoSchema;
export type SetWakePaceRequest = Static<typeof SetWakePaceRequestSchema>;
