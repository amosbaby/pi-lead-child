// 「我不在看 App 时，把 Lead 的消息同步到我的 Slack 私信」在 daemon 里走一遍（工单 #88，用户 2026-11-06）：
//   用户先在自己的 Slack 私信里和 Lead 说过话（daemon 记下这条私信）→ 开关关着时，App 里问的回复只在 App 里 →
//   用户在设置页打开开关（POST /v1/actions/owner_dm_sync/user/enable）→ 没有人在看 App 时，App 里问的回复也发到那条私信，
//   格式和私信里的回复一样（署名、mrkdwn）→ 这一轮推过 notify_user 的不再发 → 有人在看 App 时不发。
// daemon、网关、store、通道 hub、Slack 来源插件都是真的；Slack 和 Lead 的会话是替身。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { tempDir } from "@pi-lead-child/core/testing";
import { FakeSlack } from "@pi-lead-child/engine/testing";
import { createPairing, getOwnerDmSync, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-owner-dm-mirror-daemon-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

const turnState = (id: string) => (db.prepare("SELECT state FROM channel_turns WHERE id = ?").get(id) as { state: string } | undefined)?.state;

describe("syncing Lead's messages to the user's Slack DM while the user is away from the App", () => {
  it("sends App replies to the DM only when the switch is on and nobody is looking at the App", async () => {
    const slack = new FakeSlack();
    const lead = fakePiLead(async (call) => {
      const input = call.inputs.join("\n");
      if (input.includes("要推通知")) return { tools: ["notify_user"] };
      const asked = /问题([A-Z])/u.exec(input)?.[1];
      return { say: asked ? `回答${asked}` : "你好。" };
    });
    daemon = await startDaemon({
      dataDir: dir, dbPath, log: () => {}, notifyDesktop: () => {}, triageShadow: false,
      sessionFactory: lead.factory as never,
      channels: {
        sources: { slack: { api: slack.api } },
        credentials: { credential: async (provider) => (provider === "slack" ? slack.credential : null) },
      },
    });
    const base = `http://127.0.0.1:${daemon.pairedPort}`;
    const { accessToken } = redeemPairing(db, createPairing(db, { name: "手机", kind: "companion", scopes: ["chat", "tickets:view", "tickets:create"] }).code);
    const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
    const ask = async (message: string) => {
      const response = await fetch(`${base}/v1/chat/send`, { method: "POST", headers, body: JSON.stringify({ id: message, message }) });
      const body = await response.json() as { turnId: string };
      await vi.waitFor(() => expect(turnState(body.turnId)).toBe("completed"), { timeout: 10_000 });
    };

    // 用户在自己的私信里和 Lead 说过话：daemon 记下这条私信。
    await daemon.channels!.receive("slack", slack.selfReply("D0SELF", "你好"));
    await vi.waitFor(() => expect(slack.sent("D0SELF")).toHaveLength(1), { timeout: 10_000 });

    // 开关关着（缺省）：App 里问的回复不发到私信。
    expect(getOwnerDmSync(db).enabled).toBe(false);
    await ask("问题A");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(slack.sent("D0SELF")).toHaveLength(1);

    // 设置页打开开关。没有人在看 App：回复也发到私信，署名和私信里的回复一样。
    const enabled = await fetch(`${base}/v1/actions/owner_dm_sync/user/enable`, { method: "POST", headers, body: JSON.stringify({ input: {} }) });
    expect(enabled.status).toBe(200);
    expect(getOwnerDmSync(db)).toMatchObject({ enabled: true, updatedBy: "user" });
    await ask("问题B");
    await vi.waitFor(() => expect(slack.sent("D0SELF")).toHaveLength(2), { timeout: 10_000 });
    expect(slack.sent("D0SELF")[1]!.text).toMatch(/^.+ \(Assistant\)\n回答B$/u);

    // 这一轮用 notify_user 推过即时通知：不再发一遍。
    await ask("要推通知");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(slack.sent("D0SELF")).toHaveLength(2);

    // 用户正在看 App：不发。
    const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${accessToken}&protocol=2`);
    sockets.push(socket);
    const events: any[] = [];
    socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
    await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
    socket.send(JSON.stringify({ type: "presence.set", id: "presence", protocolVersion: 2, attended: true }));
    await vi.waitFor(() => expect(events.some((event) => event.type === "command.result" && event.id === "presence")).toBe(true));
    await ask("问题C");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(slack.sent("D0SELF")).toHaveLength(2);
  }, 40_000);
});
