// 用户自己 Slack 私信里的确认消息，端到端（工单 #72）：真实的 hub、Slack 适配器、SQLite、改规则的确认卡（操作层的 rule_change.resolve），
// 和一个内存里的连接中心（写入确认）。Slack 是假的。验证：
//   - 消息上写的和 App 卡上一样（标题、原因、参数；run_on_host 的命令整条）；
//   - 用户本人在 Slack 里点「确认这一次」：执行存下的那一次，账本记在 Slack 私信的凭证名下，App 读到的卡状态跟着变；
//   - 点「不改」：作废，什么都不执行；
//   - 别人点：不执行，记一条被拒的事件；
//   - 再点一次、点过期的：不再执行，消息只显示状态。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  CHANNEL_EVENT_KINDS, CHANNEL_POLICY_DEFAULTS, OWNER_ACTION_PERFORMED_KIND, UI_ACTION_PERFORMED_KIND,
  type ConnectionConfirmationDto,
} from "@pi-lead-child/protocol";
import {
  channelOwnerBinding, channelPolicy, createItem, getLeadProfile, leadProfileFields, listActivities, listEvents, openDb, writeLeadProfile,
  type Binding, type Db,
} from "@pi-lead-child/store";
import {
  ChannelHub, ChannelRegistry, createSlackChannelAdapter, getRuleChangeConfirmation, requestRuleChangeConfirmation, runUiAction,
  SLACK_CONFIRM_ACTION, SLACK_DECLINE_ACTION, updateDesignPreferences,
} from "@pi-lead-child/engine";
import { FakeSlack } from "@pi-lead-child/engine/testing";
import {
  ownerConfirmationContent, resolveOwnerConfirmation, type OwnerConfirmationDeps,
} from "../src/owner-confirmations.js";

const SELF_DM = "D0SELF";
const CONVERSATION = `slack:${SELF_DM}:main`;

let db: Db;
let slack: FakeSlack;
let clock: Date;
let binding: Binding;
let connections: FakeConnections;
let deps: OwnerConfirmationDeps;
let hub: ChannelHub;

// 连接中心的写入确认：和 ConnectionHub 一样，只执行存下的那一次，处理过的原样返回，过期的不再执行。
class FakeConnections {
  readonly calls: string[] = [];
  private readonly writes = new Map<string, ConnectionConfirmationDto>();

  add(id: string, expiresAt: Date): void {
    this.writes.set(id, {
      id, key: "github", label: "GitHub", tool: "create_issue", summary: "在 acme/x 开一个 issue「发布清单」",
      argumentsPreview: JSON.stringify({ repo: "acme/x", title: "发布清单" }), state: "pending",
      createdAt: clock.toISOString(), expiresAt: expiresAt.toISOString(), resolvedBy: null, resultPreview: null,
    });
  }

  confirmation(id: string): ConnectionConfirmationDto {
    const write = this.writes.get(id);
    if (!write) throw Object.assign(new Error("gone"), { code: "not_found" });
    if (write.state === "pending" && Date.parse(write.expiresAt) <= clock.getTime()) write.state = "expired";
    return { ...write };
  }

  async resolveConfirmation(id: string, approve: boolean, resolvedBy: string): Promise<ConnectionConfirmationDto> {
    const write = this.writes.get(id)!;
    this.confirmation(id);
    if (write.state !== "pending") return { ...write };
    write.resolvedBy = resolvedBy;
    if (!approve) {
      write.state = "rejected";
      return { ...write };
    }
    this.calls.push(id);
    write.state = "done";
    write.resultPreview = "issue #12 已创建";
    return { ...write };
  }
}

beforeEach(() => {
  db = openDb(join(tempDir("plc-owner-confirm-"), "plc.db"));
  clock = new Date("2026-11-05T10:00:00.000Z");
  slack = new FakeSlack({ now: () => clock });
  // 用户选了中文，Lead 叫 Red Bull：消息上的字按这两个设置写。
  updateDesignPreferences(db, { request: { locale: "zh" }, caller: { kind: "user" } });
  writeLeadProfile(db, { ...leadProfileFields(getLeadProfile(db)), name: "Red Bull" }, { by: "user", at: clock });
  binding = channelOwnerBinding(db, { subject: `slack:${slack.self.id}`, name: "Slack 私信（你自己）" })!;
  connections = new FakeConnections();
  deps = { db, uiActions: { db, services: {}, log: () => {} }, connections, log: () => {} };
  const adapter = createSlackChannelAdapter({ api: slack.api, now: () => clock });
  hub = new ChannelHub({
    db, registry: new ChannelRegistry([adapter]), now: () => clock, log: () => {}, assistantName: () => "Red Bull",
    credentials: { credential: async () => ({ ...slack.credential, team: { id: "T0HOME", name: "Acme" } }) },
    // daemon 的接法（server.ts 的 resolveChannelOwnerConfirmation）：凭证是这个账号的私信凭证。
    ownerConfirm: async (click) => resolveOwnerConfirmation(deps, {
      target: click.target, decision: click.decision, via: click.source,
      binding: channelOwnerBinding(db, { subject: `${click.source}:${click.account}`, name: "Slack 私信（你自己）" })!,
    }),
  });
});

afterEach(() => {
  db.close();
});

// 外部的一轮里收紧自动代你处理被拦下：系统存下这一个操作，给出确认卡（rule-change-confirm.test.ts 的同一个场景）。
async function refusedTighten(): Promise<string> {
  const refused = await runUiAction(db, {
    target: { type: "channel_policy", id: "slack" }, action: "tighten", input: { ...CHANNEL_POLICY_DEFAULTS, autoReply: false },
    reason: "定时器的安排：先别自动回复",
    caller: { kind: "lead", turnId: null, externalContent: [{ via: "tool", tool: "read_channel_conversation" }] },
  }).catch((error: any) => error);
  return refused.refusal.userAction.target as string;
}

async function post(target: string): Promise<void> {
  const content = ownerConfirmationContent(deps, target)!;
  await hub.sendOwnerConfirmation(CONVERSATION, content, `${CONVERSATION}:${target}`);
}

const message = () => slack.messages.filter((item) => item.channel === SELF_DM).at(-1)!;
const blocksText = () => JSON.stringify(message().blocks);
const buttons = () => (message().blocks ?? []).filter((block) => block.type === "actions");
const executed = (id: string) => listEvents(db, { kind: "rule_change.executed", entityKey: `rule_change:${id}` });
const clicks = () => listEvents(db, { kind: CHANNEL_EVENT_KINDS.ownerConfirmClicked, limit: 100 }).map((event) => event.payload as any);

describe("a rule change confirmed in the user's own Slack DM", () => {
  it("runs the stored operation once, on the Slack DM's credential, and the App card reads the new state", async () => {
    const target = await refusedTighten();
    const id = target.split(":")[1]!;
    await post(target);
    expect(blocksText()).toContain("Red Bull 要收紧自动代你处理");
    expect(blocksText()).toContain("定时器的安排：先别自动回复");
    expect(blocksText()).toContain("autoReply = false");
    expect(buttons()).toHaveLength(1);
    expect(channelPolicy(db, "slack")!.params.autoReply).not.toBe(false);

    await hub.receiveFromTransport("slack", slack.click(message(), SLACK_CONFIRM_ACTION));

    expect(channelPolicy(db, "slack")!.params.autoReply).toBe(false);
    // App 的卡读同一个地方：状态已经变了。
    expect(getRuleChangeConfirmation(db, id)).toMatchObject({ state: "done", resolvedBy: expect.stringContaining("Slack 私信（你自己）") });
    // 账本：确认记在 Slack 私信的凭证名下；执行记成 Lead 凭这张卡代用户做。
    expect(listEvents(db, { kind: "rule_change.resolved", entityKey: target }).map((event) => event.payload))
      .toEqual([expect.objectContaining({ decision: "confirm", bindingId: binding.id, resolvedBy: expect.stringContaining("Slack 私信") })]);
    expect(listEvents(db, { kind: UI_ACTION_PERFORMED_KIND, limit: 100 }).map((event) => event.payload as any))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ target: { type: "rule_change", id }, action: "resolve", actor: "user", bindingId: binding.id }),
        expect.objectContaining({ action: "tighten", actor: "lead", onBehalfOf: "user", bindingId: binding.id }),
      ]));
    expect(clicks()).toEqual([expect.objectContaining({ channel: "slack", target, decision: "confirm", accepted: true, state: "已执行" })]);
    // 消息换成结果，不再带按钮。
    expect(buttons()).toHaveLength(0);
    expect(blocksText()).toContain("已执行");

    // 再点一次（旧客户端还显示着按钮）：不再执行。
    await hub.receiveFromTransport("slack", slack.click({ ...message(), blocks: [] }, SLACK_CONFIRM_ACTION));
    expect(executed(id)).toHaveLength(1);
  });

  it("does nothing but void the card on 不改", async () => {
    const target = await refusedTighten();
    const id = target.split(":")[1]!;
    await post(target);
    await hub.receiveFromTransport("slack", slack.click(message(), SLACK_DECLINE_ACTION));
    expect(getRuleChangeConfirmation(db, id)).toMatchObject({ state: "declined" });
    expect(executed(id)).toHaveLength(0);
    expect(channelPolicy(db, "slack")!.params.autoReply).not.toBe(false);
    expect(blocksText()).toContain("没有改");
    expect(buttons()).toHaveLength(0);
  });

  it("refuses someone else's click and records it", async () => {
    const target = await refusedTighten();
    const id = target.split(":")[1]!;
    await post(target);
    await hub.receiveFromTransport("slack", slack.click(message(), SLACK_CONFIRM_ACTION, { user: "U0MALLORY" }));
    expect(getRuleChangeConfirmation(db, id)).toMatchObject({ state: "pending" });
    expect(executed(id)).toHaveLength(0);
    expect(clicks()).toEqual([expect.objectContaining({ by: "U0MALLORY", accepted: false, refusal: "not_owner" })]);
    expect(buttons()).toHaveLength(1);
  });

  it("does not run an expired confirmation, and shows that it expired", async () => {
    // 25 小时前存下的确认卡（有效期 24 小时）；那时发出去的消息上还带着按钮。
    const { userAction } = requestRuleChangeConfirmation(db, {
      confirm: {
        operation: { kind: "ui_action", target: { type: "channel_policy", id: "slack" }, action: "tighten", input: { ...CHANNEL_POLICY_DEFAULTS, autoReply: false } },
        reason: "定时器的安排：先别自动回复", why: "这一轮读了外部内容", externalContent: [],
      },
      label: "收紧自动代你处理", name: null, where: "设置 → 消息通道", now: new Date(Date.now() - 25 * 60 * 60_000),
    });
    const id = userAction.target.split(":")[1]!;
    const stale = { ...ownerConfirmationContent(deps, userAction.target)!, pending: true };
    await hub.sendOwnerConfirmation(CONVERSATION, stale, "stale");
    expect(buttons()).toHaveLength(1);
    await hub.receiveFromTransport("slack", slack.click(message(), SLACK_CONFIRM_ACTION));
    expect(executed(id)).toHaveLength(0);
    expect(getRuleChangeConfirmation(db, id)).toMatchObject({ state: "expired" });
    expect(channelPolicy(db, "slack")!.params.autoReply).not.toBe(false);
    expect(blocksText()).toContain("已过期");
    expect(buttons()).toHaveLength(0);
  });

  it("shows the whole command of run_on_host on the message", () => {
    const command = "git -C ~/src/acme push origin plc/item-9";
    const { userAction } = requestRuleChangeConfirmation(db, {
      confirm: {
        operation: { kind: "lead_tool", tool: "run_on_host", input: { command, cwd: "/Users/alice/src/acme" } },
        reason: "推送分支要你的 git 凭据", why: "沙箱里没有 git 凭据", externalContent: [],
      },
      label: "在你的 Mac 上跑一条命令", name: null, where: "会话里的确认卡", now: clock,
    });
    const content = ownerConfirmationContent(deps, userAction.target)!;
    expect(content.params).toEqual(expect.arrayContaining([{ name: "command", value: command }]));
    expect(content).toMatchObject({ pending: true, confirmLabel: "确认这一次", declineLabel: "不改" });
  });
});

// 工单 #72 返工：在 Slack 里做的决定写进对应工单的 activities（actor 是用户，via 是 slack）。
describe("a refused ticket action decided in the user's own Slack DM", () => {
  // 外部的一轮里被拦下的工单操作（turn-origin.ts 的兜底授权卡）：存下的是 ticket_action，参数里有 ticket_id。
  function refusedTicketAction(itemId: number): string {
    const { userAction } = requestRuleChangeConfirmation(db, {
      confirm: {
        operation: { kind: "lead_tool", tool: "ticket_action", input: { ticket_id: itemId, action: "cancel" } },
        reason: "李雷在频道里说这张不做了", why: "这一轮读了 Slack 对话", externalContent: [],
      },
      label: "取消工单", name: null, where: "工单详情", now: new Date(),
    });
    return userAction.target;
  }
  const decisions = (itemId: number) => listActivities(db, itemId)
    .filter((activity) => activity.kind === "decision")
    .map((activity) => ({ actor: activity.actor, payload: JSON.parse(activity.payload as unknown as string) }));

  it("writes 不改 into the ticket's activities as the user's decision in Slack", async () => {
    const itemId = createItem(db, { title: "发布清单", brief: "b", createdBy: "lead", hold: true });
    const target = refusedTicketAction(itemId);
    await post(target);
    await hub.receiveFromTransport("slack", slack.click(message(), SLACK_DECLINE_ACTION));
    expect(decisions(itemId)).toEqual([{
      actor: "user",
      payload: expect.objectContaining({
        decision: "owner_confirmation", target, choice: "decline", label: "取消工单", state: "declined", via: "slack",
        credential: { bindingId: binding.id, name: "Slack 私信（你自己）" },
      }),
    }]);
    // 重复点、别人点：不再写。
    await hub.receiveFromTransport("slack", slack.click({ ...message(), blocks: [] }, SLACK_DECLINE_ACTION));
    await hub.receiveFromTransport("slack", slack.click({ ...message(), blocks: [] }, SLACK_CONFIRM_ACTION, { user: "U0MALLORY" }));
    expect(decisions(itemId)).toHaveLength(1);
  });

  it("writes 确认这一次 into the ticket's activities too", async () => {
    const itemId = createItem(db, { title: "发布清单", brief: "b", createdBy: "lead", hold: true });
    const target = refusedTicketAction(itemId);
    await post(target);
    await hub.receiveFromTransport("slack", slack.click(message(), SLACK_CONFIRM_ACTION));
    // 这里没接工单操作的服务，执行会失败（state failed）；要核对的是这次决定记在了工单上。
    expect(decisions(itemId)).toEqual([{
      actor: "user",
      payload: expect.objectContaining({ decision: "owner_confirmation", target, choice: "confirm", via: "slack", state: expect.any(String) }),
    }]);
  });

  it("writes no activity for a confirmation that is not about a ticket", async () => {
    const itemId = createItem(db, { title: "发布清单", brief: "b", createdBy: "lead", hold: true });
    const target = await refusedTighten();
    await post(target);
    await hub.receiveFromTransport("slack", slack.click(message(), SLACK_CONFIRM_ACTION));
    expect(decisions(itemId)).toEqual([]);
  });
});

describe("a connection write confirmed in the user's own Slack DM", () => {
  const target = "connection_confirmation:cfm_abcdefgh1234";

  it("runs the stored write once and records the owner action as done in Slack", async () => {
    connections.add("cfm_abcdefgh1234", new Date(clock.getTime() + 10 * 60_000));
    await post(target);
    expect(blocksText()).toContain("GitHub · 写入确认");
    expect(blocksText()).toContain("在 acme/x 开一个 issue「发布清单」");
    await hub.receiveFromTransport("slack", slack.click(message(), SLACK_CONFIRM_ACTION));
    expect(connections.calls).toEqual(["cfm_abcdefgh1234"]);
    expect(connections.confirmation("cfm_abcdefgh1234")).toMatchObject({ state: "done", resolvedBy: expect.stringContaining("Slack 私信") });
    expect(listEvents(db, { kind: OWNER_ACTION_PERFORMED_KIND, limit: 100 }).map((event) => event.payload as any)).toEqual([
      expect.objectContaining({
        action: "connection.confirm", source: expect.objectContaining({ client: "channel", deviceName: "Slack 私信（你自己）" }),
        credential: expect.objectContaining({ bindingId: binding.id, origin: "channel_owner" }),
      }),
    ]);
    expect(blocksText()).toContain("issue #12 已创建");
    // 重复点：不再执行。
    await hub.receiveFromTransport("slack", slack.click({ ...message(), blocks: [] }, SLACK_CONFIRM_ACTION));
    expect(connections.calls).toHaveLength(1);
  });

  it("voids the write on 不改 and does not run an expired one", async () => {
    connections.add("cfm_abcdefgh1234", new Date(clock.getTime() + 10 * 60_000));
    await post(target);
    await hub.receiveFromTransport("slack", slack.click(message(), SLACK_DECLINE_ACTION));
    expect(connections.confirmation("cfm_abcdefgh1234").state).toBe("rejected");
    expect(blocksText()).toContain("已作废");

    connections.add("cfm_zyxwvuts9876", new Date(clock.getTime() + 10 * 60_000));
    await post("connection_confirmation:cfm_zyxwvuts9876");
    clock = new Date(clock.getTime() + 11 * 60_000);
    await hub.receiveFromTransport("slack", slack.click(message(), SLACK_CONFIRM_ACTION));
    expect(connections.calls).toEqual([]);
    expect(blocksText()).toContain("已过期");
  });
});
