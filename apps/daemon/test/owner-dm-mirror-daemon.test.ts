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
import { createItem, createPairing, getDecisionRequest, getOwnerDmSync, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { createCoordinator } from "@pi-lead-child/engine";
import { startDaemon } from "../src/server.js";
import { fakePiLead } from "./fake-pi-session.js";

// 这个文件不用本机 socket（plc.sock）：改成听 127.0.0.1 的随机端口，沙箱里不让建 unix socket（listen EPERM），
// 这样执行者和核查员在沙箱里也能跑它（#101 返工）。别的都是真的。
vi.mock("@pi-lead-child/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pi-lead-child/runtime")>();
  return {
    ...actual,
    listenOwnerOnly: (server: Parameters<typeof actual.listenOnce>[0], _path: string, onLateError?: (error: Error) => void) =>
      actual.listenOnce(server, { port: 0, host: "127.0.0.1" }, onLateError ?? (() => {})),
  };
});

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

// 用户自己私信里的回复（#70）：顶层 text 是空的，署名和正文在色条（attachments[0]）里；fallback 是通知里显示的那一份，「署名\n正文」。
type OwnerReplyBar = { color: string; fallback: string };
const barOf = (message: { text: string; attachments?: unknown[] }) => (message.attachments as OwnerReplyBar[] | undefined)?.[0];

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
    // 和私信里的回复一样：顶层 text 是空的，署名和正文在色条里，色条和上一条换了颜色（#86）。
    const [first, mirrored] = slack.sent("D0SELF");
    expect(mirrored!.text).toBe("");
    expect(barOf(mirrored!)?.fallback).toMatch(/^.+ \(Assistant\)\n回答B$/u);
    expect(barOf(mirrored!)?.color).toBeTruthy();
    expect(barOf(mirrored!)?.color).not.toBe(barOf(first!)?.color);

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
  // 工单 #101 的时间线（人、时间、文字都是编的）：Lead 在 App 那一轮里画了 ChoiceGroup，用户那时在看 App；他没回答就离开了 App。
  // 同步到 Slack 私信开着：那张卡补推到他的私信一次，带按钮。在 App 里答了以后，私信里的那条改成结果、按钮收起。
  // 另一张卡他一直在 App 里看着并且答了：不推。
  // 用户答了以后系统叫醒 Lead 去处理这个回答。这里 Lead 回 NO_REPLY（不用再告诉用户什么）：Lead 在用户不在时写给他的话，
  // 按 #88 同步到私信，那是另一件事（上一条测试）。以前这里 Lead 每轮都回「你好。」，第二张卡答完后叫醒的那一轮
  // 刚好在用户离开以后结束，回复就被同步过去，看起来像多推了一条（#101 第二次返工）。
  it("pushes Lead's unanswered card to the DM once after the user leaves the App, and folds it after an answer", async () => {
    const slack = new FakeSlack();
    let wakes = 0;
    const lead = fakePiLead(async (call) => {
      if (!call.inputs.join("\n").includes('kind="blocker"')) return { say: "你好。" };
      wakes += 1;
      return { say: "NO_REPLY" };
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
    await daemon.channels!.receive("slack", slack.selfReply("D0SELF", "你好"));
    await vi.waitFor(() => expect(slack.sent("D0SELF")).toHaveLength(1), { timeout: 10_000 });
    const enabled = await fetch(`${base}/v1/actions/owner_dm_sync/user/enable`, { method: "POST", headers, body: JSON.stringify({ input: {} }) });
    expect(enabled.status).toBe(200);

    // 用户在看 App。
    const socket = new WebSocket(`ws://127.0.0.1:${daemon.pairedPort}/v1/paired/events?token=${accessToken}&protocol=2`);
    sockets.push(socket);
    const events: any[] = [];
    socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
    await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
    const setAttended = async (attended: boolean, id: string) => {
      socket.send(JSON.stringify({ type: "presence.set", id, protocolVersion: 2, attended }));
      await vi.waitFor(() => expect(events.some((event) => event.type === "command.result" && event.id === id)).toBe(true));
    };
    await setAttended(true, "here");

    // Lead 在 App 那一轮里画的卡（render_ui 的 ChoiceGroup 建的决定请求：origin lead、受众 user）。
    const coordinator = createCoordinator({ db });
    const ticket = createItem(db, { title: "发布清单", brief: "b", createdBy: "lead" });
    const card = (prompt: string) => coordinator.requestDecision({
      itemId: ticket, runId: null, origin: "lead", kind: "decision", audience: "user", prompt,
      options: [{ id: "tue", label: "周二" }, { id: "thu", label: "周四" }], checkpoint: { title: "要你决定", summary: prompt },
    }).requestId;
    // 推到私信的决定卡（幂等键以 owner-choice: 开头），和别的消息（私信里的回复、#88 同步的话）分开数。
    const cards = () => slack.sent("D0SELF").filter((message) => String(message.metadata?.event_payload.idempotency_key ?? "").startsWith("owner-choice:"));
    const decision = card("发布窗口选哪天？");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(slack.sent("D0SELF")).toHaveLength(1);

    // 没回答就离开了 App：补推一次，带两个选项按钮。
    await setAttended(false, "away");
    await vi.waitFor(() => expect(slack.sent("D0SELF")).toHaveLength(2), { timeout: 10_000 });
    const pushed = slack.sent("D0SELF")[1]!;
    expect(JSON.stringify(pushed.blocks)).toContain("发布窗口选哪天？");
    expect(JSON.stringify(pushed.blocks)).toContain(`decision:${decision}#1`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(slack.sent("D0SELF")).toHaveLength(2);

    // 他回到 App 里选了周四：私信里那条改成结果，按钮收起。
    await setAttended(true, "back");
    coordinator.resolveDecision({ requestId: decision, decision: "select", optionId: "thu", actor: { kind: "user", resolvedBy: "user via page" } });
    // 改写在下一拍（sync）才到：等按钮没了再看。不能等「周四」出现：它是选项名，没改写的消息里本来就有（#101 返工）。
    await vi.waitFor(() => expect(JSON.stringify(slack.sent("D0SELF")[1]!.blocks)).not.toContain("plc_owner_choose"), { timeout: 10_000 });
    // 是同一条消息改了一次，写着他选了哪个（daemon 缺省英文），不是删掉或另发。
    expect(slack.sent("D0SELF")).toHaveLength(2);
    expect(slack.sent("D0SELF")[1]!.edits).toBe(1);
    expect(JSON.stringify(slack.sent("D0SELF")[1]!.blocks)).toMatch(/Chose \\"周四\\"|选了「周四」/u);

    // 一直在看 App 并且答了的卡：离开以后也不推。
    const answered = card("回滚脚本谁来写？");
    await new Promise((resolve) => setTimeout(resolve, 200));
    coordinator.resolveDecision({ requestId: answered, decision: "select", optionId: "tue", actor: { kind: "user", resolvedBy: "user via page" } });
    expect(getDecisionRequest(db, answered)!.state).toBe("resolved");
    await setAttended(false, "away-again");
    // 等系统为两次回答各叫醒 Lead 一次，再多等几拍让那两轮结束。
    await vi.waitFor(() => expect(wakes).toBe(2), { timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // 决定卡还是只有那一条，改过 1 次；答过的卡不推，第一张也不再推。
    expect(cards()).toHaveLength(1);
    expect(cards()[0]!.edits).toBe(1);
    expect(JSON.stringify(cards()[0]!.blocks)).not.toContain("回滚脚本谁来写？");
    expect(slack.sent("D0SELF")).toHaveLength(2);

    // 再回来、再离开：也不再推。
    await setAttended(true, "back-again");
    await setAttended(false, "away-third");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(cards()).toHaveLength(1);
    expect(slack.sent("D0SELF")).toHaveLength(2);
  }, 40_000);
});
