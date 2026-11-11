// 执行模式（.scratch/external-worker-hub/spec.md P1-1）：self（缺省，daemon 自己起执行者）| external（外部工人领单）| paused（总闸）。
// 核对：
//   - 模式存在 kv 的 execution.mode；没有、或者坏了时是 self；
//   - 切换是操作层的 execution_mode.set：user_direct、改规则、记账本。Lead 调它在哪一轮都拿到结构化的拒绝；
//   - 建 Run 之前的闸门 deferIfExternal：不是 self 时返回 true，记一条 execution_deferred，不建 Run，不改 stage；
//   - 派发队列在 external、paused 下不认领请求：请求留着，每个请求只记一次 execution_deferred；切回 self 照常认领；
//   - external 这个 runtime 不起进程，也不出现在任何选择 runtime 的地方。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { EXTERNAL_RUNTIME_ID, KERNEL_RUNTIME_IDS, UI_ACTION_PERFORMED_KIND } from "@pi-lead-child/protocol";
import {
  allRuntimeAdapters, createDefaultRuntimeRegistry, externalAdapter, findRuntimeAdapter, isRuntimeId, reviewRuntimeOrder,
  runtimeAdapters, runtimeFallbackOrder, runtimeIds,
} from "@pi-lead-child/runtime";
import {
  createItem, createLoopbackBinding, createTurn, getItem, listActivities, listEvents, listRuns, openDb, type Db,
} from "@pi-lead-child/store";
import {
  changeReviewer, createDispatcher, deferIfExternal, reviewerOptions, EXECUTION_DEFERRED_DECISION, EXECUTION_MODE_KEY, EXECUTION_MODE_WHERE, getExecutionMode,
  runUiAction,
} from "../src/index.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-execution-mode-"), "plc.db"));
});

const target = { type: "execution_mode", id: "daemon" } as const;
const NOW = new Date("2026-11-12T06:00:00.000Z");

function asUser(mode: unknown) {
  const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
  return runUiAction(db, {
    target, action: "set", input: { mode },
    caller: { kind: "user", credential: binding, source: { client: "web", deviceName: "Mac 网页", loopback: true, fromThisMachine: true } } as never,
    now: NOW,
  });
}

const writeRaw = (value: string) => db.prepare(
  `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
).run(EXECUTION_MODE_KEY, value);

function deferrals(itemId: number) {
  return listActivities(db, itemId, 1000)
    .map((activity) => ({ kind: activity.kind, payload: JSON.parse(activity.payload) }))
    .filter((activity) => activity.payload.decision === EXECUTION_DEFERRED_DECISION);
}

describe("the execution mode", () => {
  it("is self when nothing is stored, and self when the stored value is broken", () => {
    expect(getExecutionMode(db)).toBe("self");
    for (const raw of ["{ not json", JSON.stringify({ mode: "fast" }), JSON.stringify("external"), "null"]) {
      writeRaw(raw);
      expect(getExecutionMode(db)).toBe("self");
    }
  });

  it("is switched by you from the page, and the switch is in the ledger", async () => {
    const outcome = await asUser("external");
    expect(outcome.result).toMatchObject({ mode: "external", changed: true });
    expect(getExecutionMode(db)).toBe("external");
    await asUser("paused");
    expect(getExecutionMode(db)).toBe("paused");
    const again = await asUser("paused");
    expect(again.result).toMatchObject({ mode: "paused", changed: false });
    await asUser("self");
    expect(getExecutionMode(db)).toBe("self");
    const ledger = listEvents(db, { kind: UI_ACTION_PERFORMED_KIND, limit: 10 }).map((event) => event.payload);
    expect(ledger).toEqual([
      expect.objectContaining({ target, action: "set", actor: "user", detail: { mode: "external", changed: true } }),
      expect.objectContaining({ target, action: "set", actor: "user", detail: { mode: "paused", changed: true } }),
      expect.objectContaining({ target, action: "set", actor: "user", detail: { mode: "paused", changed: false } }),
      expect.objectContaining({ target, action: "set", actor: "user", detail: { mode: "self", changed: true } }),
    ]);
  });

  it("refuses a mode that does not exist", async () => {
    for (const mode of ["fast", "", null, 1]) {
      await expect(asUser(mode)).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(getExecutionMode(db)).toBe("self");
  });

  it("Lead gets a structured refusal when switching the mode", async () => {
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    createTurn(db, { id: "turn-user", originBindingId: binding.id, originKind: "paired:companion", userText: "切到外部模式", state: "streaming" });
    for (const caller of [
      { kind: "lead", turnId: null },
      { kind: "lead", turnId: "turn-user" },
      { kind: "lead", turnId: null, externalContent: [{ via: "message", source: "slack" }] },
    ] as const) {
      for (const mode of ["external", "paused", "self"]) {
        const refused = await runUiAction(db, {
          target, action: "set", input: { mode }, reason: "用户让我切", caller, now: NOW,
        }).catch((error: unknown) => error);
        expect(refused).toMatchObject({
          code: "user_direct",
          refusal: { code: "user_direct", permission: "user_direct", where: EXECUTION_MODE_WHERE, target, action: "set" },
        });
      }
    }
    expect(getExecutionMode(db)).toBe("self");
    expect(listEvents(db, { kind: UI_ACTION_PERFORMED_KIND, limit: 10 })).toEqual([]);
  });
});

describe("deferIfExternal, the gate before a Run is created", () => {
  it("lets a start through in self mode and records nothing", () => {
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
    expect(deferIfExternal(db, itemId, "spawn_child")).toBe(false);
    expect(deferrals(itemId)).toEqual([]);
  });

  it.each(["external", "paused"] as const)("in %s mode it defers: the ticket stays ready, one activity, no Run", async (mode) => {
    await asUser(mode);
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
    expect(deferIfExternal(db, itemId, "spawn_child")).toBe(true);
    expect(getItem(db, itemId)!.stage).toBe("ready");
    expect(listRuns(db, itemId)).toEqual([]);
    expect(deferrals(itemId)).toEqual([
      { kind: "decision", payload: { decision: EXECUTION_DEFERRED_DECISION, mode, reason: "spawn_child" } },
    ]);
  });
});

describe("the dispatch queue", () => {
  it.each(["external", "paused"] as const)("in %s mode claims nothing, keeps the request, and says so once", async (mode) => {
    await asUser(mode);
    const itemId = createItem(db, { title: "queued", brief: "b", createdBy: "user", runtime: "codex" });
    const dispatcher = createDispatcher(db);
    const requestId = dispatcher.request({
      itemId, role: "executor", purpose: "execution", runtime: "codex", trigger: "test", idempotencyKey: `deferred:${mode}`,
    });
    expect(dispatcher.claimNext()).toBeNull();
    expect(dispatcher.claimNext()).toBeNull();
    expect(listRuns(db, itemId)).toEqual([]);
    expect(getItem(db, itemId)!.stage).toBe("ready");
    expect(db.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(requestId)).toEqual({ state: "pending" });
    expect(deferrals(itemId)).toEqual([
      { kind: "decision", payload: { decision: EXECUTION_DEFERRED_DECISION, mode, reason: "dispatch:test" } },
    ]);

    await asUser("self");
    expect(dispatcher.claimNext()).toMatchObject({ itemId, requestId });
    expect(listRuns(db, itemId)).toHaveLength(1);
  });
});

describe("the external runtime", () => {
  it("external never appears in runtime choices", () => {
    expect(runtimeFallbackOrder({})).not.toContain(EXTERNAL_RUNTIME_ID);
    expect(reviewRuntimeOrder({})).not.toContain(EXTERNAL_RUNTIME_ID);
    // 配置里点名它也不行。
    expect(runtimeFallbackOrder({ PLC_RUNTIME_FALLBACKS: "external,codex" })).toEqual(
      runtimeFallbackOrder({ PLC_RUNTIME_FALLBACKS: "codex" }),
    );
    expect(reviewRuntimeOrder({ PLC_REVIEW_RUNTIME: "external" })).toEqual(reviewRuntimeOrder({}));
    expect(runtimeIds({})).not.toContain(EXTERNAL_RUNTIME_ID);
    expect(runtimeAdapters({}).map((adapter) => adapter.id)).not.toContain(EXTERNAL_RUNTIME_ID);
    expect(allRuntimeAdapters().map((adapter) => adapter.id)).not.toContain(EXTERNAL_RUNTIME_ID);
    expect(KERNEL_RUNTIME_IDS).not.toContain(EXTERNAL_RUNTIME_ID);
    expect(createDefaultRuntimeRegistry().find(EXTERNAL_RUNTIME_ID)).toBeUndefined();
    expect(reviewerOptions(null, { env: {} }).map((option) => option.runtime)).not.toContain(EXTERNAL_RUNTIME_ID);
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
    expect(() => changeReviewer(db, itemId, EXTERNAL_RUNTIME_ID, { by: { actor: "user" } } as never))
      .toThrow(expect.objectContaining({ code: "unknown_runtime" }));
  });

  it("is known by id, so a Run that an external worker holds can be read", () => {
    expect(isRuntimeId(EXTERNAL_RUNTIME_ID)).toBe(true);
    expect(findRuntimeAdapter(EXTERNAL_RUNTIME_ID)).toBe(externalAdapter);
  });

  it("starts no process: start returns at once, with no pid and an exit that says why", async () => {
    const handle = await externalAdapter.create().start({
      itemId: 1, runId: 1, role: "executor", purpose: "execution", prompt: "p", workdir: "/tmp", env: {},
    });
    expect(handle.pid).toBeNull();
    expect(handle.process).toBeUndefined();
    const events = [];
    for await (const event of handle.events) events.push(event);
    expect(events).toEqual([]);
    expect(await handle.wait()).toMatchObject({ ok: false, exitCode: null, errorCode: "external_runtime_no_process" });
  });
});
