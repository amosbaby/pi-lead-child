// The model that background work uses (.scratch/background-models/spec.md, user 2026-11-20).
//
// Background work is every model call outside Lead's turns: the decision LLM (smart-model.ts: channel memory, summaries,
// urgency), the compaction summary that cannot use the provider's cache (session.ts, compaction-chunks.ts), and
// Hindsight's automatic summary slot (apps/daemon memory-backend.ts). Before, three places picked the newest model with
// "haiku" in its id. With a gateway that serves no haiku, the decision LLM used Lead's own, most expensive model.
//
// - Cheap (cheapModels): a model whose input price and output price are each at most 1/4 of Lead's model's. When Lead's
//   model has no price, the reference is the most expensive priced model. When no model of the catalog has a price, the
//   model family in the id decides (haiku, luna, flash, mini, nano, lite, small). Newest first, then the more expensive
//   (more capable) first. Computed from the live catalog on each read, never a fixed list.
// - The setting (kv lead.background_model, protocol's background-model.ts): a model, or null for automatic.
//   resolveBackgroundModel turns it into the model to call. Automatic: the first cheap model; when none is cheap, the
//   cheapest priced model that is not more expensive than Lead's model; else Lead's model.
// - A model that fails with a configuration error (unknown model, not served, 404) or a quota error is broken for 1 hour
//   (BrokenBackgroundModels). The resolver skips it, and the caller retries the same call once on the next choice.
import { classifyLeadModelError, isLeadAccountFailure, subscriptionSlotSpec, type BackgroundModelSource } from "@pi-lead-child/protocol";
import { isLeadQuotaExhausted } from "./model-failover.js";
import { knownModelPrice, splitLeadModelEffort, type LeadCatalogModel, type LeadModelPrice } from "./model-config.js";

/** A cheap model costs at most 1/CHEAP_RATIO of the reference price, for input and for output. */
export const CHEAP_RATIO = 4;
/** How long a model that failed with a configuration or quota error is skipped. */
export const BROKEN_BACKGROUND_MODEL_MS = 60 * 60 * 1000;

// Model family words of small models, for a catalog without prices. Machine text (model ids), so a pattern is fine.
// The word must stand alone between non-letters: "gemini" is not "mini".
const CHEAP_FAMILY = /(?:^|[^a-z])(?:haiku|luna|flash|mini|nano|lite|small)(?:[^a-z]|$)/i;

/** provider/id of a catalog entry. */
export function catalogSpec(model: Pick<LeadCatalogModel, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

// The same slot in the catalog: no effort suffix, a subscription account (<base>-<n>/<id>) as <base>/<id>.
function slotKey(spec: string): string {
  return subscriptionSlotSpec(splitLeadModelEffort(spec.trim()).base);
}

/** The catalog entry of a spec (effort suffix and subscription account ignored). */
export function findCatalogModel(catalog: readonly LeadCatalogModel[], spec: string | null | undefined): LeadCatalogModel | null {
  if (!spec) return null;
  const key = slotKey(spec);
  return catalog.find((model) => slotKey(catalogSpec(model)) === key) ?? null;
}

const total = (price: LeadModelPrice): number => price.input + price.output;
const hasPrice = (price: LeadModelPrice | null | undefined): price is LeadModelPrice =>
  Boolean(price) && (price!.input > 0 || price!.output > 0);

// Lead's model's price: its catalog entry's, or pi's built-in price when the catalog does not list it.
function mainPrice(catalog: readonly LeadCatalogModel[], mainSpec: string | null): LeadModelPrice | null {
  if (!mainSpec) return null;
  const listed = findCatalogModel(catalog, mainSpec);
  if (listed) return hasPrice(listed.price) ? listed.price : null;
  const slash = mainSpec.indexOf("/");
  const known = slash > 0 ? knownModelPrice(mainSpec.slice(slash + 1)) : null;
  return hasPrice(known) ? known : null;
}

/** The price that "cheap" is measured against: Lead's model's, or the most expensive priced model's. */
export function referencePrice(catalog: readonly LeadCatalogModel[], mainSpec: string | null): LeadModelPrice | null {
  const main = mainPrice(catalog, mainSpec);
  if (main) return main;
  let best: LeadModelPrice | null = null;
  for (const model of catalog) if (hasPrice(model.price) && (!best || total(model.price) > total(best))) best = model.price;
  return best;
}

// Version numbers in an id: an 8-digit date suffix is not a version.
function versionParts(spec: string): number[] {
  return (spec.slice(spec.indexOf("/") + 1).match(/\d+/g) ?? []).filter((part) => part.length < 8).map(Number);
}

/** Positive when a has the higher version; a model without a date suffix wins a tie. */
export function compareModelVersion(a: string, b: string): number {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const order = (x[i] ?? -1) - (y[i] ?? -1);
    if (order !== 0) return order;
  }
  const dated = (spec: string) => /\d{8}/.test(spec);
  return dated(a) === dated(b) ? 0 : dated(a) ? -1 : 1;
}

// 版本最新的那个模型。provider discover 出来的目录不按版本排序（实测 vibeproxy 把 claude-haiku-4-5-20251001
// 排在 claude-haiku-5-5 前面），所以按模型 id 里的版本号比较：8 位的日期后缀不算版本；版本相同时，没有日期后缀的优先。
export function newestModelSpec(specs: readonly string[]): string | null {
  let best: string | null = null;
  for (const spec of specs) if (best === null || compareModelVersion(spec, best) > 0) best = spec;
  return best;
}

// The order of the automatic choice: newest release first, then the more expensive (more capable), then the higher
// version in the id, then the catalog's order.
function automaticOrder(models: readonly LeadCatalogModel[]): LeadCatalogModel[] {
  const released = (model: LeadCatalogModel) => (model.created ? Date.parse(model.created) : Number.NEGATIVE_INFINITY);
  return models.map((model, index) => ({ model, index })).sort((a, b) =>
    (released(b.model) - released(a.model) || 0)
    || ((hasPrice(b.model.price) ? total(b.model.price) : -1) - (hasPrice(a.model.price) ? total(a.model.price) : -1))
    || compareModelVersion(catalogSpec(b.model), catalogSpec(a.model))
    || a.index - b.index).map((entry) => entry.model);
}

/**
 * The cheap models of the catalog for Lead's model mainSpec, in the order of the automatic choice. Lead's own model is
 * never in the list. Specs are provider/id with the catalog's own spelling.
 */
export function cheapModels(catalog: readonly LeadCatalogModel[], mainSpec: string | null): string[] {
  const mainKey = mainSpec ? slotKey(mainSpec) : null;
  const others = catalog.filter((model) => slotKey(catalogSpec(model)) !== mainKey);
  let cheap: LeadCatalogModel[];
  if (catalog.some((model) => hasPrice(model.price))) {
    const reference = referencePrice(catalog, mainSpec);
    if (!reference) return [];
    cheap = others.filter((model) => hasPrice(model.price)
      && model.price.input <= reference.input / CHEAP_RATIO && model.price.output <= reference.output / CHEAP_RATIO);
  } else {
    cheap = others.filter((model) => CHEAP_FAMILY.test(model.id));
  }
  return [...new Set(automaticOrder(cheap).map(catalogSpec))];
}

export interface BackgroundModelChoice {
  /** The model to call (provider/id), or null when nothing is known. */
  spec: string | null;
  source: BackgroundModelSource;
  /** The cheap models now (cheapModels), broken ones included. */
  cheap: string[];
  /** The models to try, in order: spec first. Broken models are left out. */
  candidates: string[];
}

/**
 * The model background work uses. setting is the stored choice (kv lead.background_model; null is automatic). A setting
 * that is not in the catalog is ignored (when the catalog is known). isBroken leaves out models that failed recently.
 */
export function resolveBackgroundModel(input: {
  catalog: readonly LeadCatalogModel[];
  mainSpec: string | null;
  setting?: string | null;
  isBroken?: (spec: string) => boolean;
}): BackgroundModelChoice {
  const broken = input.isBroken ?? (() => false);
  const cheap = cheapModels(input.catalog, input.mainSpec);
  const candidates: string[] = [];
  const add = (spec: string | null | undefined) => {
    if (spec && !broken(spec) && !candidates.some((known) => slotKey(known) === slotKey(spec))) candidates.push(spec);
  };
  const setting = input.setting?.trim() || null;
  const settingKnown = setting !== null && (input.catalog.length === 0 || findCatalogModel(input.catalog, setting) !== null);
  if (settingKnown) add(setting);
  for (const spec of cheap) add(spec);
  // No cheap model works: the cheapest priced model that is not more expensive than Lead's model (Lead's included).
  const main = mainPrice(input.catalog, input.mainSpec);
  if (main) {
    const affordable = input.catalog.filter((model) => hasPrice(model.price)
      && model.price.input <= main.input && model.price.output <= main.output)
      .sort((a, b) => total(a.price!) - total(b.price!));
    for (const model of affordable) add(catalogSpec(model));
  }
  add(input.mainSpec);
  const spec = candidates[0] ?? null;
  const mainKey = input.mainSpec ? slotKey(input.mainSpec) : null;
  const source: BackgroundModelSource = spec === null ? "none"
    : settingKnown && spec === setting ? "setting"
    : cheap.includes(spec) ? "cheap"
    : slotKey(spec) === mainKey ? "main"
    : "cheapest";
  return { spec, source, cheap, candidates };
}

/** Why a background call failed, for the failover and the health hooks. */
export type BackgroundFailureClass = "account" | "quota" | "config" | "other";

/**
 * account: an account-level failure (protocol's isLeadAccountFailure) that is not a quota; it still enters the model
 * hold. quota: the model's quota is used up. config: the model is unknown, not supported or not served (404).
 * other: rate limits, network, 5xx and the rest; the call fails, nothing else happens.
 */
export function backgroundFailureClass(raw: string): BackgroundFailureClass {
  if (isLeadQuotaExhausted(raw)) return "quota";
  if (isLeadAccountFailure(raw)) return "account";
  if (classifyLeadModelError(raw) === "config") return "config";
  return "other";
}

export interface BrokenBackgroundModel {
  model: string;
  until: number;
  reason: string;
  reasonClass: BackgroundFailureClass;
}

/** Models that failed with a configuration or quota error, skipped for BROKEN_BACKGROUND_MODEL_MS. In memory. */
export class BrokenBackgroundModels {
  readonly #entries = new Map<string, BrokenBackgroundModel>();
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(options: { now?: () => number; ttlMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? BROKEN_BACKGROUND_MODEL_MS;
  }

  mark(model: string, reasonClass: BackgroundFailureClass, reason: string): void {
    this.#entries.set(slotKey(model), { model, until: this.#now() + this.#ttlMs, reason, reasonClass });
  }

  /** A success clears the mark (the user may have fixed the model). */
  clear(model: string): void {
    this.#entries.delete(slotKey(model));
  }

  isBroken = (model: string): boolean => {
    const entry = this.#entries.get(slotKey(model));
    if (!entry) return false;
    if (entry.until > this.#now()) return true;
    this.#entries.delete(slotKey(model));
    return false;
  };

  list(): BrokenBackgroundModel[] {
    return [...this.#entries.values()].filter((entry) => this.isBroken(entry.model));
  }
}

/** A catalog that is read again at most every ttlMs, and that keeps its last good read when a read fails. */
export interface LeadCatalogSource {
  get(): Promise<readonly LeadCatalogModel[]>;
  /** The last good read, without waiting; starts a new read when it is old. null before the first read. */
  snapshot(): readonly LeadCatalogModel[] | null;
  /** Forget the cached read (a provider or a subscription changed). */
  invalidate(): void;
}

export const LEAD_CATALOG_TTL_MS = 30_000;

export function createLeadCatalogSource(
  load: () => Promise<readonly LeadCatalogModel[]>,
  options: { ttlMs?: number; now?: () => number } = {},
): LeadCatalogSource {
  const ttlMs = options.ttlMs ?? LEAD_CATALOG_TTL_MS;
  const now = options.now ?? Date.now;
  let last: readonly LeadCatalogModel[] | null = null;
  let pending: { at: number; value: Promise<readonly LeadCatalogModel[]> } | null = null;
  const read = (): Promise<readonly LeadCatalogModel[]> => {
    if (pending && now() - pending.at < ttlMs) return pending.value;
    const value = load().then((models) => {
      last = models;
      return models;
    });
    // A failed read is kept for ttlMs too: a provider that is down is not asked again on every call.
    pending = { at: now(), value };
    value.catch(() => {});
    return value;
  };
  return {
    get: () => read().catch((error: unknown) => {
      if (last) return last;
      throw error;
    }),
    snapshot: () => {
      void read().catch(() => {});
      return last;
    },
    invalidate: () => {
      pending = null;
    },
  };
}
