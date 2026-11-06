// 「我不在看 App 时，把 Lead 的消息同步到我的 Slack 私信」开关（设置 → 消息通道，2026-11-06，工单 #88）的操作：打开（enable）、关掉（disable）。
// 页面（POST /v1/actions/owner_dm_sync/user/<操作>）和 Lead（perform_action）调同一个定义。开关存在 kv（store 的 getOwnerDmSync），缺省关；
// 真正同步的是 daemon（server.ts 的 mirrorTurnToOwnerDm，判断在 gateway 的 owner-dm-relay.ts）。
// 权限（用户 2026-11-06）：只认用户本人正在说话的这一轮（App 或者他自己的 Slack 私信）。外部消息叫醒的一轮（改规则，changesRules）、
// 定时器叫醒的一轮（liveUserTurnOnly：连用户自己设的跟进到点的一轮也不算）都拒绝。
import { getOwnerDmSync, writeOwnerDmSync, type OwnerDmSyncSetting } from "@pi-lead-child/store";
import { AVAILABLE, unavailable } from "../ticket-actions/types.js";
import type { UiActionDefinition, UiActionRun, UiActionTargetKind } from "./types.js";

export const OWNER_DM_SYNC_WHERE = "设置 → 消息通道 → 同步到 Slack 私信";

export const OWNER_DM_SYNC_TARGET: UiActionTargetKind<OwnerDmSyncSetting> = {
  type: "owner_dm_sync",
  label: "同步到 Slack 私信",
  idHint: "user",
  load: (env, id) => (id === "user" ? getOwnerDmSync(env.db) : null),
  name: () => "同步到 Slack 私信",
  describe: (setting) => ({ ...setting }),
};

function setSync(run: UiActionRun<OwnerDmSyncSetting, unknown>, enabled: boolean): OwnerDmSyncSetting {
  return writeOwnerDmSync(run.db, enabled, { by: run.by.actor === "user" ? "user" : "lead", at: run.env.now });
}

const common = {
  target: "owner_dm_sync", scope: "tickets:create",
  permission: "user_only", userTurnOnly: true, liveUserTurnOnly: true,
  permissionNote: "只属于用户：只有用户本人在这一轮明确要求时代他切换（App 里或者他自己的 Slack 私信里）",
  changesRules: true, external: false, irreversible: false,
  where: OWNER_DM_SYNC_WHERE,
} as const;

export const OWNER_DM_SYNC_ACTIONS = {
  enable: {
    ...common, id: "enable", label: "打开同步到 Slack 私信",
    hint: "用户要你在他不在看 App 时把你写给他的话也发到他自己的 Slack 私信（例如「开启同步」「我出门了，消息发我 Slack」）时用。"
      + "打开以后，他不在看 App 时你的回复和系统叫醒你后写给他的话会发到那条私信；他在看 App 时不发。",
    defaultReason: "在设置页打开了同步到 Slack 私信",
    available: (setting) => (setting.enabled ? unavailable("已经打开了") : AVAILABLE),
    run: (run) => setSync(run, true),
    forLead: () => ({ result: "enabled", next: "已经打开。用一句话告诉用户：他不在看 App 时，你的消息会同步到他的 Slack 私信。" }),
  },
  disable: {
    ...common, id: "disable", label: "关掉同步到 Slack 私信",
    hint: "用户要你不再把消息同步到他的 Slack 私信时用（例如「关闭同步」「别再发我 Slack 了」）。",
    defaultReason: "在设置页关掉了同步到 Slack 私信",
    available: (setting) => (setting.enabled ? AVAILABLE : unavailable("已经关着")),
    run: (run) => setSync(run, false),
    forLead: () => ({ result: "disabled", next: "已经关掉。用一句话告诉用户：消息只在 App 里看。" }),
  },
} satisfies Record<string, UiActionDefinition<OwnerDmSyncSetting, any>>;
