// Compact Lead's context on request (2026-11-18): the full persisted flow through the HTTP route.
// The daemon, the gateway, the store, the operation layer and the idle lane are real. Lead's session is a stand-in
// (fake-pi-session.ts) whose compact() runs the real idle lane extension, as pi does. The child process that writes the
// summary is replaced (idleCompactSummarize).
//
// Background: the user typed 「压缩一下上下文，用 gpt 6 luna」. Lead had no compaction tool. It wrote a hand-off document, switched its
// own model twice, and said the context was compressed when it was not. Now /compact in the message box (POST /v1/lead/compact)
// and Lead's compact_lead_context run one operation: the summary uses the named model with its own credentials, Lead's model
// stays, and the conversation shows the result.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { scriptedSmartModel } from "@pi-lead-child/engine/testing";
import { idleLaneExtension, type IdleCompactRequest, type IdleLaneRuntime, type SummarizeInChildResult } from "@pi-lead-child/lead";
import { UI_ACTION_PERFORMED_KIND } from "@pi-lead-child/protocol";
import { createLoopbackBinding, listEvents, openDb, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { deferred, fakePiLead, type FakeCall, type FakeReply } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

const CHEAP = "acme/cheap-model";
const CONFIG = {
  lead: {
    providers: {
      acme: { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", discover: false, models: ["lead-model", "cheap-model", "gpt-6-luna"] },
      other: { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", discover: false, models: ["gpt-6-luna"] },
    },
    models: ["acme/lead-model"],
  },
};

beforeEach(() => {
  dir = tempDir("plc-lead-compact-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
  writeFileSync(join(dir, "config.json"), JSON.stringify(CONFIG));
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  // No automatic idle work in these tests: no notes turn, no automatic compaction.
  vi.stubEnv("PLC_LEAD_IDLE_GRACE_MS", "600000");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

interface Summary { request: IdleCompactRequest; finish: (summary: string) => void; fail: (error: string) => void }

async function boot(script: (call: FakeCall) => FakeReply | Promise<FakeReply> = () => ({ say: "好的。" })) {
  const logs: string[] = [];
  const summaries: Summary[] = [];
  // The session's branch: two messages, then a compaction entry for each compaction that pi records.
  const entries: Array<{ type: string; id: string }> = [{ type: "message", id: "e1" }, { type: "message", id: "e2" }];
  const lead = fakePiLead(script, { smartModel: scriptedSmartModel({ answers: { ask_kind: "other" } }), contextUsage: { window: 200_000, tokens: 150_000 } });
  const factory = async (args: any) => {
    const made = await lead.factory(args);
    const runtime = args.idleLane as IdleLaneRuntime;
    const handlers: Array<(event: unknown, ctx: unknown) => Promise<any>> = [];
    // The real extension, as session.ts registers it. The session's registry knows the cheap model.
    const leadModel = { provider: "acme", id: "lead-model", api: "openai-completions", contextWindow: 200_000 };
    // Every catalog model of the test's config is registered in the session.
    const known = new Set([CHEAP, "acme/gpt-6-luna", "other/gpt-6-luna"]);
    const registered = (spec: string) => {
      const slash = spec.indexOf("/");
      return { provider: spec.slice(0, slash), id: spec.slice(slash + 1), api: "openai-completions", contextWindow: 100_000 };
    };
    idleLaneExtension(runtime, { resolveModel: (spec) => (known.has(spec) ? registered(spec) as never : undefined) })(
      { on: (_name: string, handler: (event: unknown, ctx: unknown) => Promise<any>) => handlers.push(handler) } as never,
    );
    const listeners: Array<(event: any) => void> = [];
    const emit = (event: unknown) => { for (const listener of [...listeners]) listener(event); };
    const session = {
      ...made.session,
      subscribe(listener: (event: any) => void) {
        listeners.push(listener);
        return made.session.subscribe(listener);
      },
      // Like pi's AgentSession.compact: "Already compacted" before the hook, then session_before_compact, then compaction_end.
      async compact(instructions?: string) {
        emit({ type: "compaction_start", reason: "manual" });
        if (entries.at(-1)?.type === "compaction") {
          emit({ type: "compaction_end", reason: "manual", result: undefined, aborted: false, willRetry: false, errorMessage: "Compaction failed: Already compacted" });
          throw new Error("Already compacted");
        }
        const event = {
          type: "session_before_compact", reason: "manual", customInstructions: instructions, branchEntries: [...entries], signal: new AbortController().signal,
          preparation: {
            firstKeptEntryId: "e2", messagesToSummarize: [{ role: "user", content: "早先的对话" }], turnPrefixMessages: [], isSplitTurn: false,
            tokensBefore: 150_000, fileOps: { read: new Set(), written: new Set(), edited: new Set() },
            settings: { enabled: true, reserveTokens: 20_000, keepRecentTokens: 20_000 },
          },
        };
        const result = await handlers[0]!(event, {
          model: leadModel, modelRegistry: { getApiKeyAndHeaders: async (model: { id: string }) => ({ ok: true, apiKey: `key-for-${model.id}` }) },
        });
        if (result?.cancel) {
          emit({ type: "compaction_end", reason: "manual", result: undefined, aborted: true, willRetry: false });
          throw new Error("Compaction cancelled");
        }
        if (!result?.compaction) throw new Error("this test expects the idle lane to supply every compaction");
        entries.push({ type: "compaction", id: `c${entries.length}` });
        const compaction = { ...result.compaction, estimatedTokensAfter: 9_000 };
        emit({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false, result: compaction });
        return compaction;
      },
    };
    return { ...made, session };
  };
  daemon = await startDaemon({
    dataDir: dir, dbPath, log: (line: string) => { logs.push(line); }, notifyDesktop: () => {}, triageShadow: false,
    sessionFactory: factory as never,
    idleCompactSummarize: (request) => new Promise<SummarizeInChildResult>((resolve) => {
      summaries.push({
        request,
        finish: (summary) => resolve({ response: { ok: true, summary, details: { chunks: 1 }, chunks: 1, level: "normal" }, ms: 7 }),
        fail: (error) => resolve({ response: { ok: false, error }, ms: 7 }),
      });
    }),
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
  const notices = () => db.prepare(
    "SELECT assistant_text AS text, state FROM channel_turns WHERE origin_kind = 'system:context-notice' ORDER BY created_at",
  ).all() as Array<{ text: string; state: string }>;
  const idleRecords = () => db.prepare(
    "SELECT json_extract(payload, '$.event') AS event, json_extract(payload, '$.manual') AS manual FROM events WHERE kind = 'scheduler.idle_job' ORDER BY seq",
  ).all() as Array<{ event: string; manual: number | null }>;
  return { lead, logs, http, summaries, entries, notices, idleRecords };
}

describe("POST /v1/lead/compact", () => {
  it("compacts at once with the named model and its credentials, shows the result, and keeps Lead's model", async () => {
    const { http, summaries, entries, notices, idleRecords, logs } = await boot();
    const asked = await http("/v1/lead/compact", { model: CHEAP, instructions: "保留工单 12 的细节" });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(asked.body).toEqual({
      applied: "now", model: CHEAP, tokensBefore: 150_000, existing: false, requestApplied: true, candidates: [], reason: null,
    });

    await vi.waitFor(() => expect(summaries).toHaveLength(1), { timeout: 5_000 });
    const { request } = summaries[0]!;
    expect(request.model).toMatchObject({ provider: "acme", id: "cheap-model" });
    expect(request.auth.apiKey).toBe("key-for-cheap-model");
    expect(request.instructions).toBe("保留工单 12 的细节");
    // A second request while the summary is written joins it.
    expect((await http("/v1/lead/compact", {})).body).toMatchObject({ applied: "now", existing: true, model: CHEAP, requestApplied: false });

    summaries[0]!.finish("CHEAP SUMMARY");
    await vi.waitFor(() => expect(notices()).toHaveLength(1), { timeout: 5_000 });
    expect(entries.at(-1)?.type).toBe("compaction");
    // The line names Lead by its display name (leadDisplayName), in the user's language (English by default).
    expect(notices()[0]!.state).toBe("completed");
    expect(notices()[0]!.text).toMatch(/^\S+'s context is compacted: about 150,000 → 9,000 tokens\. The summary was written by acme\/cheap-model\.$/u);
    expect(idleRecords()).toEqual(expect.arrayContaining([{ event: "started", manual: 1 }, { event: "applied", manual: 1 }]));
    // The ledger has the request; Lead's model did not change (config.json and no switch in the log).
    expect(listEvents(db, { kind: UI_ACTION_PERFORMED_KIND, limit: 10 }).map((event) => event.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: { type: "lead_context", id: "lead" }, action: "compact", actor: "user" }),
    ]));
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))).toEqual(CONFIG);
    expect(logs.some((line) => line.includes("lead model chosen") || line.includes("lead model switch"))).toBe(false);

    // Nothing new since that compaction: a clear answer, not an error.
    const again = await http("/v1/lead/compact", {});
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ applied: "nothing_to_compact", existing: false });
    await vi.waitFor(() => expect(notices()).toHaveLength(2), { timeout: 5_000 });
    expect(notices()[1]!.text).toMatch(/^\S+'s context has nothing new to compact since the last compaction\.$/u);
  }, 30_000);

  it("waits for Lead's turn to end, then compacts with Lead's own model", async () => {
    const release = deferred();
    const { http, summaries, notices } = await boot((call) => (call.inputs.some((input) => input.includes("长任务")) ? { say: [release.promise, "做完了。"] } : { say: "好的。" }));
    const sent = await http("/v1/chat/send", { id: "t1", message: "做一个长任务" });
    expect(sent.status).toBe(200);
    await vi.waitFor(async () => expect((await http("/v1/lead/scheduler")).body.unit).not.toBeNull(), { timeout: 5_000 });

    const asked = await http("/v1/lead/compact", {});
    expect(asked.body).toMatchObject({ applied: "after_turn", model: "stub/model", existing: false });
    // Review item 4: a second request that names a model joins the waiting one. The answer names the model that will write
    // the summary (Lead's own), and says that this request's model does not apply.
    expect((await http("/v1/lead/compact", { model: CHEAP })).body)
      .toMatchObject({ applied: "after_turn", model: "stub/model", existing: true, requestApplied: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(summaries).toHaveLength(0);

    release.resolve();
    await vi.waitFor(() => expect(summaries).toHaveLength(1), { timeout: 5_000 });
    // Lead's own model, from the session's registry (the extension's ctx.model).
    expect(summaries[0]!.request.model).toMatchObject({ provider: "acme", id: "lead-model" });
    expect(summaries[0]!.request.auth.apiKey).toBe("key-for-lead-model");
    summaries[0]!.finish("OWN SUMMARY");
    await vi.waitFor(() => expect(notices()).toHaveLength(1), { timeout: 5_000 });
    expect(notices()[0]!.text).toContain("about 150,000 → 9,000 tokens. The summary was written by acme/lead-model.");
  }, 30_000);

  // Review 2026-11-18 (item 1): the user's real words were 「用 gpt 6 luna」. The first version took words without a slash as
  // instructions and compacted with Lead's own model. Now the words must name exactly one model of the catalog.
  it("resolves the user's words to one catalog model, and refuses several or none without starting anything", async () => {
    const { http, summaries } = await boot();
    const ambiguous = await http("/v1/lead/compact", { model: "gpt 6 luna" });
    expect(ambiguous.status).toBe(200);
    expect(ambiguous.body).toMatchObject({
      applied: "model_ambiguous", model: "gpt 6 luna", existing: false, requestApplied: false,
      candidates: ["acme/gpt-6-luna", "other/gpt-6-luna"],
    });
    const unknown = await http("/v1/lead/compact", { model: "luna" });
    expect(unknown.body).toMatchObject({ applied: "model_unknown", candidates: ["acme/gpt-6-luna", "other/gpt-6-luna"] });
    expect((await http("/v1/lead/compact", { model: "acme/gpt-7" })).body).toMatchObject({ applied: "model_unknown" });
    expect((await http("/v1/lead/compact", { model: CHEAP, extra: true })).status).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(summaries).toHaveLength(0);

    // Words that name one model: that model writes the summary.
    const one = await http("/v1/lead/compact", { model: "用 cheap model" });
    expect(one.body).toMatchObject({ applied: "now", model: CHEAP });
    await vi.waitFor(() => expect(summaries).toHaveLength(1), { timeout: 5_000 });
    expect(summaries[0]!.request.model).toMatchObject({ provider: "acme", id: "cheap-model" });
  }, 30_000);

  it("shows a failed summary in the conversation and does not hold Lead's model", async () => {
    const { http, summaries, notices, logs } = await boot();
    await http("/v1/lead/compact", { model: CHEAP });
    await vi.waitFor(() => expect(summaries).toHaveLength(1), { timeout: 5_000 });
    // Review item 6: the error goes into the conversation without the secret in it.
    summaries[0]!.fail("401 invalid api key sk-abcdefghijklmnopqrstuvwxyz0123");
    await vi.waitFor(() => expect(notices()).toHaveLength(1), { timeout: 5_000 });
    expect(notices()[0]!.text).toMatch(/^The compaction of \S+'s context with acme\/cheap-model did not succeed: 401 invalid api key \S+\. The context did not change\.$/u);
    expect(notices()[0]!.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123");
    expect(logs.some((line) => line.includes("model hold"))).toBe(false);
  }, 30_000);

  // Review item 5: a request that waits when the daemon stops is not lost silently.
  it("tells the user when the daemon stops before a waiting compaction ran", async () => {
    const release = deferred();
    const { http, notices } = await boot(() => ({ say: [release.promise, "做完了。"] }));
    await http("/v1/chat/send", { id: "t1", message: "做一个长任务" });
    await vi.waitFor(async () => expect((await http("/v1/lead/scheduler")).body.unit).not.toBeNull(), { timeout: 5_000 });
    expect((await http("/v1/lead/compact", {})).body).toMatchObject({ applied: "after_turn" });
    const closing = daemon!.close();
    release.resolve();
    await closing;
    daemon = null;
    expect(notices()).toEqual([expect.objectContaining({ text: expect.stringMatching(/did not succeed: the background service stopped or restarted/u) })]);
  }, 30_000);
});
