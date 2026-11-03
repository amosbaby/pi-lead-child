import { runtimeDisplayName } from '../workspace/runtimeNames';
// 对话坞里除了最后一条消息以外的两件事：你刚做的动作（回执），和正在跑的那次 Run（实时进度）。
// #66 上你点了「派发独立核查」，变化只出现在屏幕外的状态卡里；核查 Run #73 一直停在 starting，
// 界面上没有任何地方说它卡住了。现在回执和进度都落在对话坞里，也就是你点按钮时眼睛所在的地方。
import type { ActivityDto, Locale, TicketChatResume } from '@pi-lead-child/protocol';

import type { AttemptEntity } from '@/state/types';

import { START_RUN_DECISION, STOP_RUN_DECISION } from './activityKeys';
import type { RunFacts, RunPurpose } from './runFacts';
import { runFactsMessages } from './runFacts.messages';

export type TicketActionReceipt = {
  /** 用你的口吻写：「你派发了独立核查」。 */
  title: string;
  createdAt: string;
};

// 用户的「开始执行」「停止执行」直接用中文记（activityKeys.ts），回执按界面语言写。
function userDecisionReceipts(leadName: string, locale: Locale): Record<string, string> {
  const m = runFactsMessages(locale).receipt;
  return {
    review_requested_by_user: m.reviewRequested,
    rework_dispatch_requested: m.reworkRequested,
    delegation_preflight_accepted: m.delegated(leadName),
    ticket_runtime_switched: m.runtimeSwitched,
    [START_RUN_DECISION]: m.started,
    [STOP_RUN_DECISION]: m.stopped,
  };
}

function userTransitionReceipts(locale: Locale): Record<string, string> {
  const m = runFactsMessages(locale).receipt;
  return { done: m.done, cancelled: m.cancelled, active: m.active, ready: m.ready };
}

/** 你在这张工单上做的最近一个动作。系统和 Lead 做的不算。leadName 是 Lead 的名字（useLeadName）。 */
export function latestUserAction(
  activities: readonly Pick<ActivityDto, 'actor' | 'kind' | 'payload' | 'createdAt'>[],
  leadName: string,
  locale: Locale = 'en',
): TicketActionReceipt | null {
  const decisionReceipts = userDecisionReceipts(leadName, locale);
  const transitionReceipts = userTransitionReceipts(locale);
  let latest: TicketActionReceipt | null = null;
  for (const activity of activities) {
    if (activity.actor !== 'user') continue;
    const key = activity.kind === 'decision'
      ? stringOf(activity.payload.decision)
      : activity.kind === 'transition' ? stringOf(activity.payload.to) : null;
    const title = key === null
      ? undefined
      : activity.kind === 'decision' ? decisionReceipts[key] : transitionReceipts[key];
    if (!title) continue;
    if (latest === null || activity.createdAt >= latest.createdAt) latest = { title, createdAt: activity.createdAt };
  }
  return latest;
}

/** Run 启动超过这么久还停在 starting，就说它可能卡住了。正常情况下 10 秒内开始。 */
export const RUN_START_STALL_MS = 60_000;

export type TicketRunProgress = {
  runId: number;
  purpose: RunPurpose;
  /** 「核查 Run #73 · 正在准备」 */
  label: string;
  phase: 'starting' | 'running' | 'paused';
  elapsedMs: number;
  /** 准备了超过一分钟还没开始。 */
  stalled: boolean;
};

/** 正在跑的那次 Run。有几次同时在跑时取最新的一次。 */
export function liveRunProgress(
  attempts: readonly Pick<AttemptEntity, 'id' | 'role' | 'purpose' | 'state' | 'startedAt'>[],
  facts: ReadonlyMap<number, Pick<RunFacts, 'purpose'>>,
  now: number,
  locale: Locale = 'en',
): TicketRunProgress | null {
  const live = attempts
    .filter((attempt) => attempt.state === 'starting' || attempt.state === 'running' || attempt.state === 'paused')
    .sort((left, right) => right.id - left.id)[0];
  if (!live) return null;
  const purpose = facts.get(live.id)?.purpose ?? live.purpose ?? (live.role === 'reviewer' ? 'review' : 'execution');
  const phase = live.state as TicketRunProgress['phase'];
  const startedAt = Date.parse(live.startedAt);
  const elapsedMs = Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : 0;
  const m = runFactsMessages(locale);
  const phaseText = phase === 'starting' ? m.phase.starting : phase === 'paused' ? m.phase.paused : m.progressRunning[purpose];
  return {
    runId: live.id,
    purpose,
    label: `${m.purpose[purpose]} · ${phaseText}`,
    phase,
    elapsedMs,
    stalled: phase === 'starting' && elapsedMs > RUN_START_STALL_MS,
  };
}

/** 「13 分钟」「40 秒」「1 小时 8 分钟」。 */
export function durationWords(ms: number, locale: Locale = 'en'): string {
  const m = runFactsMessages(locale).duration;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return m.seconds(seconds);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return m.minutes(minutes);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? m.hours(hours) : m.hoursMinutes(hours, rest);
}

/** 「已 13 分钟」「已 40 秒」「已 1 小时 8 分钟」。 */
export function elapsedText(ms: number, locale: Locale = 'en'): string {
  return runFactsMessages(locale).elapsed(durationWords(ms, locale));
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// 输入框说明：现在是谁在跑、消息会去哪里（2026-10-15 方案 A）。工单对话的消息一律交给这张工单的 agent
// （2026-10-19 用户的决定，spec D13）：有 Run 在跑时交给那个 Run，没有时开一个对话 Run，续接最近的会话。
// 哪些 runtime 能在 Run 中途接收消息，和服务端 adapter 的 capabilities.steering 一致（packages/runtime）：
// 只有 Pi 能；Codex 和 Claude Code 的消息排队，Run 结束后转交（daemon 的 queueTicketMessage）。
const RUNTIME_TAKES_MESSAGES_MID_RUN: Record<string, boolean> = { pi: true, codex: false, claude: false };

export type TicketChatDestination = {
  hint: string;
  placeholder: string;
  /** 续接已结束的会话时的预估成本（2026-10-16：#77 的一问 45.6 万 token，#66 的一问 586 万 token）。其余情况为 null。 */
  cost: string | null;
};

/** 「约 45.6 万 token」「约 8,200 token」。 */
export function tokenEstimateText(tokens: number, locale: Locale = 'en'): string {
  return runFactsMessages(locale).tokens(tokens);
}

export function ticketChatDestination({ ticketDisplayId, liveRun, runtimeName, resume = null, locale = 'en' }: {
  ticketDisplayId: string;
  liveRun: TicketRunProgress | null;
  runtimeName?: string | null;
  /** 没有 Run 在跑时续接的会话（GET /v1/tickets/:id 的 chatResume）。没有可续接的会话、或者旧 daemon 不给时为 null。 */
  resume?: TicketChatResume | null;
  /** 界面语言。不给时按英文。 */
  locale?: Locale;
}): TicketChatDestination {
  const m = runFactsMessages(locale);
  if (liveRun && liveRun.phase !== 'paused') {
    const noun = m.agent[liveRun.purpose] ?? m.agent.conversation;
    const takesMessages = runtimeName ? RUNTIME_TAKES_MESSAGES_MID_RUN[runtimeName] ?? false : false;
    return {
      hint: takesMessages
        ? m.destination.takesMessages(noun)
        : m.destination.queued(noun, runtimeDisplayName(runtimeName)),
      placeholder: m.destination.placeholder(noun),
      cost: null,
    };
  }
  if (resume) {
    const noun = m.role[resume.role];
    return {
      hint: m.destination.resume(ticketDisplayId, noun),
      placeholder: m.destination.placeholder(noun),
      cost: resume.lastTokens === null
        ? m.destination.costUnknown
        : m.destination.cost(tokenEstimateText(resume.lastTokens, locale)),
    };
  }
  return {
    hint: m.destination.fresh(ticketDisplayId),
    placeholder: m.destination.freshPlaceholder,
    cost: null,
  };
}
