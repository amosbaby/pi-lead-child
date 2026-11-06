// 当前已认证的配对用户轮次（activePairedUserTurn）在插话上的边界（#265）。
// 用户的消息在 Lead 忙时插进正在跑的那一轮（steer）：轮次停在 steered，用户的消息还没有结局（markTurnInserted），
// Lead 接下来说的话就是对它的回答。这一轮还在进行，和新开的一轮（streaming）一样算用户本人的一轮。
// steered 也是几种结局的终态：和别的消息一起答了、被下一条接替、取消了。那时用户的消息已经有了结局，不再算。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  activePairedUserTurn, channelOwnerBinding, completeTurn, createLoopbackBinding, createTurn, markTurnInserted, markTurnSteered,
  openDb, settleTurnAnsweredWith, settleTurnCancelled, type Db,
} from "../src/index.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-user-turn-authority-"), "plc.db"));
});
afterEach(() => db.close());

function slackSelfDm(id: string, state: "queued" | "streaming" = "queued") {
  const binding = channelOwnerBinding(db, { subject: "slack:U000TEST", name: "Slack 私信（你自己）" })!;
  return createTurn(db, { id, originBindingId: binding.id, originKind: "paired:slack", userText: "可以，按你说的加", state });
}

describe("activePairedUserTurn and a message that steered into a running turn", () => {
  it("accepts the user's Slack DM to themself while it is steered and still waiting for its answer", () => {
    const turn = slackSelfDm("turn_slack_steered");
    expect(markTurnInserted(db, turn.id)).toBe(true);
    expect(activePairedUserTurn(db, turn.id, "set_budget", "tickets:create")).toMatchObject({
      id: turn.id, origin_kind: "paired:slack", state: "steered",
    });
  });

  it("accepts an App message that steered in the same way", () => {
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    const turn = createTurn(db, { id: "turn_app_steered", originBindingId: binding.id, originKind: "paired:companion", userText: "可以，按你说的加", state: "queued" });
    markTurnInserted(db, turn.id);
    expect(activePairedUserTurn(db, turn.id, "set_budget", "tickets:create").state).toBe("steered");
  });

  it("refuses a steered turn once the user's message has its outcome", () => {
    const answered = slackSelfDm("answered");
    markTurnInserted(db, answered.id);
    settleTurnAnsweredWith(db, answered.id, { answeredWith: null, note: "和下一条一起答了" });
    const replaced = slackSelfDm("replaced", "streaming");
    markTurnSteered(db, replaced.id);
    const cancelled = slackSelfDm("cancelled");
    settleTurnCancelled(db, cancelled.id, { by: "user" });
    const sealed = slackSelfDm("sealed");
    markTurnInserted(db, sealed.id);
    completeTurn(db, sealed.id);
    for (const id of [answered.id, replaced.id, cancelled.id, sealed.id]) {
      expect(() => activePairedUserTurn(db, id, "set_budget", "tickets:create")).toThrow(/is no longer active/);
    }
  });

  it("refuses a steered turn that has no user message on record", () => {
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    const turn = createTurn(db, {
      id: "no_message", originBindingId: binding.id, originKind: "paired:companion", userText: "/fairyeye on",
      state: "queued", userMessageEvent: false,
    });
    markTurnInserted(db, turn.id);
    expect(() => activePairedUserTurn(db, turn.id, "set_budget", "tickets:create")).toThrow(/is no longer active/);
  });
});
