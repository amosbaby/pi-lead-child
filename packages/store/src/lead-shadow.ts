// The background shadow's setting (protocol's lead-shadow.ts). One kv row, lead.shadow. All devices share it.
// This file only reads and writes the row: permission and notices are in engine's ui-actions/lead-shadow.ts.
// A missing or broken row reads as the default (shadow off; channel 100%, others 0%; 20 s gather window).
import { DEFAULT_LEAD_SHADOW, normalizeLeadShadow, type LeadShadowDto } from "@pi-lead-child/protocol";
import type { Db } from "./db.js";

export const LEAD_SHADOW_KEY = "lead.shadow";

export function getLeadShadow(db: Db): LeadShadowDto {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(LEAD_SHADOW_KEY) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_LEAD_SHADOW, shares: { ...DEFAULT_LEAD_SHADOW.shares } };
  try {
    return normalizeLeadShadow(JSON.parse(row.value) as unknown);
  } catch {
    return { ...DEFAULT_LEAD_SHADOW, shares: { ...DEFAULT_LEAD_SHADOW.shares } };
  }
}

/** Writes the setting (engine's lead_shadow.set calls it). */
export function writeLeadShadow(db: Db, shadow: LeadShadowDto): void {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(LEAD_SHADOW_KEY, JSON.stringify(normalizeLeadShadow(shadow)));
}
