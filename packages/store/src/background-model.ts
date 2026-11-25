// The model that background work uses (protocol's background-model.ts). One kv row, lead.background_model: { model }.
// All devices share it. This file only reads and writes the row: permission and checks are in engine's
// ui-actions/background-model.ts. A missing or broken row reads as automatic (model null).
import { DEFAULT_BACKGROUND_MODEL, normalizeBackgroundModel, type BackgroundModelSetting } from "@pi-lead-child/protocol";
import type { Db } from "./db.js";

export const BACKGROUND_MODEL_KEY = "lead.background_model";

export function getBackgroundModel(db: Db): BackgroundModelSetting {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(BACKGROUND_MODEL_KEY) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_BACKGROUND_MODEL };
  try {
    return normalizeBackgroundModel(JSON.parse(row.value) as unknown);
  } catch {
    return { ...DEFAULT_BACKGROUND_MODEL };
  }
}

/** Writes the setting (engine's background_model.set calls it). */
export function writeBackgroundModel(db: Db, setting: BackgroundModelSetting): void {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(BACKGROUND_MODEL_KEY, JSON.stringify(normalizeBackgroundModel(setting)));
}
