// 工单详情卡片的"现在是什么状态、你能做什么"（工单 #66 复核 F8/F10/F11/F15）。
//
// 以前同一个状态在卡片上有五种说法：徽章说"返工已用尽且成果未登记"，下一步卡片说"独立核查未通过"，
// 托管卡片说"可自动交付"，红色卡片说"卡住了"，底部栏说"验收决策"。它们读的是同一个
// TicketSummary，却各自做了有损的映射。现在只有这一个函数做映射：徽章、状态区块、选项区块、
// 托管说明和底部栏都读它的输出，不再各自推导（AGENTS.md：每个界面从同一个 TicketSummary
// 推导当前状态）。
import type { KernelOutcomeSnapshotResource, Locale } from '@pi-lead-child/protocol';

import {
  formatCompactElapsed,
  supersededReviewText,
  ticketNextActionPresentation,
  type Ticket,
  type TicketActionId,
  type TicketActionPresentation,
} from '@/features/workspace/model';

import { leadNameNow } from '@/state/leadName';

import { deliveryNumber, type DeliveryNumbers } from './deliveryNumbers';
import { runFactsMessages } from './runFacts.messages';
import { durationWords, type TicketRunProgress } from './ticketChatStatus';
import { ticketStateMessages } from './ticketState.messages';

export type TicketStateTone = 'info' | 'attention' | 'danger' | 'success' | 'neutral';

export type TicketOptionId = TicketActionId | 'request_review';

export type TicketOptionPresentation = {
  id: TicketOptionId;
  label: string;
  /** 点下去会发生什么。null 表示动作本身已经说清楚了。 */
  consequence: string | null;
  tone: 'primary' | 'neutral' | 'danger';
  recommended: boolean;
};

export type TicketStatePresentation = {
  /** 元信息行里的短标签。 */
  chip: string;
  tone: TicketStateTone;
  headline: string;
  why: string | null;
  facts: { label: string; value: string }[];
  options: TicketOptionPresentation[];
  /** 自动化接下来会做什么；null 表示这个状态下不涉及自动化。托管区块读这一句。 */
  automation: string | null;
};

export type TicketStateInput = {
  ticket: Ticket;
  /** 当前合法、并且界面已经按执行状态过滤过的动作。 */
  actions: TicketActionPresentation[];
  outcome?: KernelOutcomeSnapshotResource | null;
  timing?: { statusDurationMs?: number | null } | null;
  /** 阻塞的工单：最新那条阻塞记录说明了原因。 */
  blocker?: { title: string; summary: string } | null;
  /** 用户已经处理了介入请求，工单还停在 blocked，等执行者或 Lead 重新上报。 */
  awaitingAfterIntervention?: boolean;
  /** 正在跑的那次 Run（ticketChatStatus）。核查 Run 准备太久时，状态卡要说出来，不能写「正在进行」。 */
  liveRun?: TicketRunProgress | null;
  /** 每次交付是第几次（deliveryNumbers.ts）。不给时交付写成「最新的交付」。 */
  deliveryNumbers?: DeliveryNumbers;
  /** Lead 的名字（useLeadName）。不给时读最近一次取到的名字（leadNameNow）。 */
  leadName?: string;
  /** 界面语言。不给时按英文。 */
  locale?: Locale;
};

type ReviewState = NonNullable<Ticket['reviewState']>;

// 核查自动化只在出结论的那一笔事务里跑一次（delegated-review.ts 的 applyReviewAutomation）：
// FAIL 时要么打回 active 并派返工，要么停手；PASS 时要么直接结单，要么停手。所以工单还停在
// review、又已经有了结论，就说明自动化已经停手了（#66 的 FAIL 发生在授权之前）。这时卡片不能
// 再说"Lead 会返工 / 会交付"，只能照实说没有自动动作，并给用户一个推荐（文案的 noAutomation）。
// 核查走到哪一步（文案的 progress）。排队、挂起、在跑是三种不同的状态，不能都写成"正在进行"。

function messagesOf(input: TicketStateInput) {
  return ticketStateMessages(input.locale ?? 'en');
}

function budgetUsed(review: ReviewState): { used: number; max: number } | null {
  if (review.reworkCyclesUsed === undefined || review.maxReworkCycles === undefined || review.maxReworkCycles === null) {
    return null;
  }
  return { used: review.reworkCyclesUsed, max: review.maxReworkCycles };
}

function deliveryRunOf(review: ReviewState, outcome: KernelOutcomeSnapshotResource | null | undefined): number | null {
  return review.deliveryRunId ?? outcome?.latest?.executorAttemptId ?? null;
}

// 文字里的交付写「第 N 次交付」，不写执行记录的编号（设计规范 P14.6）。
function deliveryNumberOf(review: ReviewState, input: TicketStateInput): number | null {
  return deliveryNumber(input.deliveryNumbers, deliveryRunOf(review, input.outcome));
}

function reviewFacts(
  review: ReviewState,
  input: TicketStateInput,
  options: { reviewing: boolean },
): { label: string; value: string }[] {
  const delivery = deliveryNumberOf(review, input);
  const budget = budgetUsed(review);
  const superseded = supersededReviewText(review, input.locale ?? 'en', input.deliveryNumbers);
  const stayed = formatCompactElapsed(input.timing?.statusDurationMs);
  const m = messagesOf(input);
  return [
    // 没有序号的交付不单列一行：「最新交付：最新的交付」不告诉用户任何事。
    ...(delivery === null ? [] : [{ label: m.facts.latestDelivery, value: m.facts.deliveryNumber(delivery) }]),
    {
      label: m.facts.review,
      value: review.reviewerAttemptId !== null
        ? review.verdict ? m.facts.verdict[review.verdict] : m.facts.verdictUnknown
        : review.reviewProgress
          ? m.progress[review.reviewProgress]
          : options.reviewing
            ? m.facts.startsSoon
            : m.facts.notReviewed(delivery),
    },
    ...(superseded ? [{ label: m.facts.previousReview, value: superseded }] : []),
    ...(budget ? [{ label: m.facts.reworkBudget, value: m.facts.budgetUsed(budget.used, budget.max) }] : []),
    ...(stayed ? [{ label: m.facts.stayed, value: m.facts.stayedValue(stayed) }] : []),
  ];
}

// 用户发起的返工不占 Lead 的返工额度（2026-10-13 用户确认）；有额度时把这一点说出来。
function reworkConsequence(review: ReviewState, input: TicketStateInput): string {
  const m = messagesOf(input);
  const base = deliveryRunOf(review, input.outcome) === null ? m.rework.again : m.rework.base(deliveryNumberOf(review, input));
  const leadName = input.leadName ?? leadNameNow();
  return budgetUsed(review) ? m.rework.own(base, leadName) : m.rework.plain(base);
}

/** 把合法动作翻成带后果的选项。只翻 review 阶段用得到的三个；其余动作保持原样。 */
function reviewOptions(
  input: TicketStateInput,
  review: ReviewState,
  copy: {
    complete?: { label: string; consequence: string | null; tone: TicketOptionPresentation['tone'] } | null;
    rework?: { label: string } | null;
    recommended?: TicketOptionId | null;
    requestReview?: boolean;
    requestReviewLabel?: string;
    requestReviewConsequence?: string;
  },
): TicketOptionPresentation[] {
  const delivery = deliveryNumberOf(review, input);
  const m = messagesOf(input);
  const options: TicketOptionPresentation[] = [];
  if (copy.requestReview) {
    options.push({
      id: 'request_review',
      label: copy.requestReviewLabel ?? m.requestReview,
      consequence: copy.requestReviewConsequence ?? m.requestReviewConsequence(delivery),
      tone: 'primary',
      recommended: copy.recommended === 'request_review',
    });
  }
  for (const action of input.actions) {
    if (action.id === 'complete') {
      if (copy.complete === null) continue;
      const complete = copy.complete ?? { label: m.accept, consequence: null, tone: 'primary' as const };
      options.push({ id: 'complete', ...complete, recommended: copy.recommended === 'complete' });
    } else if (action.id === 'rework') {
      if (copy.rework === null) continue;
      options.push({
        id: 'rework',
        label: copy.rework?.label ?? m.reworkManually,
        consequence: reworkConsequence(review, input),
        tone: copy.recommended === 'rework' ? 'primary' : 'neutral',
        recommended: copy.recommended === 'rework',
      });
    } else if (action.id === 'cancel') {
      options.push({ id: 'cancel', label: m.cancelTicket, consequence: m.cancelConsequence, tone: 'danger', recommended: false });
    } else {
      options.push({ id: action.id, label: action.label, consequence: null, tone: action.tone, recommended: false });
    }
  }
  return options;
}

// 挂起的核查重新排（user-actions.ts 的 requestReview，文案的 repickReview）。服务端只在有能用的核查员时才给这个按钮。

function reviewPresentation(input: TicketStateInput, review: ReviewState): TicketStatePresentation {
  const { ticket } = input;
  const delivery = deliveryNumberOf(review, input);
  const m = messagesOf(input);
  const NO_AUTOMATION = m.noAutomation;
  const skipReview = { label: m.skipReview, consequence: m.skipReviewConsequence, tone: 'danger' as const };
  const budget = budgetUsed(review);
  const exhausted = budget !== null && budget.used >= budget.max;

  // 要求独立核查、却没有核查会来：工单卡住了（#66）。由用户验收的工单能派核查，只是多一个选项。
  // 挂起的核查也能重新派（换一个能用的核查员），但它派过了，走下面「核查已暂停」的分支（2026-10-21）。
  if (review.canRequestReview && review.state === 'independent_review' && (review.reviewProgress ?? null) === null) {
    return {
      chip: m.notRequested.chip,
      tone: 'attention',
      headline: m.notRequested.headline(delivery),
      why: m.notRequested.why(exhausted),
      facts: reviewFacts(review, input, { reviewing: false }),
      options: reviewOptions(input, review, {
        requestReview: true,
        recommended: 'request_review',
        complete: { label: m.acceptAnyway, consequence: m.notRequested.consequence, tone: 'danger' },
      }),
      automation: NO_AUTOMATION,
    };
  }

  switch (review.state) {
    case 'rework_exhausted':
      return {
        chip: m.exhausted.chip,
        tone: 'danger',
        headline: review.outcomeRecoveryFailed ? m.exhausted.noOutcome(delivery) : m.exhausted.budgetUsedUp,
        why: review.reason,
        facts: reviewFacts(review, input, { reviewing: false }),
        options: reviewOptions(input, review, {
          complete: {
            label: m.acceptAnyway,
            consequence: review.outcomeRecoveryFailed ? m.exhausted.noOutcomeConsequence : m.exhausted.noPassConsequence,
            tone: 'danger',
          },
          recommended: 'rework',
        }),
        automation: NO_AUTOMATION,
      };
    case 'evidence_conflict':
      return {
        chip: m.conflict.chip,
        tone: 'danger',
        headline: m.conflict.headline,
        why: review.reason,
        facts: reviewFacts(review, input, { reviewing: false }),
        options: reviewOptions(input, review, {
          complete: { label: m.acceptAnyway, consequence: m.conflict.consequence, tone: 'danger' },
          recommended: 'rework',
        }),
        automation: NO_AUTOMATION,
      };
    case 'review_failed':
      return {
        chip: m.failed.chip,
        tone: 'attention',
        headline: m.failed.headline,
        why: review.reason,
        facts: reviewFacts(review, input, { reviewing: false }),
        // 核查不通过时不提供"验收通过"：与以前的规则相同（TicketThread 一直把它去掉）。
        options: reviewOptions(input, review, {
          complete: null,
          rework: { label: m.sendBack },
          recommended: 'rework',
        }),
        automation: NO_AUTOMATION,
      };
    case 'review_passed':
      return {
        chip: m.passed.chip,
        tone: 'success',
        headline: m.passed.headline,
        why: review.reason,
        facts: reviewFacts(review, input, { reviewing: false }),
        options: reviewOptions(input, review, { recommended: 'complete' }),
        automation: NO_AUTOMATION,
      };
    case 'waiting_user': {
      // 你派的核查被挂起时，按钮是重新排它，不是再派一个（2026-10-21 审查 M4）。
      const paused = review.reviewProgress === 'suspended';
      return {
        chip: m.waitingUser.chip,
        tone: 'attention',
        headline: m.waitingUser.headline,
        why: review.reason ?? m.waitingUser.why,
        facts: reviewFacts(review, input, { reviewing: false }),
        options: reviewOptions(input, review, {
          recommended: 'complete',
          rework: { label: m.sendBack },
          requestReview: review.canRequestReview === true,
          ...(paused ? { requestReviewLabel: m.repickReview } : {}),
          requestReviewConsequence: paused ? m.repickReviewConsequence : m.waitingUser.requestReviewConsequence(delivery),
        }),
        automation: NO_AUTOMATION,
      };
    }
    default: {
      // independent_review：核查在跑、已排队、排队但被挂起，或交付的执行者还在收尾。
      const progress = review.reviewProgress ?? null;
      const stalled = input.liveRun?.purpose === 'review' && input.liveRun.stalled ? input.liveRun : null;
      if (stalled) {
        // #66：核查 Run #73 停在 starting，状态卡却写着「核查中」。准备超过一分钟就照实说。
        return {
          chip: m.stalled.chip,
          tone: 'attention',
          headline: m.stalled.headline(durationWords(stalled.elapsedMs, input.locale ?? 'en')),
          why: m.stalled.why,
          facts: reviewFacts(review, input, { reviewing: true }),
          options: reviewOptions(input, review, { complete: skipReview }),
          automation: null,
        };
      }
      // 没有核查在路上，也派不了：这张工单还有 Run 在进行（工单对话也算）。服务端在有 Run 改动工作区时
      // 不派核查（review-authority 的 unreviewedDelivery），所以 canRequestReview 是 false。以前这里
      // 照样写「核查中 · 执行已结束，独立核查即将开始」，可并没有核查要开始（复核 P0-5：#66 在对话
      // Run #72 收尾时打开，先显示「即将开始」，Run 结束后才变成「核查未派发」）。
      const runInFlight = ticket.runtimeState === 'running' || ticket.runtimeState === 'starting'
        || ticket.runtimeState === 'stale';
      if (progress === null && runInFlight) {
        const live = input.liveRun && input.liveRun.purpose !== 'review' ? input.liveRun : null;
        return {
          chip: m.runInFlight.chip,
          tone: 'info',
          headline: live?.purpose === 'conversation'
            ? m.runInFlight.conversation
            : live
              ? m.runInFlight.live(runFactsMessages(input.locale ?? 'en').work[live.purpose])
              : m.runInFlight.unknown,
          why: m.runInFlight.why,
          facts: reviewFacts(review, input, { reviewing: false }),
          options: reviewOptions(input, review, { complete: skipReview }),
          automation: m.runInFlight.automation,
        };
      }
      return {
        chip: progress === 'suspended' ? m.reviewing.chipPaused : progress === 'queued' ? m.reviewing.chipQueued : m.reviewing.chipRunning,
        tone: progress === 'suspended' ? 'attention' : 'info',
        headline: progress === 'running'
          ? m.reviewing.running
          : progress === 'queued'
            ? m.reviewing.queued
            : progress === 'suspended'
              ? m.reviewing.paused
              : m.reviewing.soon,
        why: progress === 'suspended' ? review.reason : null,
        facts: reviewFacts(review, input, { reviewing: true }),
        options: reviewOptions(input, review, {
          complete: skipReview,
          requestReview: progress === 'suspended' && review.canRequestReview === true,
          requestReviewLabel: m.repickReview,
          requestReviewConsequence: m.repickReviewConsequence,
        }),
        automation: m.reviewing.automation,
      };
    }
  }
}

export function ticketStatePresentation(input: TicketStateInput): TicketStatePresentation {
  const presentation = stagePresentation(input);
  // 工单上有等你回答的决定（Lead 的决定卡，或者 agent 的决策请求）：轮到你做的就是回答它（2026-10-16）。
  // 不再按阶段推荐动作（以前收件箱和这里写「派发独立核查」，决定卡问的却是「并入 #72 / 再返工 / 取消」）；
  // 阶段动作留在「其他选择」里。详情在这张卡上直接放这条决定和它的选项。
  if ((input.ticket.pendingDecisionCount ?? 0) > 0) {
    return {
      ...presentation,
      chip: input.ticket.statusLabel,
      tone: 'attention',
      headline: messagesOf(input).pendingDecision.headline,
      why: messagesOf(input).pendingDecision.why(input.leadName ?? leadNameNow()),
      options: presentation.options.map((option) => ({ ...option, recommended: false })),
      automation: null,
    };
  }
  return presentation;
}

function stagePresentation(input: TicketStateInput): TicketStatePresentation {
  const { ticket } = input;
  if (ticket.status === 'review' && ticket.reviewState) return reviewPresentation(input, ticket.reviewState);
  const execution = ticket.executionState
    && (ticket.executionState.state !== 'running' || ticket.executionState.kind === 'recovery')
    ? ticket.executionState
    : null;
  const executionStopped = execution?.state === 'failed' || execution?.state === 'blocked';
  const m = messagesOf(input);
  // 优先级与以前分散在卡片上的几块相同：已处理介入 > 执行状态 > 阻塞记录 > 通用下一步。
  const next = input.awaitingAfterIntervention && ticket.status === 'blocked'
    ? {
      label: m.afterIntervention.label,
      body: m.afterIntervention.body(input.leadName ?? leadNameNow()),
      tone: 'attention' as const,
    }
    : execution
      ? { label: execution.label, body: execution.reason ?? '', tone: executionStopped ? 'danger' as const : 'info' as const }
      : input.blocker && ticket.status === 'blocked'
        ? { label: input.blocker.title, body: input.blocker.summary, tone: 'danger' as const }
        : ticketNextActionPresentation(ticket, input.locale ?? 'en');
  const options = input.actions.map((action): TicketOptionPresentation => ({
    id: action.id,
    label: action.id === 'cancel' ? m.cancelTicket : action.label,
    consequence: null,
    tone: action.tone,
    recommended: false,
  }));
  const recommended = options.find((option) => option.tone === 'primary');
  if (recommended) recommended.recommended = true;
  return {
    chip: execution?.kind === 'recovery' && !executionStopped ? execution.label : ticket.statusLabel,
    tone: next?.tone ?? (ticket.status === 'done' || ticket.status === 'acked' ? 'success' : 'neutral'),
    headline: next?.label ?? ticket.statusLabel,
    why: next?.body || null,
    facts: [],
    options,
    automation: next?.tone === 'info' ? next.body : null,
  };
}
