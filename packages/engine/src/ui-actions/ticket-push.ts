// 「待你处理」推送的两个开关（设置 → 消息通道，计划 Task 12，engine 的 worker-queue/pushes.ts）：推到 Slack 私信（slack_dm）、
// 桌面通知（desktop）。各自能打开（enable）、关掉（disable），缺省都开。
// 页面（POST /v1/actions/ticket_push/<编号>/<操作>）和 Lead（perform_action）调同一个定义。开关存在 kv（store 的 getTicketPushSetting）。
// 权限：lead_allowed，改规则（设置页的选项，AGENTS.md「UI Actions」）：Lead 在没读过外部内容的一轮里可以自己改；
// 外部消息叫醒的一轮、读过外部内容的一轮里被拒，拒绝里带确认卡。
import { getTicketPushSetting, isTicketPushChannel, writeTicketPushSetting, type TicketPushSetting } from "@pi-lead-child/store";
import { AVAILABLE, unavailable } from "../ticket-actions/types.js";
import type { UiActionDefinition, UiActionRun, UiActionTargetKind } from "./types.js";

export const TICKET_PUSH_WHERE = "设置 → 消息通道 → 待你处理推送";

const NAMES: Record<TicketPushSetting["channel"], string> = {
  slack_dm: "待你处理推到 Slack 私信",
  desktop: "待你处理弹桌面通知",
};

export const TICKET_PUSH_TARGET: UiActionTargetKind<TicketPushSetting> = {
  type: "ticket_push",
  label: "待你处理推送",
  idHint: "slack_dm 或 desktop",
  load: (env, id) => (isTicketPushChannel(id) ? getTicketPushSetting(env.db, id) : null),
  name: (setting) => NAMES[setting.channel],
  describe: (setting) => ({ ...setting }),
};

function setPush(run: UiActionRun<TicketPushSetting, unknown>, enabled: boolean): TicketPushSetting {
  return writeTicketPushSetting(run.db, run.target.channel, enabled, { by: run.by.actor === "user" ? "user" : "lead", at: run.env.now });
}

const common = {
  target: "ticket_push", scope: "tickets:create",
  permission: "lead_allowed", changesRules: true, external: false, irreversible: false,
  where: TICKET_PUSH_WHERE,
} as const;

export const TICKET_PUSH_ACTIONS = {
  enable: {
    ...common, id: "enable", label: "打开待你处理推送",
    hint: "要用户拿主意的工单（Lead 判断要他处理、工人交回给他）推给他：slack_dm 是推到他自己的 Slack 私信（状态变了改写那一条），"
      + "desktop 是弹桌面通知。用户说「要我处理的单发我 Slack」「弹个通知」这类话时打开对应的那个。",
    defaultReason: "在设置页打开了待你处理推送",
    available: (setting) => (setting.enabled ? unavailable("已经打开了") : AVAILABLE),
    run: (run) => setPush(run, true),
    forLead: (run) => ({ result: "enabled", next: `已经打开（${NAMES[run.target.channel]}）。用一句话告诉用户。` }),
  },
  disable: {
    ...common, id: "disable", label: "关掉待你处理推送",
    hint: "用户不要再把要他处理的工单推到 Slack 私信（slack_dm）或者弹桌面通知（desktop）时关掉对应的那个。关掉以后网页列表里照样能看到。",
    defaultReason: "在设置页关掉了待你处理推送",
    available: (setting) => (setting.enabled ? AVAILABLE : unavailable("已经关着")),
    run: (run) => setPush(run, false),
    forLead: (run) => ({ result: "disabled", next: `已经关掉（${NAMES[run.target.channel]}）。用一句话告诉用户：要他处理的单在网页列表里看。` }),
  },
} satisfies Record<string, UiActionDefinition<TicketPushSetting, any>>;
