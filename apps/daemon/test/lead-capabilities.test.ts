// Lead 能用的工具和操作，daemon 每次起来时和上一次记下的比（2026-11-02）：15:46 的部署加了改 Slack 消息的操作，
// 15:58 Lead 还在笔记里写「没有编辑消息的权限」，之后照这条拒绝用户。变了的，下一轮告诉它一次。
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@pi-lead-child/core/testing";
import { UI_ACTIONS } from "@pi-lead-child/engine";
import { createPairing, openDb, redeemPairing } from "@pi-lead-child/store";
import { LEAD_CAPABILITIES_KEY, leadCapabilityNotice, recordLeadCapabilities } from "../src/lead-capabilities.js";
import { startDaemon } from "../src/server.js";
import { fakePiLead } from "./fake-pi-session.js";

let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
});

describe("Lead's capabilities across restarts", () => {
  it("says nothing the first time, then names what a deploy added and removed", () => {
    const db = openDb(join(tempDir("plc-lead-capabilities-"), "plc.db"));
    const before = ["send_channel_message", "channel_conversation.send_message", "channel_conversation.react"];
    expect(recordLeadCapabilities(db, before)).toBeNull();
    expect(recordLeadCapabilities(db, [...before].reverse())).toBeNull();

    const change = recordLeadCapabilities(db, ["send_channel_message", "channel_conversation.send_message", "channel_conversation.edit_message"]);
    expect(change).toEqual({ added: ["channel_conversation.edit_message"], removed: ["channel_conversation.react"] });
    const notice = leadCapabilityNotice(change!);
    expect(notice).toContain("新增：channel_conversation.edit_message");
    expect(notice).toContain("去掉：channel_conversation.react");
    expect(notice).toContain("先调用");
    expect(notice).toContain("update_note");
    // 记下了这一次的：再起来一次，没有变化。
    expect(recordLeadCapabilities(db, ["channel_conversation.edit_message", "channel_conversation.send_message", "send_channel_message"])).toBeNull();
    db.close();
  });

  it("keeps a long list short", () => {
    const notice = leadCapabilityNotice({ added: Array.from({ length: 50 }, (_, index) => `tool_${index}`), removed: [] });
    expect(notice).toContain("tool_0");
    expect(notice).toContain("另有 20 个");
  });
});

// 走完整的路径：上一次起来时记下的清单里没有改消息的操作，这一次的 daemon 有。用户的下一轮里 Lead 收到一次通知，再下一轮没有。
describe("the daemon after a deploy", () => {
  it("tells Lead once, in its next turn, which operations the deploy added", async () => {
    const dir = tempDir("plc-lead-capabilities-daemon-");
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    const actions = Object.entries(UI_ACTIONS).flatMap(([target, defined]) => Object.keys(defined).map((id) => `${target}.${id}`));
    const old = [...actions.filter((name) => name !== "channel_conversation.edit_message"), "old_target.gone"];
    db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)").run(LEAD_CAPABILITIES_KEY, JSON.stringify(old), "2026-11-02T07:00:00.000Z");
    const lead = fakePiLead(() => ({ say: "收到。" }));
    daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: () => {}, notifyDesktop: () => {} });
    const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat"] }).code);
    const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2`);
    sockets.push(socket);
    const events: any[] = [];
    socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
    await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
    const send = async (id: string, message: string) => {
      socket.send(JSON.stringify({ type: "chat.send", id, protocolVersion: 2, message }));
      await vi.waitFor(() => expect(lead.calls.some((call) => call.inputs.some((input) => input.includes(message)))).toBe(true), { timeout: 5_000 });
    };
    await send("cmd-1", "帮我改一下刚才那条消息");
    await send("cmd-2", "再问一句");
    const inputOf = (text: string) => lead.calls.find((call) => call.inputs.some((input) => input.includes(text)))!.inputs.join("\n");
    expect(inputOf("帮我改一下刚才那条消息")).toContain("新增：channel_conversation.edit_message");
    expect(inputOf("帮我改一下刚才那条消息")).toContain("去掉：old_target.gone");
    expect(inputOf("再问一句")).not.toContain("系统更新了");
    db.close();
  });
});
