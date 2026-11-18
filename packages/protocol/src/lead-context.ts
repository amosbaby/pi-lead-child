// Compact Lead's context on request (2026-11-18). The user types /compact in the message box, or asks Lead to compress its
// context. Both reach one operation: lead_context / compact (ui-actions.ts). The page calls POST /v1/lead/compact; Lead calls
// compact_lead_context or perform_action. Both call the same function in the daemon.
//
// The summary can use another model than Lead's (a cheaper one). Lead's model does not change. Lead idle: the summary starts at
// once. Lead busy: it starts when the current unit ends, before the next one. The result is in the conversation when it ends.
//
// The model can be named the way people say it ("gpt 6 luna"). The daemon resolves the words against the model catalog
// (resolveCompactModel). Several matches or none: the request is refused, and nothing starts. On 2026-11-18 the user's words
// were 「用 gpt 6 luna」; the first version took words without a slash as instructions and compacted with Lead's own model.
import { Type, type Static, type TProperties } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const LEAD_COMPACT_INSTRUCTIONS_MAX = 2_000;

export const CompactLeadContextRequestSchema = StrictObject({
  // The model that writes the summary: provider/id as list_lead_models gives it, or words that name one model ("gpt 6 luna").
  // Not given: Lead's current model.
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  // Extra instructions for the summary, for example "keep the details of ticket 12".
  instructions: Type.Optional(Type.String({ minLength: 1, maxLength: LEAD_COMPACT_INSTRUCTIONS_MAX })),
});
export type CompactLeadContextRequest = Static<typeof CompactLeadContextRequestSchema>;

export const CompactLeadContextResultSchema = StrictObject({
  // now: the summary started (Lead is idle). after_turn: it starts when Lead's current unit ends.
  // nothing_to_compact: there is nothing new since the last compaction. held: refused, see reason.
  // model_ambiguous: the model words match several models (candidates). model_unknown: they match none (candidates: the
  // closest ones). Nothing started in these four cases.
  applied: Type.Union([
    Type.Literal("now"), Type.Literal("after_turn"), Type.Literal("nothing_to_compact"), Type.Literal("held"),
    Type.Literal("model_ambiguous"), Type.Literal("model_unknown"),
  ]),
  // The model that writes the summary (provider/id). For a refused model: the words that were given.
  model: Type.String({ minLength: 1 }),
  // About how many tokens Lead's context has now. null: not known (for example right after a compaction).
  tokensBefore: Type.Union([Type.Number(), Type.Null()]),
  // true: a compaction was already waiting or running, and this request joined it.
  existing: Type.Boolean(),
  // false: the request joined a compaction that was already running with another model or without the instructions, so the
  // model or the instructions of this request do not apply.
  requestApplied: Type.Boolean(),
  // model_ambiguous: the matching models; model_unknown: up to 5 close ones (full provider/id). Empty otherwise.
  candidates: Type.Array(Type.String()),
  // Why it was refused or why nothing happened. null otherwise. Detail for logs and Lead, not text for the page.
  reason: Type.Union([Type.String(), Type.Null()]),
});
export type CompactLeadContextResult = Static<typeof CompactLeadContextResultSchema>;

/**
 * The /compact command in the message box: "/compact [model words] [-- instructions]". The instructions come only after a
 * standalone "--". Without it, all the words after /compact name the model (the daemon resolves them). Not a command: null.
 */
export function parseCompactCommand(text: string): CompactLeadContextRequest | null {
  const match = /^\/compact(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  if (!match) return null;
  const rest = (match[1] ?? "").trim();
  const split = /(?:^|\s)--(?:\s|$)/u.exec(rest);
  const modelPart = (split ? rest.slice(0, split.index) : rest).trim().replace(/\s+/gu, " ").slice(0, 300);
  const instructions = (split ? rest.slice(split.index + split[0].length) : "").trim().slice(0, LEAD_COMPACT_INSTRUCTIONS_MAX);
  return { ...(modelPart ? { model: modelPart } : {}), ...(instructions ? { instructions } : {}) };
}

/** A model in the catalog: spec is provider/id; name is the display name, when there is one. */
export interface CompactModelChoice {
  spec: string;
  name?: string | null;
}

export type CompactModelResolution =
  | { kind: "one"; spec: string }
  | { kind: "many"; candidates: string[] }
  | { kind: "none"; candidates: string[] };

/** Lowercase, letters and digits only: "GPT 6 Luna", "gpt-6-luna" and "用 gpt 6 luna" all become "gpt6luna". */
export function compactModelKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

const EFFORT_SUFFIX = /\([A-Za-z0-9_-]{1,32}\)$/u;

/** The ways people name one model: the full spec, the id without the provider, the last part of the id, the display name. */
function modelKeys(choice: CompactModelChoice): string[] {
  const spec = choice.spec.replace(EFFORT_SUFFIX, "");
  const slash = spec.indexOf("/");
  const id = slash > 0 ? spec.slice(slash + 1) : spec;
  const bare = id.slice(id.lastIndexOf("/") + 1);
  return [spec, id, bare, choice.name ?? ""].map(compactModelKey).filter(Boolean);
}

// How close two keys are (0..1): shared character pairs (Dice). Only to order the candidates of "no model matched".
function closeness(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) return 1 - Math.abs(a.length - b.length) / (2 * Math.max(a.length, b.length));
  const pairs = (text: string) => Array.from({ length: Math.max(0, text.length - 1) }, (_, index) => text.slice(index, index + 2));
  const left = pairs(a);
  const right = pairs(b);
  if (!left.length || !right.length) return 0;
  const pool = [...right];
  let shared = 0;
  for (const pair of left) {
    const at = pool.indexOf(pair);
    if (at >= 0) {
      shared += 1;
      pool.splice(at, 1);
    }
  }
  return (2 * shared) / (left.length + right.length);
}

/**
 * Resolve the model words of a compaction request against the catalog. The exact provider/id first (an effort suffix is
 * ignored); otherwise the normalized key of the words against each model's keys (modelKeys). One match: use it. Several:
 * refuse and list them. None: refuse and list up to 5 close ones.
 */
export function resolveCompactModel(words: string, choices: readonly CompactModelChoice[]): CompactModelResolution {
  const unique = [...new Map(choices.map((choice) => [choice.spec.replace(EFFORT_SUFFIX, ""), { ...choice, spec: choice.spec.replace(EFFORT_SUFFIX, "") }])).values()];
  const exact = words.trim().replace(EFFORT_SUFFIX, "");
  const direct = unique.find((choice) => choice.spec === exact) ?? unique.find((choice) => choice.spec.toLowerCase() === exact.toLowerCase());
  if (direct) return { kind: "one", spec: direct.spec };
  const key = compactModelKey(exact);
  if (key) {
    const matches = unique.filter((choice) => modelKeys(choice).includes(key)).map((choice) => choice.spec);
    if (matches.length === 1) return { kind: "one", spec: matches[0]! };
    if (matches.length > 1) return { kind: "many", candidates: matches };
  }
  const scored = unique
    .map((choice) => ({ spec: choice.spec, score: Math.max(...modelKeys(choice).map((candidate) => closeness(key, candidate))) }))
    .filter((entry) => entry.score > 0.3)
    .sort((a, b) => b.score - a.score || a.spec.localeCompare(b.spec));
  return { kind: "none", candidates: scored.slice(0, 5).map((entry) => entry.spec) };
}
