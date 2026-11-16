// What the guards on Lead's automatic model calls remember across a daemon restart (2026-11-16): the model hold
// (account hold, breaker, budget pause; lead's model-hold.ts) and the calls counted by the budget (auto-call-budget.ts).
// Both lived only in memory. On 2026-11-15 the daemon restarted about 400 times in a crash loop, and one planned restart
// on 2026-11-16 set a running hourly budget back to zero: each restart gave Lead three more failed calls before the
// breaker opened, and a new budget. Now a restart continues where the daemon stopped.
//
// Each guard has one kv row with a JSON value. The store does not know the shape: the guard checks what it reads
// (ModelHold.restore, AutoCallBudget) and ignores a value it does not understand. A missing or broken row reads as null.
import type { Db } from "./db.js";

export type LeadCallGuard = "model_hold" | "auto_budget";

const KEYS: Record<LeadCallGuard, string> = { model_hold: "lead.model_hold", auto_budget: "lead.auto_budget" };

/** The saved state of one guard, or null when there is none or the row does not hold JSON. */
export function readLeadCallGuard(db: Db, guard: LeadCallGuard): unknown {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(KEYS[guard]) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return null;
  }
}

/** Saves the state of one guard. */
export function writeLeadCallGuard(db: Db, guard: LeadCallGuard, state: unknown): void {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(KEYS[guard], JSON.stringify(state ?? null));
}
