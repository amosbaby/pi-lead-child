// Compact Lead's context on request (2026-11-18). The user types /compact in the message box, or asks Lead to compress its
// context. Both reach one operation: lead_context / compact (ui-actions.ts). The page calls POST /v1/lead/compact; Lead calls
// compact_lead_context or perform_action. Both call the same function in the daemon.
//
// The summary can use another model than Lead's (a cheaper one). Lead's model does not change. Lead idle: the summary starts at
// once. Lead busy: it starts when the current unit ends, before the next one. The result is in the conversation when it ends.
import { Type, type Static, type TProperties } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const LEAD_COMPACT_INSTRUCTIONS_MAX = 2_000;

export const CompactLeadContextRequestSchema = StrictObject({
  // The model that writes the summary: provider/id as list_lead_models gives it, without an effort suffix.
  // Not given: Lead's current model.
  model: Type.Optional(Type.String({ minLength: 3, maxLength: 300 })),
  // Extra instructions for the summary, for example "keep the details of ticket 12".
  instructions: Type.Optional(Type.String({ minLength: 1, maxLength: LEAD_COMPACT_INSTRUCTIONS_MAX })),
});
export type CompactLeadContextRequest = Static<typeof CompactLeadContextRequestSchema>;

export const CompactLeadContextResultSchema = StrictObject({
  // now: the summary started (Lead is idle). after_turn: it starts when Lead's current unit ends.
  // nothing_to_compact: there is nothing new since the last compaction. held: refused, see reason.
  applied: Type.Union([
    Type.Literal("now"), Type.Literal("after_turn"), Type.Literal("nothing_to_compact"), Type.Literal("held"),
  ]),
  // The model that writes the summary (provider/id).
  model: Type.String({ minLength: 1 }),
  // About how many tokens Lead's context has now. null: not known (for example right after a compaction).
  tokensBefore: Type.Union([Type.Number(), Type.Null()]),
  // true: a compaction was already waiting or running, and this request joined it.
  existing: Type.Boolean(),
  // Why it was refused or why nothing happened. null otherwise.
  reason: Type.Union([Type.String(), Type.Null()]),
});
export type CompactLeadContextResult = Static<typeof CompactLeadContextResultSchema>;

/**
 * The /compact command in the message box: "/compact", "/compact <provider/id>", "/compact <provider/id> <instructions>",
 * or "/compact <instructions>". The first word after the command is the model when it has a slash. Not a command: null.
 */
export function parseCompactCommand(text: string): CompactLeadContextRequest | null {
  const match = /^\/compact(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  if (!match) return null;
  const rest = (match[1] ?? "").trim();
  if (!rest) return {};
  const first = rest.split(/\s+/u)[0] ?? "";
  const looksLikeModel = /^[^\s/]+\/\S+$/u.test(first) && first.length >= 3 && first.length <= 300;
  const model = looksLikeModel ? first : undefined;
  const instructions = (looksLikeModel ? rest.slice(first.length) : rest).trim().slice(0, LEAD_COMPACT_INSTRUCTIONS_MAX);
  return { ...(model ? { model } : {}), ...(instructions ? { instructions } : {}) };
}
