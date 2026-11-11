// 后台检查（watch）的命令在哪里跑（docs/ticket-246-user-turn-bypass.md 第 10 节，用户 2026-11-11）。
//
// 命令检查到点时由系统自己跑，没有人在场，也没有「这一轮」。以前一律在 Lead 的沙箱里跑：沙箱里 gh、git 没有用户的凭证，
// 「推完以后等 CI」这种检查永远看不到结果。用户定的规则：
//   1. 用户交代的事带出来的检查（Lead 为了办用户的事自己设的也算）：免沙箱开着时，到点在沙箱外跑。
//   2. 别人的话带出来的检查（外部消息叫醒的一轮、外部来源的定时器）：在沙箱里跑。
//   3. 这一轮读过别人写的内容（连接的结果、通道的对话），但没有别人的消息叫醒它：设的那一刻请决策模型判断一次
//      （host-command-judge.ts，和 bash 同一个判断）。是用户交代的事、或者撤得回：按第 1 种。不是、又难撤回：
//      照别人要求的定时器走（engine 的 requestExternalTimer：设并告诉用户、发确认卡、或者不设），到点在沙箱里跑。
// 判断只在设的时候做一次，结果记在 watches.host_run。到点时不再问模型，只看三件事：host_run、开关现在开没开、
// 命令碰没碰底线（筛查器，和 bash 同一份）。有一件不成立就照旧在沙箱里跑。
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  copyScreenedScripts, HOST_COMMAND_LIMITS, newHostCommandId, recordHostCommandFinished, recordHostCommandStarted,
  screenHostCommand, spawnHostProcess, type HostCommandRecord, type SmartModel, type WatchCommandResult,
} from "@pi-lead-child/engine";
import { getHostBypass, type Db, type Watch } from "@pi-lead-child/store";
import { credentialPathReason } from "./credential-guard.js";
import { hostCommandRoute, leadScratchDir, leadWritableRoots } from "./hands.js";
import { hostBypassActive, turnOriginOf, type TurnOriginDeps } from "./turn-origin.js";

export type WatchSetDecision =
  // 照这一轮本来的路设（turn-origin.ts 的 setTimerInTurn）。hostRun：到点可以在沙箱外跑。
  | { path: "default"; hostRun: boolean }
  // 这一轮只读过工具带回来的外部内容，决策模型判断这条命令可以跑：当作 Lead 自己（或者用户）的检查设，到点在沙箱外跑。
  | { path: "own"; hostRun: true }
  // 决策模型判断命令不是用户交代的事、又难撤回（或者判断不了）：照别人要求的定时器走，到点在沙箱里跑。why 给 Lead 看。
  | { path: "external"; hostRun: false; why: string };

/**
 * 设一个命令检查时：到点能不能在沙箱外跑，以及这个检查照哪条路设。免沙箱关着时一切照旧（default，不在沙箱外跑）。
 */
export async function decideWatchCommand(
  db: Db, deps: TurnOriginDeps,
  input: { command: string; dataDir: string; note?: string; smartModel?: SmartModel | null | undefined; home?: string },
): Promise<WatchSetDecision> {
  const bypass = hostBypassActive(db, deps);
  if (!bypass.active) return { path: "default", hostRun: false };
  const origin = turnOriginOf(deps);
  const sources = bypass.externalContent;
  // 别人的消息在这一轮里（叫醒它的，或者混进来的）：第 2 种，照这一轮本来的路设，在沙箱里跑。
  if ((origin.externalEvents?.length ?? 0) > 0 || (sources ?? []).some((source) => source.via === "message")
    || (origin.external && (sources ?? []).length === 0)) {
    return { path: "default", hostRun: false };
  }
  const route = await hostCommandRoute(db, deps, {
    command: input.command, cwd: leadScratchDir(input.dataDir), via: "watch", spendsMoney: false, dataDir: input.dataDir,
    smartModel: input.smartModel, reason: input.note, ...(input.home ? { home: input.home } : {}),
  });
  if (route.route === "host") return sources === null ? { path: "default", hostRun: true } : { path: "own", hostRun: true };
  // 碰到底线的命令照旧在沙箱里跑：沙箱自己挡着凭证和账本。
  if (route.route !== "confirm" || route.screen) return { path: "default", hostRun: false };
  return { path: "external", hostRun: false, why: route.why };
}

export interface WatchCommandRunnerOptions {
  dataDir: string;
  /** 在沙箱里跑的执行函数（engine 的 sandboxWatchCommand）。 */
  sandboxed: (command: string, timeoutSeconds: number, watch: Watch) => Promise<WatchCommandResult>;
  home?: string;
  shell?: string;
  log?: (line: string) => void;
  now?: () => Date;
}

/**
 * 命令检查的执行函数：host_run 的检查在免沙箱开着、命令没碰底线时在沙箱外跑（用户的登录 shell，和 run_on_host 一样），
 * 别的照旧在沙箱里跑。
 * 沙箱外的每一次不都写 host_command 事件：一个检查可能每 10 秒跑一次。第一次写，结果变了（通过、不通过、超时）的那一次也写；
 * 每一次的结果照旧记在 watch_checks 里。输出不另存文件。
 */
export function watchCommandRunner(db: Db, options: WatchCommandRunnerOptions) {
  const cwd = leadScratchDir(options.dataDir);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  return async (command: string, timeoutSeconds: number, watch: Watch): Promise<WatchCommandResult> => {
    if (watch.host_run !== 1 || !getHostBypass(db, options.now?.() ?? new Date()).enabled) {
      return options.sandboxed(command, timeoutSeconds, watch);
    }
    const screen = screenHostCommand({
      command, cwd, allowedRoots: leadWritableRoots(db, options.dataDir), dataDir: options.dataDir, home: options.home ?? homedir(),
      credentialPathReason: (path, context) => credentialPathReason(path, context),
    });
    if (screen.verdict !== "allow") {
      options.log?.(`[watch] #${watch.id} stays in the sandbox: screen ${screen.hits.map((hit) => hit.rule).join(", ")}`);
      return options.sandboxed(command, timeoutSeconds, watch);
    }
    const record: HostCommandRecord = {
      id: newHostCommandId(), turnId: null, turnOrigin: "lead_turn", via: "watch", confirmationId: null,
      command, cwd, timeoutSeconds, screen: { verdict: screen.verdict, rule: screen.logged[0]?.rule ?? null }, spendsMoney: false,
    };
    const first = watch.check_count === 0;
    const started = options.now?.() ?? new Date();
    if (first) recordHostCommandStarted(db, record, started);
    const result = await spawnHostProcess(screen.scripts.length ? copyScreenedScripts(command, screen.scripts, tmpdir()) : command, {
      cwd, timeoutSeconds, ...(options.shell ? { shell: options.shell } : {}),
    });
    const status = !result.timedOut && result.exitCode === 0 ? "pass" : "fail";
    if (first || status !== watch.last_status) {
      if (!first) recordHostCommandStarted(db, record, started);
      recordHostCommandFinished(db, record.id, result, "");
    }
    return {
      exitCode: result.timedOut ? null : result.exitCode, timedOut: result.timedOut,
      output: result.output.slice(-HOST_COMMAND_LIMITS.tailChars * 4),
    };
  };
}
