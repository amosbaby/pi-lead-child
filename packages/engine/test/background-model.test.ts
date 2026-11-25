// The model that background work uses (user 2026-11-20, .scratch/background-models/spec.md D2). The store and the
// operation layer are real; the service that knows the cheap models is a fake with the gateway's luna/terra/sol.
// Checked here:
//   - background_model.set: one operation for the page and for Lead; lead_allowed, not a rule change;
//   - Lead may choose only a cheap model (or automatic); a refusal lists the cheap models; the user may choose any model
//     of the catalog;
//   - background_model.read gives the setting, the model in use and the cheap models;
//   - the same Lead-only check guards the shadow model (null, the main session's model, is not cheap) and Hindsight's
//     summary slot.
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { UI_ACTION_PERFORMED_KIND, type BackgroundModelState } from "@pi-lead-child/protocol";
import { BACKGROUND_MODEL_KEY, getBackgroundModel, getLeadShadow, listEvents, openDb, type Db } from "@pi-lead-child/store";
import { UI_ACTIONS, listLeadUiActions, runUiAction, type UiActionServices } from "../src/index.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-background-model-"), "plc.db"));
});

const SOL = "magpie/codex/gpt-6.2-sol";
const TERRA = "magpie/codex/gpt-6.1-terra";
const LUNA = "magpie/codex/gpt-6-luna";

function services(): { services: UiActionServices; changed: () => number; summarySlots: unknown[] } {
  let changed = 0;
  const summarySlots: unknown[] = [];
  const state = (): BackgroundModelState => ({
    setting: getBackgroundModel(db).model, resolved: getBackgroundModel(db).model ?? LUNA, source: getBackgroundModel(db).model ? "setting" : "cheap",
    main: SOL, cheap: [LUNA], broken: [],
  });
  const option = (model: string) => {
    const [provider, ...rest] = model.split("/");
    return { model, provider: provider!, id: rest.join("/"), prefix: null, source: null, name: null };
  };
  const current = { model: SOL, effort: null };
  return {
    services: {
      backgroundModels: { state: async () => state(), snapshot: () => state(), changed: () => { changed += 1; } },
      leadModels: {
        state: () => ({ current, selected: current }),
        catalog: async () => ({ current, selected: current, models: [option(SOL), option(TERRA), option(LUNA)] }) as never,
        switch: async () => { throw new Error("not used"); },
      },
      memorySettings: {
        summary: () => ({ enabled: true, summaryModels: [], writes: { failed: 0 } }) as never,
        setSummaryModel: async (request: unknown) => {
          summarySlots.push(request);
          return { summary: { enabled: true, summaryModels: [], writes: { failed: 0 } }, note: null } as never;
        },
        testSummaryModel: async () => { throw new Error("not used"); },
        retryFailedWrites: async () => { throw new Error("not used"); },
      } as never,
    },
    changed: () => changed,
    summarySlots,
  };
}

const target = { type: "background_model", id: "lead" } as const;
const ledger = () => listEvents(db, { kind: UI_ACTION_PERFORMED_KIND, limit: 10 }).map((event) => event.payload);

describe("background_model.set", () => {
  it("is one operation Lead may run on its own judgment, and it is not a rule change", () => {
    expect(UI_ACTIONS.background_model.set).toMatchObject({ permission: "lead_allowed", changesRules: false, external: false, irreversible: false });
    expect(UI_ACTIONS.background_model.read).toMatchObject({ permission: "lead_allowed", changesRules: false, readOnly: true });
  });

  it("refuses Lead a model that is not cheap and lists the cheap ones; accepts a cheap one", async () => {
    const fake = services();
    const asLead = (model: string | null) => runUiAction(db, {
      target, action: "set", input: { model }, reason: "后台调用一直失败", caller: { kind: "lead", turnId: null }, services: fake.services,
    });
    const refused = await asLead(SOL).then(() => null, (error: unknown) => error as { code: string; message: string });
    expect(refused?.code).toBe("invalid_input");
    expect(refused?.message).toContain(LUNA);
    expect(getBackgroundModel(db).model).toBeNull();
    expect(db.prepare("SELECT 1 FROM kv WHERE key = ?").get(BACKGROUND_MODEL_KEY)).toBeUndefined();

    const accepted = await asLead(LUNA);
    expect(accepted.forLead).toMatchObject({ result: "updated", setting: LUNA, resolved: LUNA });
    expect(getBackgroundModel(db).model).toBe(LUNA);
    expect(fake.changed()).toBe(1);
    // Automatic is always allowed: it picks a cheap model.
    expect((await asLead(null)).forLead).toMatchObject({ result: "updated", setting: null });
    expect(ledger().map((entry) => (entry as { actor: string }).actor)).toEqual(["lead", "lead"]);
  });

  it("lets the user choose any model of the catalog, but not one outside it", async () => {
    const fake = services();
    const asUser = (model: string | null) => runUiAction(db, {
      target, action: "set", input: { model }, caller: { kind: "user" } as never, services: fake.services,
    });
    expect((await asUser(SOL)).result).toMatchObject({ changed: true, before: null, setting: SOL });
    expect(getBackgroundModel(db).model).toBe(SOL);
    await expect(asUser("codex/gpt-6.2-sol")).rejects.toMatchObject({ code: "invalid_input" });
    expect(getBackgroundModel(db).model).toBe(SOL);
  });

  it("refuses Lead while nobody knows which models are cheap", async () => {
    await expect(runUiAction(db, {
      target, action: "set", input: { model: LUNA }, reason: "换便宜的", caller: { kind: "lead", turnId: null }, services: {},
    })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("reads the setting, the model in use and the cheap models, for Lead and in the action list", async () => {
    const fake = services();
    const read = await runUiAction(db, { target, action: "read", input: {}, reason: "看一下", caller: { kind: "lead", turnId: null }, services: fake.services });
    expect(read.forLead).toEqual({
      setting: null, resolved: LUNA, source: "cheap", main: SOL, cheap: [LUNA], broken: [], jobs: [], jobs_words: "后台任务：还没有记录。",
    });
    const listed = await listLeadUiActions(db, target, { turnId: null, services: fake.services });
    expect(listed.target).toMatchObject({ setting: null, resolved: LUNA, cheap: [LUNA] });
  });
});

describe("the Lead-only cheap check on other background models", () => {
  it("refuses Lead a shadow model that is not cheap, and null (the main session's model); the user may set it", async () => {
    const fake = services();
    const shadow = (model: string | null, caller: "lead" | "user") => runUiAction(db, {
      target: { type: "lead_shadow", id: "lead" }, action: "set", input: { model },
      ...(caller === "lead" ? { reason: "shadow 用更强的模型", caller: { kind: "lead", turnId: null } } : { caller: { kind: "user" } }),
      services: fake.services,
    } as never);
    await expect(shadow(TERRA, "lead")).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining(LUNA) });
    expect(getLeadShadow(db).model).toBeNull();
    expect((await shadow(LUNA, "lead")).result).toMatchObject({ changed: true, shadow: { model: LUNA } });
    await expect(shadow(null, "lead")).rejects.toMatchObject({ code: "invalid_input" });
    expect(getLeadShadow(db).model).toBe(LUNA);
    expect((await shadow(SOL, "user")).result).toMatchObject({ changed: true, shadow: { model: SOL } });
    expect((await shadow(null, "user")).result).toMatchObject({ changed: true, shadow: { model: null } });
  });

  it("refuses Lead a Hindsight summary model that is not cheap; automatic is allowed", async () => {
    const fake = services();
    const slot = (model: string | null) => runUiAction(db, {
      target: { type: "memory_settings", id: "memory" }, action: "set_summary_model", input: { slot: "default", model },
      reason: "提取事实", caller: { kind: "lead", turnId: null }, services: fake.services,
    });
    await expect(slot(SOL)).rejects.toMatchObject({ code: "invalid_input" });
    expect(fake.summarySlots).toEqual([]);
    await slot(LUNA);
    await slot(null);
    expect(fake.summarySlots).toEqual([{ slot: "default", model: LUNA }, { slot: "default", model: null }]);
  });
});

describe("background_model.read: the health of the background jobs", () => {
  it("returns each job's state for the settings page and one line per job for Lead", async () => {
    const fake = services();
    const jobs = [
      { job: "background_model", state: "ok" as const, since: null, reasonClass: null, reason: null, action: null, callsToday: 12, failuresToday: 1 },
      {
        job: "channel_memory", state: "failing" as const, since: "2026-11-20T01:00:00.000Z", reasonClass: "config",
        reason: "404 unknown model", action: "switched to magpie/codex/gpt-6-luna", callsToday: 4, failuresToday: 4,
      },
    ];
    fake.services.backgroundModels = { ...fake.services.backgroundModels!, jobs: () => jobs };
    const read = await runUiAction(db, { target, action: "read", input: {}, reason: "看一下", caller: { kind: "lead", turnId: null }, services: fake.services });
    expect(read.result).toMatchObject({ resolved: LUNA, jobs });
    const words = (read.forLead as { jobs_words: string }).jobs_words;
    expect(words).toContain("background_model 正常（今天 12 次，失败 1 次）");
    expect(words).toContain("channel_memory 从 2026-11-20T01:00:00.000Z 起一直失败（config：404 unknown model；系统已经做了：switched to magpie/codex/gpt-6-luna");
  });

  it("still reads the model state when the job health throws", async () => {
    const fake = services();
    fake.services.backgroundModels = { ...fake.services.backgroundModels!, jobs: () => { throw new Error("db locked"); } };
    const read = await runUiAction(db, { target, action: "read", input: {}, reason: "看一下", caller: { kind: "lead", turnId: null }, services: fake.services });
    expect(read.result).toMatchObject({ resolved: LUNA, jobs: [] });
  });
});
