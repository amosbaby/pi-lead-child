// 浏览器会话方式（2026-11-02，.scratch/slack-session 工单 01、02）：gabriel-slack 只经过 slack-gabriel.ts 用；
// 带 cookie 的 WebSocket 只连 Slack 的主机；假的 Slack 的网页版协议只认对的 cookie 和会话令牌。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGabrielCore, gabrielErrorOf, slackSocketUrlAllowed } from "../src/channels/sources/slack-gabriel.js";
import {
  FAKE_SLACK_SESSION_COOKIE, FAKE_SLACK_SESSION_TOKEN, FAKE_SLACK_WORKSPACE_URL, FakeSlack,
} from "../testing/index.js";

const SRC = join(import.meta.dirname, "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("the gabriel-slack wrapper", () => {
  it("is the only file that imports gabriel-slack", () => {
    const importers = sourceFiles(SRC)
      .filter((path) => /from "gabriel-slack"|import\("gabriel-slack"\)/.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(SRC.length + 1));
    expect(importers).toEqual(["channels/sources/slack-gabriel.ts"]);
  });

  it("sends the session cookie over a WebSocket only to Slack's hosts", () => {
    expect(slackSocketUrlAllowed("wss://wss-primary.slack.com/?token=x")).toBe(true);
    expect(slackSocketUrlAllowed("wss://wss-backup.slack-edge.com/link")).toBe(true);
    expect(slackSocketUrlAllowed("ws://wss-primary.slack.com/")).toBe(false);
    expect(slackSocketUrlAllowed("wss://example.com/slack.com")).toBe(false);
    expect(slackSocketUrlAllowed("wss://slack.com.example.com/")).toBe(false);
    expect(slackSocketUrlAllowed("wss://user:pass@wss-primary.slack.com/")).toBe(false);
    expect(slackSocketUrlAllowed("not a url")).toBe(false);
  });

  it("logs without the cookie or the session token", async () => {
    const slack = new FakeSlack();
    const logs: string[] = [];
    const core = await createGabrielCore({
      cookie: FAKE_SLACK_SESSION_COOKIE,
      network: { fetch: slack.sessionFetch, createWebSocket: slack.createSessionSocket },
      log: (line) => logs.push(line),
    });
    await core.initialize();
    // gabriel 记一条警告时，里面带着 cookie 和令牌：我们的 logger 把它们去掉。
    (core as unknown as { logger: { warn(obj: Record<string, unknown>, msg?: string): void } }).logger
      .warn({ detail: `d=${FAKE_SLACK_SESSION_COOKIE} token=${FAKE_SLACK_SESSION_TOKEN}` }, "test");
    const text = logs.join("\n");
    expect(text).toContain("session warn: test");
    expect(text).not.toContain(FAKE_SLACK_SESSION_COOKIE);
    expect(text).not.toContain(FAKE_SLACK_SESSION_TOKEN);
  });
});

describe("the fake Slack speaks the web client protocol", () => {
  const network = (slack: FakeSlack) => ({ fetch: slack.sessionFetch, createWebSocket: slack.createSessionSocket });

  it("exchanges the right cookie for the user, the workspace and a session token", async () => {
    const slack = new FakeSlack();
    const core = await createGabrielCore({ cookie: FAKE_SLACK_SESSION_COOKIE, network: network(slack), log: () => {} });
    const session = await core.initialize();
    expect(session).toMatchObject({ userId: slack.self.id, teamId: slack.teamId, apiBase: FAKE_SLACK_WORKSPACE_URL });
    expect(await core.callWebApi("users.info", { user: "U0ZHANG" })).toMatchObject({ ok: true, user: { name: "张三" } });
    expect(slack.sessionCalls).toEqual(["users.info"]);
  });

  it("refuses a wrong cookie", async () => {
    const slack = new FakeSlack();
    const core = await createGabrielCore({ cookie: "xoxd-not-the-session-cookie", network: network(slack), log: () => {} });
    const error = await core.initialize().then(() => null, (reason: unknown) => reason);
    expect(gabrielErrorOf(error).code).toBe("AUTH_DEAD");
  });

  it("refuses a wrong session token, even with the right cookie", async () => {
    const slack = new FakeSlack();
    const form = new FormData();
    form.set("token", "xoxc-not-the-session-token");
    const response = await slack.sessionFetch(new URL("api/auth.test", FAKE_SLACK_WORKSPACE_URL), {
      method: "POST", headers: { Cookie: `d=${FAKE_SLACK_SESSION_COOKIE}` }, body: form,
    });
    expect(await response.json()).toEqual({ ok: false, error: "invalid_auth" });
    expect(slack.sessionCalls).toEqual([]);
  });

  it("opens the WebSocket only with the right token and cookie, says hello and answers pings", async () => {
    const slack = new FakeSlack();
    const core = await createGabrielCore({ cookie: FAKE_SLACK_SESSION_COOKIE, network: network(slack), log: () => {} });
    const hello = new Promise<void>((resolve) => core.onHello(() => resolve()));
    await core.connect();
    await hello;
    const pong = await core.sendWsCommand({ type: "ping" });
    expect(pong).toMatchObject({ type: "pong" });
    expect(slack.sessionSocket()!.headers.Cookie).toBe(`d=${FAKE_SLACK_SESSION_COOKIE}`);
    core.disconnect();
  });
});
