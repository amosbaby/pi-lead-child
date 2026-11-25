// Background health in the daemon (.scratch/background-models/spec.md D3). The full persisted flow: the daemon, the
// gateway, the store, the model hold and the background health are real; Lead's session is a stand-in
// (fake-pi-session.ts), and the decision LLM is the real one (lead's smart-model.ts) on a fake model runtime, built with
// the hooks, the hold and the shared broken-model list that the daemon hands to Lead's session.
//
// The incident (2026-11-17..20): the gateway stopped serving the cheap background model (404). Nothing reached Lead.
// Now:
//   - the call fails over to the next cheap model;
//   - after 3 failures over at least 5 minutes the job is failing: one system.background_failing event (it wakes Lead);
//   - while the model hold is on, nothing is written; when the hold lifts, the event is written then;
//   - repeated failures write no second event;
//   - background_model.read (the settings page and Lead) returns the job's state.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  BrokenBackgroundModels, createLeadSmartModel, normalizeLeadModelConfig, type LeadCatalogModel, type LeadCatalogSource,
} from "@pi-lead-child/lead";
import { BACKGROUND_FAILING_KIND } from "@pi-lead-child/protocol";
import { createLoopbackBinding, listEvents, openDb, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
// The background health's clock: the failure rules need minutes.
let clock: Date;
const advance = (minutes: number) => { clock = new Date(clock.getTime() + minutes * 60_000); };

beforeEach(() => {
  dir = tempDir("plc-background-health-daemon-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  // Local noon: the job's "today" counts do not cross midnight during the test.
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  clock = noon;
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

const MAIN = "magpie/codex/gpt-6.2-sol";
const HAIKU = "magpie/group/auto-claude-haiku-5-5";
const LUNA = "magpie/codex/gpt-6-luna";
const NOT_SERVED = (model: string) => `404 {"error":"magpie knows no model ${model}"}`;
const DISABLED = "403 This service has been disabled in this account for violation of Terms of Service.";

const CONFIG = normalizeLeadModelConfig({
  providers: { magpie: { baseUrl: "http://127.0.0.1:3/v1", discover: false, models: ["codex/gpt-6.2-sol", "codex/gpt-6-luna", "group/auto-claude-haiku-5-5"] } },
  models: [MAIN],
}, {});

// The gateway's priced catalog: haiku and luna are cheap, sol is Lead's.
function model(spec: string, created: number, input: number, output: number): LeadCatalogModel {
  const slash = spec.indexOf("/");
  return {
    provider: spec.slice(0, slash), id: spec.slice(slash + 1), group: null, source: null, name: null, input: ["text"],
    efforts: [], defaultEffort: null, contextWindow: null, maxTokens: null, created: new Date(created * 1000).toISOString(), price: { input, output, cacheRead: input / 10 },
  };
}
const CATALOG = [model(MAIN, 1_793_000_000, 2, 10), model(HAIKU, 1_793_500_000, 0.1, 0.5), model(LUNA, 1_791_000_000, 0.1, 0.5)];
const catalog: LeadCatalogSource = { get: async () => CATALOG, snapshot: () => CATALOG, invalidate: () => {} };

// The fake model runtime: the gateway does not serve haiku (404); luna answers or not, as the test says. A gate holds
// the next call open (a background call in flight while the hold opens).
function gateway() {
  const calls: string[] = [];
  const state = { lunaServed: false, gate: null as Promise<void> | null };
  const runtime = {
    getModels: (provider: string) => CATALOG.filter((entry) => entry.provider === provider).map((entry) => ({ provider, id: entry.id })),
    getModel: (provider: string, id: string) => (CATALOG.some((entry) => entry.provider === provider && entry.id === id) ? { provider, id } : undefined),
    completeSimple: async (target: { provider: string; id: string }) => {
      const spec = `${target.provider}/${target.id}`;
      calls.push(spec);
      const gate = state.gate;
      state.gate = null;
      if (gate) await gate;
      if (spec === LUNA && state.lunaServed) return { stopReason: "stop", content: [{ type: "text", text: '{"topic": "x", "facts": []}' }] };
      return { stopReason: "error", errorMessage: NOT_SERVED(spec), content: [] };
    },
  };
  return { runtime, calls, state };
}

async function boot() {
  const lead = fakePiLead(() => ({ say: "好的。" }));
  daemon = await startDaemon({
    dataDir: dir, dbPath, log: () => {}, notifyDesktop: () => {}, triageShadow: false,
    sessionFactory: lead.factory as never,
    backgroundHealthNow: () => clock,
  });
  const owner = createLoopbackBinding(db, { name: "Mac 网页" });
  const http = async (path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${owner.accessToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  await vi.waitFor(() => expect(lead.deps().backgroundModelHooks).toBeDefined(), { timeout: 5_000 });
  return { lead, http };
}

const failingEvents = () => listEvents(db, { kind: BACKGROUND_FAILING_KIND });
const turnState = (id: string) => (db.prepare("SELECT state FROM channel_turns WHERE id = ?").get(id) as { state: string } | undefined)?.state;

describe("a background model that the gateway no longer serves", () => {
  it("fails over, tells Lead once after the failure rules, holds the event while the model hold is on, and shows the job state", async () => {
    const { lead, http } = await boot();
    const deps = lead.deps();
    const model = gateway();
    // The decision LLM as Lead's session builds it, with what the daemon handed over: the health hooks, the model hold,
    // the shared broken-model list. Broken models are skipped for a minute of the test clock (1 hour live), so every
    // call below tries the cheap models again.
    const built = createLeadSmartModel({
      modelRuntime: model.runtime as never, config: CONFIG, leadSpec: MAIN, dataDir: dir, env: {}, catalog,
      broken: new BrokenBackgroundModels({ now: () => clock.getTime(), ttlMs: 60_000 }),
      hold: deps.modelHold, ...deps.backgroundModelHooks,
    });
    const extract = () => built.complete!("整理这个线程", { purpose: "channel_memory" });
    const readJobs = async () => {
      const read = await http("/v1/actions/background_model/lead/read", { input: {} });
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      return read.body.result.jobs as Array<Record<string, unknown>>;
    };

    // Two calls, three minutes apart: haiku 404s, the call fails over to luna, luna 404s too. Four failures in three
    // minutes: not failing yet.
    await expect(extract()).rejects.toThrow(/404/);
    expect([...model.calls].sort()).toEqual([HAIKU, LUNA].sort());
    advance(3);
    await expect(extract()).rejects.toThrow(/404/);
    expect(failingEvents()).toEqual([]);
    expect((await readJobs()).find((job) => job.job === "background_model")).toMatchObject({ state: "ok", callsToday: 4, failuresToday: 4 });

    // Six minutes in, a call is in flight when Lead's own turn hits an account-level failure: the model hold opens.
    // The call's failures cross the failure rules while the hold is on: the job is failing, but nothing is written.
    advance(3);
    let release!: () => void;
    model.state.gate = new Promise<void>((resolve) => { release = resolve; });
    const inFlight = extract().catch((error: unknown) => error);
    await vi.waitFor(() => expect(model.calls).toHaveLength(5));
    deps.modelHold.failed("turn", DISABLED);
    expect(deps.modelHold.held).toBe(true);
    release();
    expect(String(await inFlight)).toMatch(/404/);
    expect((await readJobs()).find((job) => job.job === "background_model")).toMatchObject({
      state: "failing", reasonClass: "config", reason: expect.stringContaining("404"), since: expect.any(String),
    });
    expect(failingEvents()).toEqual([]);
    // While the hold is on, the decision LLM makes no call and reports nothing.
    await expect(extract()).rejects.toThrow(/model hold/);
    expect(model.calls).toHaveLength(6);
    expect(failingEvents()).toEqual([]);

    // The user's own message gets an answer: the hold lifts, and the job that is still failing is told now, once.
    const sent = await http("/v1/chat/send", { id: "t1", message: "你好" });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    await vi.waitFor(() => expect(turnState(sent.body.turnId)).toBe("completed"), { timeout: 5_000 });
    expect(deps.modelHold.held).toBe(false);
    await vi.waitFor(() => expect(failingEvents()).toHaveLength(1), { timeout: 5_000 });
    const [event] = failingEvents();
    expect(event).toMatchObject({ level: "tell", entityKey: expect.stringContaining("background_model") });
    expect(event!.payload).toMatchObject({
      job: "background_model", reasonClass: "config", afterHold: true, failures: 6, operation: "background_model.set",
    });

    // More failures: still failing, no second event.
    for (let round = 0; round < 3; round += 1) {
      advance(4);
      await expect(extract()).rejects.toThrow(/404/);
    }
    expect(failingEvents()).toHaveLength(1);

    // The settings page and Lead read the job's state: failing since the first failure, with today's counts.
    const jobs = await readJobs();
    expect(jobs.map((job) => job.job)).toEqual(expect.arrayContaining(["background_model", "channel_memory", "hindsight"]));
    expect(jobs.find((job) => job.job === "background_model")).toEqual({
      job: "background_model", state: "failing", since: new Date(clock.getTime() - 18 * 60_000).toISOString(),
      reasonClass: "config", reason: NOT_SERVED(model.calls.at(-1)!), action: "no other cheap model", callsToday: 12, failuresToday: 12,
    });
  }, 30_000);
});
