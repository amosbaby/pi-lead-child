// 会话卡片上的按钮做成以后（工单 #263，protocol 的 surface-actions.ts）：执行请求带上卡片的来源（origin），
// 成功以后服务端按「哪一次 render_ui 调用、哪个按钮」记一条，GET /v1/conversation/surface-actions 读回来。
// 刷新页面、换一台设备打开时，卡片据此显示「已完成」。失败的操作不记。
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SurfaceActionsResponseSchema } from "@pi-lead-child/protocol";
import { createItem, createPairing, getItem, openDb, transition, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { liveChildren } from "@pi-lead-child/engine";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";
import { createUserActionService } from "../src/user-actions.js";

let db: Db;
beforeEach(() => {
  db = openDb(join(tempDir("plc-surface-actions-"), "plc.db"));
  liveChildren().clear();
});
afterEach(() => db.close());

async function start() {
  const runtime = () => ({ model: "stub/model", sessionId: "stub-session", busy: false, runningItemIds: [], aish: null });
  const server = await startPairedServer({
    db, controlPlane: createControlPlaneService(db, { runtime }), userActions: createUserActionService({ db, resumeRun: () => {} }),
    hello: () => runtime(), chat: () => "started", addClient: () => () => {}, log: () => {},
  }, { port: 0 });
  return { ...server, base: `http://127.0.0.1:${server.port}` };
}

async function redeem(base: string, scopes: string[]) {
  const { code } = createPairing(db, { name: "phone", kind: "companion", scopes });
  const response = await fetch(`${base}/v1/paired/redeem`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairing_code: code }),
  });
  return (await response.json() as { access_token: string }).access_token;
}

describe("buttons done on a conversation card", () => {
  it("records a ticket action pressed on a card, and another device reads it back", async () => {
    const itemId = createItem(db, { title: "单行发送回跳", brief: "b", createdBy: "lead" });
    const server = await start();
    try {
      const phone = { authorization: `Bearer ${await redeem(server.base, ["chat", "tickets:view", "tickets:create"])}`, "content-type": "application/json" };
      const laptop = { authorization: `Bearer ${await redeem(server.base, ["chat"])}` };
      const origin = { callId: "call-budget", node: "raise-a" };
      const pressed = await fetch(`${server.base}/v1/tickets/${itemId}/actions/set_budget`, {
        method: "POST", headers: phone, body: JSON.stringify({ input: { tokenBudget: 30_000_000 }, origin }),
      });
      expect(pressed.status).toBe(200);
      expect(getItem(db, itemId)!.token_budget).toBe(30_000_000);

      const read = await fetch(`${server.base}/v1/conversation/surface-actions?call=call-budget&call=call-other`, { headers: laptop });
      expect(read.status).toBe(200);
      const body = await read.json();
      expect(Value.Check(SurfaceActionsResponseSchema, body)).toBe(true);
      expect(body.actions).toEqual([{
        callId: "call-budget", node: "raise-a", target: { type: "ticket", id: String(itemId) }, action: "set_budget", at: expect.any(String),
      }]);
    } finally {
      await server.close();
    }
  });

  it("does not record an action that failed, nor one pressed outside a card", async () => {
    const draft = createItem(db, { title: "草稿", brief: "b", createdBy: "lead", hold: true });
    const reminder = createItem(db, { kind: "reminder", title: "体检", brief: "", createdBy: "user", remindAt: "2099-10-29T06:00:00.000Z" });
    transition(db, { itemId: reminder, to: "cancelled", actor: "user", reason: "x" });
    const server = await start();
    try {
      const headers = { authorization: `Bearer ${await redeem(server.base, ["chat", "tickets:view", "tickets:create"])}`, "content-type": "application/json" };
      // 草稿不能验收：409，按钮旁边写原因，不记已完成。
      const refused = await fetch(`${server.base}/v1/tickets/${draft}/actions/complete`, {
        method: "POST", headers, body: JSON.stringify({ origin: { callId: "call-1", node: "accept" } }),
      });
      expect(refused.status).toBe(409);
      const cancelled = await fetch(`${server.base}/v1/actions/reminder/${reminder}/reschedule`, {
        method: "POST", headers, body: JSON.stringify({ input: { remindAt: "2099-10-30T06:00:00.000Z" }, origin: { callId: "call-1", node: "move" } }),
      });
      expect(cancelled.status).toBe(409);
      // 工单详情里的按钮不带 origin：做成了也不记。
      const confirmed = await fetch(`${server.base}/v1/tickets/${draft}/actions/confirm`, { method: "POST", headers, body: "{}" });
      expect(confirmed.status).toBe(200);
      const read = await (await fetch(`${server.base}/v1/conversation/surface-actions?call=call-1`, { headers })).json();
      expect(read).toEqual({ actions: [] });
    } finally {
      await server.close();
    }
  });

  it("records an action on another object pressed on a card", async () => {
    const reminder = createItem(db, { kind: "reminder", title: "体检", brief: "", createdBy: "user", remindAt: "2099-10-29T06:00:00.000Z" });
    const server = await start();
    try {
      const headers = { authorization: `Bearer ${await redeem(server.base, ["chat", "tickets:view", "tickets:create"])}`, "content-type": "application/json" };
      const moved = await fetch(`${server.base}/v1/actions/reminder/${reminder}/reschedule`, {
        method: "POST", headers, body: JSON.stringify({ input: { remindAt: "2099-10-30T06:00:00.000Z" }, origin: { callId: "call-2", node: "move" } }),
      });
      expect(moved.status).toBe(200);
      const read = await (await fetch(`${server.base}/v1/conversation/surface-actions?call=call-2`, { headers })).json();
      expect(read.actions).toMatchObject([{ callId: "call-2", node: "move", target: { type: "reminder", id: String(reminder) }, action: "reschedule" }]);
    } finally {
      await server.close();
    }
  });

  it("rejects a bad origin and a read without card ids or without the chat scope", async () => {
    const itemId = createItem(db, { title: "x", brief: "b", createdBy: "lead" });
    const server = await start();
    try {
      const headers = { authorization: `Bearer ${await redeem(server.base, ["chat", "tickets:view", "tickets:create"])}`, "content-type": "application/json" };
      const bad = await fetch(`${server.base}/v1/tickets/${itemId}/actions/set_budget`, {
        method: "POST", headers, body: JSON.stringify({ input: { tokenBudget: 1 }, origin: { callId: "c", node: "../x" } }),
      });
      expect(bad.status).toBe(400);
      expect(getItem(db, itemId)!.token_budget).not.toBe(1);
      expect((await fetch(`${server.base}/v1/conversation/surface-actions`, { headers })).status).toBe(400);
      const viewer = { authorization: `Bearer ${await redeem(server.base, ["tickets:view"])}` };
      expect((await fetch(`${server.base}/v1/conversation/surface-actions?call=c`, { headers: viewer })).status).toBe(403);
    } finally {
      await server.close();
    }
  });
});
