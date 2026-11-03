// 工单 11（spec D14）：每个通道适配器用自己的假服务跑同一组合约用例（testing/channels/contract.ts）。
// 新增一个来源时，在 FAKES 里加上它的 ChannelContractFake。内置的来源没有 fake 时，这个文件直接失败。
// hook 是只在测试里有的第二个适配器（通用的签名 webhook），证明合约用例可以直接复用。
// slack-web-client 是同一个 Slack 插件，但 Web API 走真实的 WebClient（Slack 官方 SDK，slack-takeover 工单 02），
// 底下是假的 Slack 的 fetch：出站的幂等、崩溃后的重试、凭据不外泄，经过 SDK 也成立。
import { describe, expect, it } from "vitest";
import { SLACK_SESSION_COOKIE_ENV } from "@pi-lead-child/core";
import {
  BUILTIN_CHANNEL_SOURCES, createSlackChannelAdapter, createSlackWebApi, type ChannelCredential, type SlackWebApi,
} from "../src/index.js";
import {
  createFakeHookAdapter, describeChannelAdapterContract, FAKE_SLACK_SESSION_COOKIE, FakeHookService, FakeSlack, type ChannelContractFake,
} from "../testing/index.js";

const slackWith = (api: (fake: FakeSlack) => SlackWebApi): ChannelContractFake => ({
  setup() {
    const fake = new FakeSlack();
    const channel = (thread: string) => `D0${thread.toUpperCase()}`;
    return {
      adapter: createSlackChannelAdapter({ api: api(fake) }),
      credential: fake.credential,
      message: (thread, text) => fake.dm("U0ZHANG", text, { channel: channel(thread) }),
      selfReply: (thread, text) => fake.selfReply(channel(thread), text),
      redeliver: (delivery) => fake.redeliver(delivery),
      forge: (delivery) => fake.forge(delivery),
      objectKey: (thread) => `slack:${channel(thread)}:main`,
      liveReplies: (thread) => fake.sent(channel(thread)).map((message) => message.text),
      crashAfterNextReply: () => fake.crashAfterNextPost(),
      failNextReplyEchoingCredential: () => fake.failNextPostEchoingCredential(),
    };
  },
});

const slack = slackWith((fake) => fake.api);
const slackWebClient = slackWith((fake) => createSlackWebApi({ fetch: fake.fetch, retry: { retries: 0 } }));

// 浏览器会话方式（2026-11-02）：同一个 Slack 插件，Web API 经过 gabriel-slack 的网页版协议，底下是假的 Slack 的 sessionFetch。
// 凭据是用会话 cookie 换出来的（prepare）。签名密钥只给推来的 HTTP 投递用：生产里会话方式只有进程内的传输，没有它。
const slackSession: ChannelContractFake = {
  setup() {
    const fake = new FakeSlack();
    const channel = (thread: string) => `D0${thread.toUpperCase()}`;
    const adapter = createSlackChannelAdapter({
      api: fake.api, connection: "session", sessionWrites: () => true,
      session: { network: { fetch: fake.sessionFetch, createWebSocket: fake.createSessionSocket, maxHttpRetries: 0 } },
    });
    const credential: ChannelCredential = { ...fake.sessionCredential, signingSecret: fake.credential.signingSecret! };
    return {
      adapter,
      credential,
      async prepare() {
        const resolved = await adapter.resolveCredential!({ [SLACK_SESSION_COOKIE_ENV]: FAKE_SLACK_SESSION_COOKIE }, () => {});
        if (!resolved) throw new Error("the session credential did not resolve");
        Object.assign(credential, resolved);
      },
      message: (thread, text) => fake.dm("U0ZHANG", text, { channel: channel(thread) }),
      selfReply: (thread, text) => fake.selfReply(channel(thread), text),
      redeliver: (delivery) => fake.redeliver(delivery),
      forge: (delivery) => fake.forge(delivery),
      objectKey: (thread) => `slack:${channel(thread)}:main`,
      liveReplies: (thread) => fake.sent(channel(thread)).map((message) => message.text),
      crashAfterNextReply: () => fake.crashAfterNextPost(),
      failNextReplyEchoingCredential: () => fake.failNextPostEchoingSession(),
    };
  },
};

const hook: ChannelContractFake = {
  setup() {
    const service = new FakeHookService();
    return {
      adapter: createFakeHookAdapter(service),
      credential: service.credential,
      message: (thread, text) => service.message(thread, text),
      selfReply: (thread, text) => service.selfReply(thread, text),
      redeliver: (delivery) => service.redeliver(delivery),
      forge: (delivery) => service.forge(delivery),
      objectKey: (thread) => `hook:${thread}`,
      liveReplies: (thread) => service.live(thread).map((reply) => reply.text),
      crashAfterNextReply: () => service.crashAfterNextReply(),
      failNextReplyEchoingCredential: () => service.failNextReplyEchoingCredential(),
    };
  },
};

const FAKES: Record<string, ChannelContractFake> = { slack, "slack-web-client": slackWebClient, "slack-session": slackSession, hook };

describe("channel adapter contract coverage", () => {
  it("has a contract fake for every built-in channel source", () => {
    expect(Object.keys(FAKES)).toEqual(expect.arrayContaining([...BUILTIN_CHANNEL_SOURCES]));
  });
});

for (const [name, fake] of Object.entries(FAKES)) describeChannelAdapterContract(name, fake);
