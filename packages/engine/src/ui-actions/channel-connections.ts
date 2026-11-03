// 来源的连接方式（设置 → 消息通道，2026-11-02，.scratch/slack-session 工单 05、09）的操作。页面和 Lead（perform_action）调同一个定义，
// 都经过 daemon 的通道设置（services.channelConnections）。这里不认识具体的来源：方式的名字、要不要登录、要不要单独打开
// 「代你写」都由来源定义（ChannelAdapter.connection）。
//   - sign_in：user_direct。打开登录窗口，用户登录成功、检查通过以后保存密钥、换到这种方式。它把账号的权限交给系统。
//   - cancel_sign_in：关掉正在等的登录窗口。Lead 可以做。
//   - use_mode：换回一种不用登录的方式（例如 Slack 应用）。改连接设置（changesRules），Lead 可以做。
//   - allow_writes：user_direct。打开「代你往来源里写」：这种方式下以你的身份发言。
//   - block_writes：关掉它，只减少权限。改连接设置，Lead 可以做。
import type { UiActionInputOf } from "@pi-lead-child/protocol";
import { AVAILABLE, unavailable } from "../ticket-actions/types.js";
import {
  UiActionError, type ChannelConnectionService, type ChannelConnectionState, type UiActionDefinition, type UiActionEnv, type UiActionTargetKind,
} from "./types.js";

export const CHANNEL_CONNECTION_WHERE = "设置 → 消息通道 → 连接方式";

function service(env: UiActionEnv): ChannelConnectionService {
  const found = env.services.channelConnections;
  if (!found) throw new UiActionError("unavailable", "消息通道还没有启动");
  return found;
}

export const CHANNEL_CONNECTION_TARGET: UiActionTargetKind<ChannelConnectionState> = {
  type: "channel_connection",
  label: "消息通道的连接方式",
  idHint: "来源，例如 slack",
  load: (env, id) => env.services.channelConnections?.state(id) ?? null,
  name: (target) => `${target.label} 的连接方式`,
  // 没有密钥：只有方式、开关和登录的状态。
  describe: (target) => ({ ...target }),
};

const modeOf = (target: ChannelConnectionState, mode: string) => target.modes.find((item) => item.mode === mode) ?? null;

export const CHANNEL_CONNECTION_ACTIONS = {
  sign_in: {
    target: "channel_connection", id: "sign_in", label: "登录这种连接方式", scope: "tickets:create",
    permission: "user_direct", changesRules: true, external: false, irreversible: false,
    where: CHANNEL_CONNECTION_WHERE,
    hint: "用户要换成要登录的方式（例如 Slack 的浏览器会话 session）时，这一步只有用户本人能做：它会打开一个窗口让用户登录，"
      + "并把整个账号的权限交给系统。告诉用户去设置页点「登录」，先读那里的风险说明。",
    defaultReason: "在设置页登录",
    available: (target) => {
      if (target.signIn?.state === "waiting") return unavailable("已经有一个登录窗口在等用户登录");
      return target.modes.some((item) => item.needsSignIn) ? AVAILABLE : unavailable("这个来源没有要登录的方式");
    },
    run: (run) => {
      const { mode } = run.input as UiActionInputOf<"channel_connection", "sign_in">;
      if (!modeOf(run.target, mode)?.needsSignIn) throw new UiActionError("invalid_input", `${run.target.label} 没有要登录的方式 ${mode}`);
      return service(run.env).signIn(run.target.source, mode);
    },
    forLead: (_run, result) => result,
    detail: (run) => ({ mode: (run.input as { mode: string }).mode }),
  },
  cancel_sign_in: {
    target: "channel_connection", id: "cancel_sign_in", label: "取消登录", scope: "tickets:create",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false,
    where: CHANNEL_CONNECTION_WHERE,
    hint: "关掉正在等用户登录的窗口。用户说不登了、或者要换回原来的方式时用。",
    defaultReason: "取消了登录",
    available: (target) => (target.signIn?.state === "waiting" ? AVAILABLE : unavailable("没有正在等的登录窗口")),
    run: (run) => service(run.env).cancelSignIn(run.target.source),
    forLead: (_run, result) => result,
  },
  use_mode: {
    target: "channel_connection", id: "use_mode", label: "换连接方式", scope: "tickets:create",
    permission: "lead_allowed", changesRules: true, external: false, irreversible: false,
    where: CHANNEL_CONNECTION_WHERE,
    hint: "换回一种不用登录的方式（例如 Slack 的 app：Slack 应用和它的两个令牌）。换了以后这个来源会重连。"
      + "要登录的方式用 sign_in（只有用户本人能做）。",
    defaultReason: "在设置页换了连接方式",
    available: (target) => (target.modes.some((item) => !item.needsSignIn && item.mode !== target.mode)
      ? AVAILABLE : unavailable("没有别的不用登录的方式可以换")),
    run: (run) => {
      const { mode } = run.input as UiActionInputOf<"channel_connection", "use_mode">;
      const found = modeOf(run.target, mode);
      if (!found) throw new UiActionError("invalid_input", `${run.target.label} 没有 ${mode} 这种方式`);
      if (found.needsSignIn) throw new UiActionError("invalid_input", `${mode} 要登录：请用户在 ${CHANNEL_CONNECTION_WHERE} 里点「登录」`);
      return service(run.env).useMode(run.target.source, mode);
    },
    forLead: (_run, result) => result,
    detail: (run) => ({ mode: (run.input as { mode: string }).mode }),
  },
  allow_writes: {
    target: "channel_connection", id: "allow_writes", label: "允许代你往来源里写", scope: "tickets:create",
    permission: "user_direct", changesRules: true, external: false, irreversible: false,
    where: CHANNEL_CONNECTION_WHERE,
    hint: "打开以后，这种连接方式下你可以以用户的身份发消息、改消息、回表情。只有用户本人能打开：告诉用户去设置页打开开关。",
    defaultReason: "在设置页允许代你发消息",
    available: (target) => (target.writes === false ? AVAILABLE : unavailable(target.writes === true ? "已经打开了" : "现在的连接方式没有这个开关")),
    run: (run) => service(run.env).setWrites(run.target.source, true),
    forLead: (_run, result) => result,
  },
  block_writes: {
    target: "channel_connection", id: "block_writes", label: "不再代你往来源里写", scope: "tickets:create",
    permission: "lead_allowed", changesRules: true, external: false, irreversible: false,
    where: CHANNEL_CONNECTION_WHERE,
    hint: "关掉以后你在这个来源里只读：开卡、写草稿，不发任何东西。用户说「先别替我发了」时用。马上生效。",
    defaultReason: "关掉了代你发消息",
    available: (target) => (target.writes === true ? AVAILABLE : unavailable(target.writes === false ? "已经关着" : "现在的连接方式没有这个开关")),
    run: (run) => service(run.env).setWrites(run.target.source, false),
    forLead: (_run, result) => result,
  },
} satisfies Record<string, UiActionDefinition<ChannelConnectionState, any>>;
