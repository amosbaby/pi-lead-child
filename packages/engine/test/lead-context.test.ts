// Compact Lead's context on request (2026-11-18, protocol's lead-context.ts). The operation layer is real; the daemon's
// LeadContextService is a stand-in. Checked here:
//   - lead_context.compact: one operation for the page and for Lead. lead_allowed, not a rule change, not external,
//     not irreversible, not limited to the user's own turn;
//   - the service learns if the user asked (the page, or Lead in the user's own live turn): the hold rule reads it;
//   - Lead is not refused in a turn that read external content (compacting changes no rule);
//   - the ledger records each request, and Lead gets what to do next.
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { UI_ACTION_PERFORMED_KIND, type CompactLeadContextRequest, type CompactLeadContextResult } from "@pi-lead-child/protocol";
import { createLoopbackBinding, createTurn, listEvents, openDb, type Db } from "@pi-lead-child/store";
import { UI_ACTIONS, runUiAction, type LeadContextService } from "../src/index.js";

let db: Db;
let calls: Array<{ request: CompactLeadContextRequest; byUser: boolean }>;
let answer: CompactLeadContextResult;
const leadContext: LeadContextService = {
  state: () => ({ model: "acme/lead-model", tokens: 180_000 }),
  compact: async (request, options) => {
    calls.push({ request, byUser: options.byUser });
    return answer;
  },
};

beforeEach(() => {
  db = openDb(join(tempDir("plc-lead-context-"), "plc.db"));
  calls = [];
  answer = { applied: "now", model: "acme/cheap-model", tokensBefore: 180_000, existing: false, requestApplied: true, candidates: [], reason: null };
});

const target = { type: "lead_context", id: "lead" } as const;
const ledger = () => listEvents(db, { kind: UI_ACTION_PERFORMED_KIND, limit: 10 }).map((event) => event.payload);

describe("lead_context.compact", () => {
  it("is one operation that Lead may run on its own judgment, and it changes no rule", () => {
    expect(UI_ACTIONS.lead_context.compact).toMatchObject({
      permission: "lead_allowed", changesRules: false, external: false, irreversible: false, scope: "chat",
    });
    expect((UI_ACTIONS.lead_context.compact as { userTurnOnly?: boolean }).userTurnOnly).toBeFalsy();
  });

  it("from the page: the user asked, and the ledger records the model and how it was applied", async () => {
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    const outcome = await runUiAction(db, {
      target, action: "compact", input: { model: "acme/cheap-model", instructions: "keep ticket 12" }, services: { leadContext },
      caller: { kind: "user", credential: binding, source: { client: "web", deviceName: "Mac 网页", loopback: true, fromThisMachine: true } } as never,
    });
    expect(outcome.result).toEqual(answer);
    expect(calls).toEqual([{ request: { model: "acme/cheap-model", instructions: "keep ticket 12" }, byUser: true }]);
    expect(ledger()).toEqual([expect.objectContaining({
      target, action: "compact", actor: "user",
      detail: { model: "acme/cheap-model", requestedModel: "acme/cheap-model", applied: "now", tokensBefore: 180_000, existing: false, instructions: true },
    })]);
  });

  it("from Lead: only the user's own live turn counts as the user's request", async () => {
    await runUiAction(db, { target, action: "compact", input: {}, reason: "上下文快满了", services: { leadContext }, caller: { kind: "lead", turnId: null } });
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    const turnId = createTurn(db, { originBindingId: binding.id, originKind: "paired:companion", userText: "压缩一下上下文", state: "streaming" }).id;
    const outcome = await runUiAction(db, {
      target, action: "compact", input: {}, reason: "用户说压缩一下上下文", services: { leadContext }, caller: { kind: "lead", turnId },
    });
    expect(calls.map((call) => call.byUser)).toEqual([false, true]);
    expect(String((outcome.forLead as { next?: string }).next)).toContain("不要再写交接文档");
  });

  it("is not refused in a turn that read external content: it changes no rule", async () => {
    const external = [{ via: "message", source: "slack" }] as const;
    await runUiAction(db, {
      target, action: "compact", input: {}, reason: "上下文快满了", services: { leadContext },
      caller: { kind: "lead", turnId: null, externalContent: external },
    });
    expect(calls).toHaveLength(1);
  });

  it("tells Lead what to do when the hold refused it", async () => {
    answer = { applied: "held", model: "acme/lead-model", tokensBefore: null, existing: false, requestApplied: false, candidates: [], reason: "model hold" };
    const outcome = await runUiAction(db, { target, action: "compact", input: {}, reason: "上下文快满了", services: { leadContext }, caller: { kind: "lead", turnId: null } });
    expect(outcome.forLead).toMatchObject({ applied: "held" });
    expect(String((outcome.forLead as { next?: string }).next)).toContain("另一个模型");
  });

  // Review item 1: words that match several models start nothing; Lead is told to pick one or ask, never to fall back.
  it("tells Lead to pick a candidate or ask when the model words are ambiguous or unknown", async () => {
    answer = {
      applied: "model_ambiguous", model: "gpt 6 luna", tokensBefore: 180_000, existing: false, requestApplied: false,
      candidates: ["auto/gpt-6-luna", "codex/gpt-6-luna"], reason: "several models match",
    };
    const ambiguous = await runUiAction(db, {
      target, action: "compact", input: { model: "gpt 6 luna" }, reason: "用户说用 gpt 6 luna 压缩", services: { leadContext }, caller: { kind: "lead", turnId: null },
    });
    expect(calls.at(-1)?.request).toEqual({ model: "gpt 6 luna" });
    expect(ambiguous.forLead).toMatchObject({ applied: "model_ambiguous", candidates: ["auto/gpt-6-luna", "codex/gpt-6-luna"] });
    expect(String((ambiguous.forLead as { next?: string }).next)).toContain("不要退回用你自己的模型");
    answer = { ...answer, applied: "model_unknown", candidates: [] };
    const unknown = await runUiAction(db, {
      target, action: "compact", input: { model: "luna" }, reason: "r", services: { leadContext }, caller: { kind: "lead", turnId: null },
    });
    expect(String((unknown.forLead as { next?: string }).next)).toContain("list_lead_models");
  });

  it("takes only a model and instructions", async () => {
    await expect(runUiAction(db, {
      target, action: "compact", input: { model: "acme/m", extra: 1 }, reason: "r", services: { leadContext }, caller: { kind: "lead", turnId: null },
    })).rejects.toMatchObject({ code: "invalid_input" });
    expect(calls).toEqual([]);
  });

  it("says the session is not ready when there is no service", async () => {
    await expect(runUiAction(db, { target, action: "compact", input: {}, reason: "r", caller: { kind: "lead", turnId: null } }))
      .rejects.toMatchObject({ code: "unavailable" });
  });
});
