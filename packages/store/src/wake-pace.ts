// How soon Lead wakes for ordinary system events (protocol's wake-pace.ts). One kv row, lead.wake-pace: { coldBatchMinutes }.
// All devices share it. This file only reads and writes the row: permission and notices are in engine's
// ui-actions/wake-pace.ts. A missing or broken row reads as the default (no waiting).
import { DEFAULT_WAKE_PACE, normalizeWakePace, type WakePaceDto } from "@pi-lead-child/protocol";
import type { Db } from "./db.js";

export const WAKE_PACE_KEY = "lead.wake-pace";

export function getWakePace(db: Db): WakePaceDto {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(WAKE_PACE_KEY) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_WAKE_PACE };
  try {
    return normalizeWakePace(JSON.parse(row.value) as unknown);
  } catch {
    return { ...DEFAULT_WAKE_PACE };
  }
}

/** Writes the setting (engine's wake_pace.set calls it). */
export function writeWakePace(db: Db, pace: WakePaceDto): void {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(WAKE_PACE_KEY, JSON.stringify(normalizeWakePace(pace)));
}
