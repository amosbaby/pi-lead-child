// The model that background work uses (src/background-model.ts, .scratch/background-models/spec.md).
// Checked here:
//   - prices: the catalog's pricing (OpenRouter shape, USD per token as strings) in USD per 1M tokens; missing or
//     garbage fields are no price; config.json's cost wins over the catalog; pi's built-in first-party price fills in;
//   - cheapModels: each price at most 1/4 of Lead's model's; the family words when nothing has a price; newest first;
//   - resolveBackgroundModel: the setting, automatic, the cheapest affordable model, Lead's model, broken models skipped;
//   - BrokenBackgroundModels: a mark lasts 1 hour; the catalog source keeps its last good read.
import { describe, expect, it } from "vitest";
import {
  backgroundFailureClass, BrokenBackgroundModels, cheapModels, createLeadCatalogSource, newestModelSpec, resolveBackgroundModel,
} from "../src/background-model.js";
import { catalogPricing, configuredPrice, knownModelPrice, leadModelCatalog, normalizeLeadModelConfig, type LeadCatalogModel } from "../src/model-config.js";

// magpie's GET /v1/models (2026-11-20): pricing in USD per token, as strings.
export const MAGPIE_PRICING = {
  luna: { prompt: "0.0000001", completion: "0.0000005", input_cache_read: "0.00000001" },
  terra: { prompt: "0.000001", completion: "0.000005", input_cache_read: "0.0000001" },
  sol: { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000002" },
};

function model(id: string, price: LeadCatalogModel["price"], created: string | null = null, provider = "magpie"): LeadCatalogModel {
  return {
    provider, id, group: null, source: null, name: null, input: ["text"], efforts: [], defaultEffort: null,
    contextWindow: null, maxTokens: null, created, price,
  };
}

const LUNA = model("codex/gpt-6-luna", { input: 0.1, output: 0.5, cacheRead: 0.01 }, "2026-10-01T00:00:00.000Z");
const TERRA = model("codex/gpt-6.1-terra", { input: 1, output: 5, cacheRead: 0.1 }, "2026-10-20T00:00:00.000Z");
const SOL = model("codex/gpt-6.2-sol", { input: 2, output: 10, cacheRead: 0.2 }, "2026-11-01T00:00:00.000Z");
const CATALOG = [SOL, TERRA, LUNA];

describe("prices", () => {
  it("reads the catalog's per-token strings as USD per 1M tokens", () => {
    expect(catalogPricing({ pricing: MAGPIE_PRICING.luna })).toEqual({ input: 0.1, output: 0.5, cacheRead: 0.01 });
    expect(catalogPricing({ pricing: MAGPIE_PRICING.sol })).toEqual({ input: 2, output: 10, cacheRead: 0.2 });
    expect(catalogPricing({ pricing: { prompt: 0.000003, completion: "0.000015" } })).toEqual({ input: 3, output: 15, cacheRead: null });
  });

  it("has no price when a field is missing or not a number", () => {
    for (const item of [
      {}, { pricing: null }, { pricing: "cheap" }, { pricing: { prompt: "0.0000001" } }, { pricing: { completion: "0.0000005" } },
      { pricing: { prompt: "free", completion: "0.0000005" } }, { pricing: { prompt: "-0.1", completion: "0.1" } },
      { pricing: { prompt: "NaN", completion: "1" } }, { pricing: { prompt: "1e400", completion: "1" } }, null, 42,
    ]) {
      expect(catalogPricing(item), JSON.stringify(item)).toBeNull();
    }
    // A garbage cache price only drops the cache price.
    expect(catalogPricing({ pricing: { prompt: "0.000001", completion: "0.000005", input_cache_read: "n/a" } }))
      .toEqual({ input: 1, output: 5, cacheRead: null });
  });

  it("reads config.json's cost in USD per 1M tokens", () => {
    expect(configuredPrice({ input: 0.3, output: 1.2 })).toEqual({ input: 0.3, output: 1.2, cacheRead: null });
    expect(configuredPrice({ input: "x", output: 1 })).toBeNull();
    expect(configuredPrice(undefined)).toBeNull();
  });

  it("knows pi's built-in first-party price of a model behind a gateway prefix", () => {
    expect(knownModelPrice("auto/claude-haiku-4-5")).toMatchObject({ input: 1, output: 5 });
    expect(knownModelPrice("as4/claude-haiku-4-5(high)")).toMatchObject({ input: 1, output: 5 });
    expect(knownModelPrice("nobody-knows-this-model")).toBeNull();
  });

  it("puts the price on catalog entries: config cost first, then the catalog's pricing, then the built-in price", async () => {
    const config = normalizeLeadModelConfig({
      providers: {
        magpie: {
          baseUrl: "http://127.0.0.1:9/v1", discover: true,
          models: [{ id: "codex/gpt-6.1-terra", cost: { input: 0.2, output: 0.8 } }],
        },
      },
      models: ["magpie/codex/gpt-6.2-sol"],
    }, {});
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).includes("client_version")) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({
        data: [
          { id: "codex/gpt-6.2-sol", pricing: MAGPIE_PRICING.sol },
          { id: "codex/gpt-6.1-terra", pricing: MAGPIE_PRICING.terra },
          { id: "auto/claude-haiku-4-5" },
          { id: "auto/no-price-anywhere", pricing: { prompt: "?" } },
        ],
      }), { status: 200 });
    }) as typeof fetch;
    const { models } = await leadModelCatalog(config, {}, fetchImpl);
    const price = (id: string) => models.find((entry) => entry.id === id)?.price;
    expect(price("codex/gpt-6.2-sol")).toEqual({ input: 2, output: 10, cacheRead: 0.2 });
    expect(price("codex/gpt-6.1-terra")).toEqual({ input: 0.2, output: 0.8, cacheRead: null });
    expect(price("auto/claude-haiku-4-5")).toMatchObject({ input: 1, output: 5 });
    expect(price("auto/no-price-anywhere")).toBeNull();
  });
});

describe("cheapModels", () => {
  it("measures each price against Lead's model: sol → luna, terra → luna, luna → none", () => {
    expect(cheapModels(CATALOG, "magpie/codex/gpt-6.2-sol")).toEqual(["magpie/codex/gpt-6-luna"]);
    expect(cheapModels(CATALOG, "magpie/codex/gpt-6.1-terra")).toEqual(["magpie/codex/gpt-6-luna"]);
    expect(cheapModels(CATALOG, "magpie/codex/gpt-6-luna")).toEqual([]);
  });

  it("needs both the input and the output price at most 1/4", () => {
    const cheapIn = model("in-only", { input: 0.1, output: 9, cacheRead: null });
    expect(cheapModels([SOL, cheapIn], "magpie/codex/gpt-6.2-sol")).toEqual([]);
  });

  it("ignores Lead's effort suffix and subscription account when it looks up Lead's price", () => {
    expect(cheapModels(CATALOG, "magpie/codex/gpt-6.2-sol(high)")).toEqual(["magpie/codex/gpt-6-luna"]);
    const codex = [model("gpt-6.2-sol", SOL.price, null, "openai-codex"), model("gpt-6-luna", LUNA.price, null, "openai-codex")];
    expect(cheapModels(codex, "openai-codex-2/gpt-6.2-sol")).toEqual(["openai-codex/gpt-6-luna"]);
  });

  it("uses the most expensive priced model as the reference when Lead's model has no price", () => {
    expect(cheapModels([...CATALOG, model("mystery", null)], "magpie/mystery")).toEqual(["magpie/codex/gpt-6-luna"]);
  });

  it("orders newest first, then the more expensive first", () => {
    const older = model("old-cheap", { input: 0.2, output: 1, cacheRead: null }, "2026-01-01T00:00:00.000Z");
    const pricier = model("new-pricier", { input: 0.3, output: 2, cacheRead: null }, "2026-10-01T00:00:00.000Z");
    expect(cheapModels([SOL, older, LUNA, pricier], "magpie/codex/gpt-6.2-sol"))
      .toEqual(["magpie/new-pricier", "magpie/codex/gpt-6-luna", "magpie/old-cheap"]);
  });

  it("falls back to the family words in the id when no model has a price, and never takes Lead's model", () => {
    const ids = ["claude-sonnet-5-5", "claude-haiku-4-5-20251001", "claude-haiku-5-5", "gemini-3.5-pro", "gpt-5.4-mini", "gemini-3.8-flash-lite"];
    const catalog = ids.map((id) => model(id, null, null, "vibeproxy"));
    expect(cheapModels(catalog, "vibeproxy/claude-sonnet-5-5")).toEqual([
      // No release dates: the higher version in the id first (5.5, 5.4, 4.5, 3.8). "gemini" is not "mini".
      "vibeproxy/claude-haiku-5-5", "vibeproxy/gpt-5.4-mini", "vibeproxy/claude-haiku-4-5-20251001", "vibeproxy/gemini-3.8-flash-lite",
    ]);
    expect(cheapModels(catalog, "vibeproxy/claude-haiku-5-5")).not.toContain("vibeproxy/claude-haiku-5-5");
  });

  it("still picks the newest haiku by version when the ids carry no release dates", () => {
    expect(newestModelSpec(["v/claude-3-5-haiku-20241022", "v/claude-haiku-4-5-20251001", "v/claude-haiku-5-5", "v/claude-haiku-5-5-20260901"]))
      .toBe("v/claude-haiku-5-5");
    expect(newestModelSpec([])).toBeNull();
  });
});

describe("resolveBackgroundModel", () => {
  it("is automatic without a setting: the first cheap model", () => {
    expect(resolveBackgroundModel({ catalog: CATALOG, mainSpec: "magpie/codex/gpt-6.2-sol" }))
      .toMatchObject({ spec: "magpie/codex/gpt-6-luna", source: "cheap", cheap: ["magpie/codex/gpt-6-luna"] });
  });

  it("takes the setting when it is in the catalog, and ignores one that is not", () => {
    expect(resolveBackgroundModel({ catalog: CATALOG, mainSpec: "magpie/codex/gpt-6.2-sol", setting: "magpie/codex/gpt-6.1-terra" }))
      .toMatchObject({ spec: "magpie/codex/gpt-6.1-terra", source: "setting" });
    expect(resolveBackgroundModel({ catalog: CATALOG, mainSpec: "magpie/codex/gpt-6.2-sol", setting: "gone/model" }))
      .toMatchObject({ spec: "magpie/codex/gpt-6-luna", source: "cheap" });
  });

  it("takes the cheapest model that is not more expensive than Lead's when none is cheap, else Lead's model", () => {
    expect(resolveBackgroundModel({ catalog: CATALOG, mainSpec: "magpie/codex/gpt-6-luna" }))
      .toMatchObject({ spec: "magpie/codex/gpt-6-luna", source: "main" });
    const broken = (spec: string) => spec === "magpie/codex/gpt-6-luna";
    expect(resolveBackgroundModel({ catalog: CATALOG, mainSpec: "magpie/codex/gpt-6.2-sol", isBroken: broken }))
      .toMatchObject({ spec: "magpie/codex/gpt-6.1-terra", source: "cheapest", candidates: ["magpie/codex/gpt-6.1-terra", "magpie/codex/gpt-6.2-sol"] });
    expect(resolveBackgroundModel({ catalog: [], mainSpec: "x/y" })).toMatchObject({ spec: "x/y", source: "main" });
    expect(resolveBackgroundModel({ catalog: [], mainSpec: null })).toMatchObject({ spec: null, source: "none" });
  });
});

describe("background failures", () => {
  it("sorts failures into account, quota, config and other", () => {
    expect(backgroundFailureClass('404 {"error":"magpie knows no model group/auto-claude-haiku-5-5"}')).toBe("config");
    expect(backgroundFailureClass("400 model not supported")).toBe("config");
    expect(backgroundFailureClass("429 You have reached your weekly limit for this model (usage limit)")).toBe("quota");
    expect(backgroundFailureClass("403 This service has been disabled in this account for violation of Terms of Service.")).toBe("account");
    expect(backgroundFailureClass("401 invalid api key")).toBe("account");
    expect(backgroundFailureClass("429 rate limited")).toBe("other");
    expect(backgroundFailureClass("fetch failed")).toBe("other");
  });

  it("skips a broken model for one hour, and a success clears it", () => {
    let now = 1_000;
    const broken = new BrokenBackgroundModels({ now: () => now });
    broken.mark("magpie/codex/gpt-6-luna", "config", "404");
    expect(broken.isBroken("magpie/codex/gpt-6-luna(low)")).toBe(true);
    now += 59 * 60_000;
    expect(broken.list()).toHaveLength(1);
    now += 2 * 60_000;
    expect(broken.isBroken("magpie/codex/gpt-6-luna")).toBe(false);
    broken.mark("a/b", "quota", "limit");
    broken.clear("a/b");
    expect(broken.list()).toEqual([]);
  });

  it("keeps the catalog's last good read when a read fails, and reads at most every 30 s", async () => {
    let now = 0;
    let reads = 0;
    let fail = false;
    const source = createLeadCatalogSource(async () => {
      reads += 1;
      if (fail) throw new Error("provider down");
      return CATALOG;
    }, { now: () => now });
    expect(source.snapshot()).toBeNull();
    expect(await source.get()).toBe(CATALOG);
    expect(await source.get()).toBe(CATALOG);
    expect(reads).toBe(1);
    fail = true;
    now += 31_000;
    expect(await source.get()).toBe(CATALOG);
    expect(await source.get()).toBe(CATALOG);
    expect(reads).toBe(2);
    expect(source.snapshot()).toBe(CATALOG);
  });
});
