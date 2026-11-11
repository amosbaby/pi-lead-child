// 执行模式（protocol 的 execution-mode.ts）的操作：set。页面（gateway 的 execution-mode-routes.ts）和 Lead（perform_action）
// 调同一个定义。
//   - set：user_direct，改规则（spec P1-1：切换是正式操作）。它决定 daemon 起不起执行者、外部工人能不能领单，
//     只有用户本人能切。Lead 调它在哪一轮都拿到结构化的拒绝，拒绝里写用户去哪里切。
//   - 和原来一样时什么也不写。正在跑的 Run 不受影响。
import type { ExecutionModeDto, SetExecutionModeRequest } from "@pi-lead-child/protocol";
import { EXECUTION_MODE_WHERE, getExecutionMode, setExecutionMode, type ExecutionModeChange } from "../execution-mode.js";
import { AVAILABLE } from "../ticket-actions/types.js";
import type { UiActionDefinition, UiActionTargetKind } from "./types.js";

const WORDS: Record<ExecutionModeDto["mode"], string> = {
  self: "self：daemon 自己起执行者跑工单",
  external: "external：daemon 不起执行者，工单留在队列里等外部工人领走",
  paused: "paused：总闸，不派发，外部工人也不能领单",
};

export const EXECUTION_MODE_TARGET: UiActionTargetKind<ExecutionModeDto> = {
  type: "execution_mode",
  label: "执行模式",
  idHint: "daemon",
  load: (env, id) => (id === "daemon" ? { mode: getExecutionMode(env.db) } : null),
  name: () => "执行模式",
  describe: (state) => ({ mode: state.mode, words: `现在是 ${WORDS[state.mode]}。正在跑的 Run 不受切换影响。` }),
};

export const EXECUTION_MODE_ACTIONS = {
  set: {
    target: "execution_mode", id: "set", label: "切执行模式", scope: "tickets:create",
    permission: "user_direct", changesRules: true, external: false, irreversible: false,
    where: EXECUTION_MODE_WHERE,
    hint: "只有用户本人能切：你调用总是被拒绝。用户要切时，告诉用户去 " + EXECUTION_MODE_WHERE + " 切。不要发确认卡。",
    defaultReason: "切了执行模式",
    available: () => AVAILABLE,
    run: (run): ExecutionModeChange => setExecutionMode(run.db, (run.input as SetExecutionModeRequest).mode),
    forLead: (_run, result) => {
      const change = result as ExecutionModeChange;
      return change.changed ? { result: "updated", mode: change.mode } : { result: "unchanged", mode: change.mode };
    },
    detail: (_run, result) => ({ ...(result as ExecutionModeChange) }),
  },
} satisfies Record<string, UiActionDefinition<ExecutionModeDto, any>>;
