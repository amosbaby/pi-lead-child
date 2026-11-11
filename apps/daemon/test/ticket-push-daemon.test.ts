// 「待你处理」推送在 daemon 里走一遍（计划 Task 12，engine 的 worker-queue/pushes.ts）：
//   用户先在自己的 Slack 私信里和 Lead 说过话（daemon 记下这条私信）→ Lead 判断一张单要用户处理 → daemon 下一拍把它推到那条私信
//   （署名的色条，和私信里的回复同一条路），再弹一条桌面通知 → 用户取消了这张单 → 改写同一条消息，不另发 →
//   daemon 重启 → 不重发、不重改。
// daemon、网关、store、通道 hub、Slack 来源插件都是真的；Slack 和 Lead 的会话是替身。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { FakeSlack } from "@pi-lead-child/engine/testing";
import { createItem, openDb, setHandling, transition, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead } from "./fake-pi-session.js";

// 不用本机 socket（plc.sock）：改成听 127.0.0.1 的随机端口，沙箱里不让建 unix socket（和 owner-dm-mirror-daemon.test.ts 一样）。
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

beforeEach(() => {
  dir = tempDir("plc-ticket-push-daemon-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

type OwnerReplyBar = { fallback: string };
const fallbackOf = (message: { text: string; attachments?: unknown[] }) =>
  (message.attachments as OwnerReplyBar[] | undefined)?.[0]?.fallback ?? message.text;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("pushing a ticket that needs you to your own Slack DM, in the daemon", () => {
  it("posts once, rewrites the same message when the ticket is cancelled, and does not post again after a restart", async () => {
    const slack = new FakeSlack();
    const lead = fakePiLead(async () => ({ say: "你好。" }));
    const desktop: string[] = [];
    const start = () => startDaemon({
      dataDir: dir, dbPath, log: () => {}, notifyDesktop: (body) => desktop.push(body), triageShadow: false,
      sessionFactory: lead.factory as never,
      channels: {
        sources: { slack: { api: slack.api } },
        credentials: { credential: async (provider) => (provider === "slack" ? slack.credential : null) },
      },
    });
    daemon = await start();

    // 用户在自己的私信里和 Lead 说过话：daemon 记下这条私信。
    await daemon.channels!.receive("slack", slack.selfReply("D0SELF", "你好"));
    await vi.waitFor(() => expect(slack.sent("D0SELF")).toHaveLength(1), { timeout: 10_000 });

    const itemId = createItem(db, { title: "rotate the staging key", brief: "the key expires on Friday", createdBy: "lead" });
    setHandling(db, itemId, { handling: "needs_user", reason: "要你在控制台里点确认" });
    await vi.waitFor(() => expect(slack.sent("D0SELF")).toHaveLength(2), { timeout: 10_000 });
    const pushed = slack.sent("D0SELF")[1]!;
    expect(fallbackOf(pushed)).toContain(`#${itemId} rotate the staging key`);
    expect(fallbackOf(pushed)).toContain("要你在控制台里点确认");
    await vi.waitFor(() => expect(desktop).toEqual([expect.stringContaining(`#${itemId}`)]), { timeout: 10_000 });

    // 用户取消了：改写同一条消息，不另发，桌面通知不再弹。
    transition(db, { itemId, to: "cancelled", actor: "user", reason: "不做了" });
    await vi.waitFor(() => expect(slack.sent("D0SELF")[1]!.edits ?? 0).toBe(1), { timeout: 10_000 });
    expect(slack.sent("D0SELF")).toHaveLength(2);
    expect(fallbackOf(slack.sent("D0SELF")[1]!)).toContain(`#${itemId}`);
    expect(fallbackOf(slack.sent("D0SELF")[1]!)).not.toContain("要你在控制台里点确认");
    expect(desktop).toHaveLength(1);

    // 重启：不重发，也不重改。
    await daemon.close();
    daemon = await start();
    await pause(300);
    expect(slack.sent("D0SELF")).toHaveLength(2);
    expect(slack.sent("D0SELF")[1]!.edits).toBe(1);
    expect(desktop).toHaveLength(1);
  }, 30_000);
});
