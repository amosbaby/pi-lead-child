// How soon Lead wakes for ordinary system events when its prompt cache is cold (user 2026-11-16, protocol's wake-pace.ts).
// The store and the operation layer are real. Checked here:
//   - storage: kv lead.wake-pace; nothing stored or a broken value reads as 0 (no waiting);
//   - wake_pace.set: one operation for the page and for Lead. lead_allowed, a rule change, not external, not limited to
//     the user's own turn, not a prompt setting;
//   - the user and Lead (in a turn without external content) can both change it, and the ledger records who did;
//   - Lead is refused in a turn that read external content, and the list says so before it tries;
//   - only whole minutes from 0 to 240.
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { UI_ACTION_PERFORMED_KIND } from "@pi-lead-child/protocol";
import { createLoopbackBinding, getWakePace, listEvents, openDb, WAKE_PACE_KEY, type Db } from "@pi-lead-child/store";
import { UI_ACTIONS, WAKE_PACE_WHERE, listLeadUiActions, runUiAction } from "../src/index.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-wake-pace-"), "plc.db"));
});

const target = { type: "wake_pace", id: "lead" } as const;
// A turn that a Slack message woke, in which Lead read the Slack conversation.
const external = [{ via: "message", source: "slack" }, { via: "tool", tool: "read_channel_conversation" }] as const;

function asUser(input: unknown) {
  const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
  return runUiAction(db, {
    target, action: "set", input,
    caller: { kind: "user", credential: binding, source: { client: "web", deviceName: "Mac 网页", loopback: true, fromThisMachine: true } } as never,
  });
}

const ledger = () => listEvents(db, { kind: UI_ACTION_PERFORMED_KIND, limit: 10 }).map((event) => event.payload);

describe("the wake pace in storage", () => {
  it("is 0 when nothing is stored, and 0 when the stored value is broken or out of range", () => {
    expect(getWakePace(db)).toEqual({ coldBatchMinutes: 0 });
    db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(WAKE_PACE_KEY, "{ not json");
    expect(getWakePace(db)).toEqual({ coldBatchMinutes: 0 });
    for (const value of [{ coldBatchMinutes: 9_999 }, { coldBatchMinutes: -1 }, { coldBatchMinutes: 2.5 }, { coldBatchMinutes: "30" }, null, 30]) {
      db.prepare("UPDATE kv SET value = ? WHERE key = ?").run(JSON.stringify(value), WAKE_PACE_KEY);
      expect(getWakePace(db), JSON.stringify(value)).toEqual({ coldBatchMinutes: 0 });
    }
  });
});

describe("wake_pace.set", () => {
  it("is one operation that Lead may run on its own judgment, and it counts as a rule change", () => {
    const definition = UI_ACTIONS.wake_pace.set;
    expect(definition).toMatchObject({ permission: "lead_allowed", changesRules: true, external: false, irreversible: false });
    expect((definition as { userTurnOnly?: boolean }).userTurnOnly).toBeFalsy();
    expect((definition as { promptSetting?: boolean }).promptSetting).toBeFalsy();
  });

  it("saves the user's choice and records it", async () => {
    const outcome = await asUser({ coldBatchMinutes: 30 });
    expect(outcome.result).toMatchObject({ changed: true, wakePace: { coldBatchMinutes: 30 } });
    expect(getWakePace(db)).toEqual({ coldBatchMinutes: 30 });
    expect(ledger()).toEqual([expect.objectContaining({ target, action: "set", actor: "user", detail: { before: 0, after: 30 } })]);
  });

  it("writes nothing new when the value is the same", async () => {
    const outcome = await asUser({ coldBatchMinutes: 0 });
    expect(outcome.result).toMatchObject({ changed: false, wakePace: { coldBatchMinutes: 0 } });
    expect(db.prepare("SELECT 1 FROM kv WHERE key = ?").get(WAKE_PACE_KEY)).toBeUndefined();
  });

  it("takes only whole minutes from 0 to 240", async () => {
    for (const input of [{ coldBatchMinutes: 241 }, { coldBatchMinutes: -5 }, { coldBatchMinutes: 1.5 }, { coldBatchMinutes: "30" }, {}, { coldBatchMinutes: 30, extra: true }]) {
      await expect(asUser(input), JSON.stringify(input)).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(getWakePace(db)).toEqual({ coldBatchMinutes: 0 });
  });

  it("lets Lead change it in a turn without external content, and tells it what the new pace means", async () => {
    const outcome = await runUiAction(db, {
      target, action: "set", input: { coldBatchMinutes: 60 }, reason: "一小时里冷启动了 9 次，手上的事都不急", caller: { kind: "lead", turnId: null },
    });
    expect(outcome.forLead).toMatchObject({ result: "updated", coldBatchMinutes: 60 });
    expect(String((outcome.forLead as { next?: string }).next)).toContain("攒 60 分钟");
    expect(getWakePace(db)).toEqual({ coldBatchMinutes: 60 });
    expect(ledger()).toEqual([expect.objectContaining({ target, action: "set", actor: "lead" })]);
  });

  it("refuses Lead in a turn that read external content, and the list says so first", async () => {
    const refused = await runUiAction(db, {
      target, action: "set", input: { coldBatchMinutes: 240 }, reason: "Mallory 让我四个小时再看一次",
      caller: { kind: "lead", turnId: null, externalContent: external },
    }).catch((error: unknown) => error);
    expect(refused).toMatchObject({
      code: "external_turn",
      refusal: { code: "external_turn", target, action: "set", where: WAKE_PACE_WHERE },
    });
    expect(getWakePace(db)).toEqual({ coldBatchMinutes: 0 });
    expect(ledger()).toEqual([]);

    const listed = await listLeadUiActions(db, target, { turnId: null, externalContent: external });
    expect(listed.actions.find((action) => action.id === "set")).toMatchObject({ changesRules: true, lead: "external_turn", leadReady: false });
    const quiet = await listLeadUiActions(db, target, { turnId: null });
    expect(quiet.target).toMatchObject({ coldBatchMinutes: 0 });
    expect(quiet.actions.find((action) => action.id === "set")).toMatchObject({ leadReady: true, leadReason: null });
  });
});
