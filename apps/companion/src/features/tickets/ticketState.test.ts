import type { KernelOutcomeSnapshotResource, TicketSummary } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import { buildTicketActionPresentation, ticketSummaryToTicket } from '../workspace/model';
import { deliveryNumbersOf } from './deliveryNumbers';
import { ticketStatePresentation } from './ticketState';

type ReviewState = NonNullable<TicketSummary['reviewState']>;

function summary(overrides: Partial<TicketSummary> = {}): TicketSummary {
  return {
    id: 66,
    title: 'FINAL #45 implementation - outcome snapshot and registry mechanism',
    summary: 'User-requested real follow-up: implement the outcome snapshot mechanism.',
    kind: 'task',
    stage: 'review',
    status: 'review',
    hasRun: true,
    priority: 'normal',
    project: 'pi-lead-child',
    dueAt: null,
    deferUntil: null,
    updatedAt: '2026-08-21T10:57:31.069Z',
    verificationPolicy: 'independent_reviewer',
    acceptancePolicy: 'delegated_to_lead',
    reworkPolicy: 'automatic',
    deliveryPolicy: 'continue_workflow',
    runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
    attention: { pendingApprovalCount: 0, blockerCount: 0 },
    ...overrides,
  };
}

const outcome: KernelOutcomeSnapshotResource = {
  latest: {
    id: 2,
    ticketId: 66,
    executorAttemptId: 49,
    completionCheckpointId: null,
    source: 'system_recovered',
    sourceEventSeq: 447,
    sourceOutputSha256: 'c52eaf3a94d7ac85849cd03b668ec404bd84a875d3183278cf456adcb0b53e14',
    summary: 'Closed the outcome-registry gap.',
    changes: [],
    deliverables: [],
    validations: [],
    completeness: 'complete',
    missingFields: [],
    recoveryNote: null,
    createdAt: '2026-08-21T10:48:04.022Z',
  },
  historyCount: 2,
  facts: { implementationCompleted: true, independentEvidence: 'missing', acceptance: 'none' },
  reviewerVerdict: null,
};

// #66 今天的真实投影（Phase 1/2 之后）：交付 Run #49 有快照，没有核查会来。
const ticket66: ReviewState = {
  state: 'independent_review',
  label: '独立核查未派发',
  reviewerAttemptId: null,
  verdict: null,
  reason: 'Run #49 的交付还没有被独立核查，系统不会自动派发。',
  reworkCyclesUsed: 1,
  maxReworkCycles: 1,
  reviewerHashState: 'unknown',
  supersededReview: { reviewerAttemptId: 43, verdict: 'fail', reviewedRunId: 42, supersededByRunId: 49 },
  deliveryRunId: 49,
  canRequestReview: true,
};

// #66 的两次交付：Run #42 是第 1 次，Run #49 是第 2 次（GET /v1/tickets/66/deliveries）。
const deliveries66 = deliveryNumbersOf([{ attemptId: 42, sequence: 1 }, { attemptId: 49, sequence: 2 }]);

function present(reviewState: ReviewState, overrides: Partial<TicketSummary> = {}, deliveryNumbers = deliveries66) {
  const ticket = ticketSummaryToTicket(summary({ ...overrides, reviewState }));
  return ticketStatePresentation({
    ticket,
    actions: buildTicketActionPresentation(ticket),
    outcome,
    timing: { statusDurationMs: 4_547_544_810 },
    deliveryNumbers,
  });
}

// 复核 P0-5：#66 在对话 Run #72 收尾时的投影。有 Run 在进行时服务端不派核查，所以没有缺口，也没有核查在路上。
const ticket66DuringChat: ReviewState = { ...ticket66, label: '等待独立核查', canRequestReview: false, reviewProgress: null };
const chatRun = {
  runId: 72, purpose: 'conversation' as const, label: '对话 Run #72 · 正在回答', phase: 'running' as const, elapsedMs: 40_000, stalled: false,
};

describe('ticket state presentation', () => {
  it('regression #66 P0-5: does not claim a review is about to start while a chat run is still answering', () => {
    const ticket = ticketSummaryToTicket(summary({
      reviewState: ticket66DuringChat,
      runtime: { state: 'running', lastActivityAt: '2026-10-14T09:58:40.000Z', activeAttemptId: 72 },
    }));
    const state = ticketStatePresentation({ ticket, actions: buildTicketActionPresentation(ticket), outcome, liveRun: chatRun });

    expect(state).toMatchObject({
      chip: 'Waiting for the work to end',
      headline: 'The ticket conversation is still answering. You can request an independent review after it answers.',
      automation: 'The state updates automatically after the work ends.',
    });
    // 交付列表还没读到：不知道第几次交付，只说没有核查。
    expect(state.facts).toContainEqual({ label: 'Independent review', value: 'Not reviewed' });
    expect(JSON.stringify(state)).not.toContain('Starts soon');
  });

  it('says a run is still going when the run details have not arrived yet', () => {
    // 第一屏只有 TicketSummary，Run 的列表还没读到：只说有一个 Run 在进行，不猜它是什么。
    const state = present(ticket66DuringChat, { runtime: { state: 'running', lastActivityAt: null, activeAttemptId: null } });
    expect(state.headline).toBe('Work on this ticket is still in progress. You can request an independent review after it ends.');
  });

  it('regression #66: says the delivery was never reviewed and recommends sending it to a reviewer', () => {
    const state = present(ticket66);

    expect(state).toMatchObject({
      chip: 'Review not requested',
      headline: 'Delivery 2 has no independent review yet.',
      why: 'The system does not request a review automatically. You decide the next step. The rework budget is used up.',
      automation: 'No automatic action is in progress.',
    });
    expect(state.facts).toEqual([
      { label: 'Latest delivery', value: 'Delivery 2' },
      { label: 'Independent review', value: 'Delivery 2 is not reviewed' },
      { label: 'Previous review', value: 'Failed (FAIL) · Reviewed delivery 1 · Superseded by delivery 2' },
      { label: 'Rework budget', value: '1/1 used' },
      { label: 'Unchanged for', value: '52d 15h' },
    ]);
    expect(state.options).toEqual([
      { id: 'request_review', label: 'Request independent review', consequence: 'An independent reviewer checks delivery 2.', tone: 'primary', recommended: true },
      { id: 'complete', label: 'Accept anyway', consequence: 'Close the ticket without a review verdict.', tone: 'danger', recommended: false },
      { id: 'rework', label: 'Rework manually', consequence: 'Continue the rework from delivery 2. You started this rework, so it does not use the rework budget of Paimon.', tone: 'neutral', recommended: false },
      { id: 'cancel', label: 'Cancel ticket', consequence: 'Discard this delivery and close the ticket.', tone: 'danger', recommended: false },
    ]);
  });

  it('describes a genuine deadlock without offering a reviewer', () => {
    const state = present({
      state: 'rework_exhausted',
      label: '返工已用尽且成果未登记，需要你决定',
      reviewerAttemptId: null,
      verdict: null,
      reason: '返工 1/1 已用尽；Run #50 结束后没有可登记的成果快照，自我恢复失败',
      reworkCyclesUsed: 1,
      maxReworkCycles: 1,
      outcomeRecoveryFailed: true,
      deliveryRunId: 50,
      canRequestReview: false,
    });

    expect(state).toMatchObject({ chip: 'Stuck', tone: 'danger', automation: 'No automatic action is in progress.' });
    // Run #50 没有交付快照，没有序号：不写执行记录的编号。
    expect(state.headline).toBe('The last delivery registered no outcome. Automation stopped.');
    expect(state.options.map((option) => option.id)).toEqual(['complete', 'rework', 'cancel']);
    expect(state.options.find((option) => option.id === 'complete')).toMatchObject({ label: 'Accept anyway', tone: 'danger' });
    // 没有自动动作在等着：给出推荐，底部栏才有东西可放。
    expect(state.options.find((option) => option.recommended)?.id).toBe('rework');
  });

  // 核查自动化只在出结论的那一笔事务里跑一次：FAIL 时要么打回 active 并派返工，要么停手；
  // PASS 时要么直接结单，要么停手。工单还停在 review，说明它已经停手了——#66 的 FAIL 就发生在授权之前。
  it('never promises a rework after a failed review that is still waiting in review', () => {
    const failed: ReviewState = {
      state: 'review_failed', label: 'The review failed. It waits for your decision', reviewerAttemptId: 52, verdict: 'fail',
      reason: 'unit suite red', reworkCyclesUsed: 0, maxReworkCycles: 1, deliveryRunId: 51, canRequestReview: false,
    };

    for (const state of [present(failed), present(failed, { acceptancePolicy: 'user_only', reworkPolicy: 'ask_user' })]) {
      expect(state.automation).toBe('No automatic action is in progress.');
      expect(state.options.find((option) => option.recommended)?.id).toBe('rework');
      expect(state.options.map((option) => option.id)).not.toContain('complete');
    }
  });

  it('asks the user to accept a passed review that is still waiting in review, even under delegation', () => {
    const passed: ReviewState = {
      state: 'review_passed', label: '核查通过，等待验收', reviewerAttemptId: 52, verdict: 'pass',
      reason: 'green', deliveryRunId: 51, canRequestReview: false,
    };

    for (const state of [present(passed), present(passed, { acceptancePolicy: 'user_only' })]) {
      expect(state).toMatchObject({ headline: 'The review passed. It waits for your acceptance.', automation: 'No automatic action is in progress.' });
      expect(state.options.find((option) => option.recommended)?.id).toBe('complete');
    }
  });

  it('keeps every review state free of claims that another block would contradict', () => {
    const states: ReviewState[] = [
      ticket66,
      { ...ticket66, label: '独立核查中', canRequestReview: false, reviewProgress: 'running', reason: 'The independent review is in progress.' },
      { ...ticket66, label: '独立核查排队中', canRequestReview: false, reviewProgress: 'queued', reason: '核查请求已排队，等待派发。' },
      { state: 'waiting_user', label: '等待用户验收', reviewerAttemptId: null, verdict: null, reason: null },
      { state: 'review_failed', label: 'Review failed', reviewerAttemptId: 52, verdict: 'fail', reason: 'red', reworkCyclesUsed: 1, maxReworkCycles: 1 },
      { state: 'review_passed', label: 'Review passed', reviewerAttemptId: 52, verdict: 'pass', reason: 'green' },
      { state: 'evidence_conflict', label: 'Evidence conflict', reviewerAttemptId: 52, verdict: 'fail', reason: 'evidence_conflict' },
      { state: 'rework_exhausted', label: '返工已用尽', reviewerAttemptId: 52, verdict: 'fail', reason: 'red', reworkCyclesUsed: 1, maxReworkCycles: 1 },
    ];
    for (const reviewState of states) {
      const state = present(reviewState);
      const text = [state.chip, state.headline, state.why, state.automation, ...state.facts.map((fact) => fact.value)].join(' ');
      // "未通过 / 不通过" 只在当前有效的核查确实是 FAIL 时出现。
      if (reviewState.verdict !== 'fail') expect(text, reviewState.state).not.toMatch(/未通过|不通过/);
      // 用完额度或卡死时，不能再承诺自动返工或自动交付。
      if (reviewState.canRequestReview || reviewState.state === 'rework_exhausted') {
        expect(text, reviewState.state).not.toMatch(/自动返工|自动交付|完成交付/);
      }
      // 有推荐时只推荐一个。
      expect(state.options.filter((option) => option.recommended).length, reviewState.state).toBeLessThanOrEqual(1);
      // 只有真的有核查在排队、挂起或运行时，才能说自动化会做什么；否则必须给用户一个推荐。
      const pending = reviewState.reviewProgress != null;
      if (!pending && reviewState.state !== 'independent_review') {
        expect(state.automation, reviewState.state).toBe('No automatic action is in progress.');
        expect(state.options.some((option) => option.recommended), reviewState.state).toBe(true);
      }
    }
  });

  it('tells a queued review apart from a paused one and a running one', () => {
    const base = { ...ticket66, canRequestReview: false };
    const queued = present({ ...base, label: '独立核查排队中', reviewProgress: 'queued', reason: '核查请求已排队，等待派发。' });
    const paused = present({ ...base, label: '独立核查已暂停', reviewProgress: 'suspended', reason: 'Codex 账号余额不足。' });
    const running = present({ ...base, label: '独立核查中', reviewProgress: 'running', reason: 'The independent review is in progress.' });

    expect([queued.headline, paused.headline, running.headline]).toEqual([
      'The independent review is queued. It waits to start.',
      'The independent review is queued, but it cannot start now.',
      'The independent review is in progress.',
    ]);
    expect(paused).toMatchObject({ chip: 'Review paused', tone: 'attention', why: 'Codex 账号余额不足。' });
    expect([queued, paused, running].map((state) => state.facts.find((fact) => fact.label === 'Independent review')?.value))
      .toEqual(['Queued', 'Paused', 'In progress']);
  });

  it('regression 2026-10-21: a paused review that can be re-picked is not shown as never dispatched', () => {
    // 服务端在核查挂起时也让「派发核查」可点，用来换一个能用的核查员。以前这里命中第一个分支，写成「核查未派发」。
    const paused = present({
      ...ticket66, canRequestReview: true, label: '独立核查已暂停', reviewProgress: 'suspended', reason: 'Codex 账号已停用。',
    });
    expect(paused).toMatchObject({ chip: 'Review paused', tone: 'attention', why: 'Codex 账号已停用。' });
    expect(paused.headline).not.toMatch(/还没有被独立核查/);
    expect(paused.options.find((option) => option.id === 'request_review')).toMatchObject({
      label: 'Requeue review', consequence: 'Use the original reviewer if it is available. If it is not, use another available reviewer.',
    });
  });

  // 回归（2026-10-21 审查 M4）：服务端只在有能用的核查员时才让挂起的核查能重新排。没有能用的时不给按钮，
  // 这时按钮说明里不能再写「都不能用时仍然挂起」。由用户验收的工单上，挂起的核查也写「重新排核查」，不写「派发独立核查」。
  it('regression 2026-10-21: re-picks a paused review only when the server allows it, also on a user-accepted ticket', () => {
    const none = present({
      ...ticket66, canRequestReview: false, label: '独立核查已暂停', reviewProgress: 'suspended', reason: '没有能用的核查员。',
    });
    expect(none.options.some((option) => option.id === 'request_review')).toBe(false);

    const userAccepted = present({
      state: 'waiting_user', label: '等待用户验收', reviewerAttemptId: null, verdict: null, reason: null,
      deliveryRunId: 49, canRequestReview: true, reviewProgress: 'suspended',
    }, { verificationPolicy: 'user', acceptancePolicy: 'user_only' });
    expect(userAccepted.options.find((option) => option.id === 'request_review')).toMatchObject({
      label: 'Requeue review', consequence: 'Use the original reviewer if it is available. If it is not, use another available reviewer.',
    });
  });

  it('regression #66: says the review has not started when its run has been starting for minutes', () => {
    // 你点了「派发独立核查」，核查 Run #73 停在 starting 13 分钟，状态卡却写着「独立核查正在进行」。
    const ticket = ticketSummaryToTicket(summary({ reviewState: { ...ticket66, canRequestReview: false, reviewProgress: 'running' } }));
    const liveRun = {
      runId: 73, purpose: 'review' as const, label: '核查 Run #73 · 正在准备', phase: 'starting' as const,
      elapsedMs: 13 * 60_000, stalled: true,
    };
    const state = ticketStatePresentation({ ticket, actions: buildTicketActionPresentation(ticket), outcome, liveRun });

    expect(state).toMatchObject({
      chip: 'Review did not start',
      tone: 'attention',
      headline: 'The review is still preparing after 13 min. It did not start.',
      why: 'A review usually starts in 10 seconds. It can be stuck.',
    });
    const fresh = ticketStatePresentation({
      ticket, actions: buildTicketActionPresentation(ticket), outcome, liveRun: { ...liveRun, elapsedMs: 5_000, stalled: false },
    });
    expect(fresh.headline).toBe('The independent review is in progress.');
  });

  it('offers an optional review on a user-accepted ticket without calling it stuck', () => {
    const state = present({
      state: 'waiting_user', label: '等待用户验收', reviewerAttemptId: null, verdict: null, reason: null,
      deliveryRunId: 49, canRequestReview: true, reviewProgress: null,
    }, { verificationPolicy: 'user', acceptancePolicy: 'user_only' });

    expect(state).toMatchObject({ chip: 'Waiting for acceptance', headline: 'The work is complete. It waits for your acceptance.' });
    expect(state.options.map((option) => [option.id, option.recommended])).toEqual([
      ['request_review', false],
      ['complete', true],
      ['rework', false],
      ['cancel', false],
    ]);
  });

  // release review 8：以下三条以前在 ticketComponents.test.ts 里钉着源码文本，现在断言行为。
  it('shows a running recovery in the state block, but leaves a plain running execution to the next-action copy', () => {
    const execution = (kind: 'execution' | 'recovery', label: string) => ({
      kind, state: 'running' as const, label, dispatchRequestId: null, attemptId: 50,
      reason: kind === 'recovery' ? '模型限流，30 秒后自动重试。' : null, updatedAt: null,
    });
    const presentFor = (executionState: ReturnType<typeof execution>) => {
      const ticket = ticketSummaryToTicket(summary({ stage: 'active', status: 'active', reviewState: undefined, executionState }));
      return ticketStatePresentation({ ticket, actions: buildTicketActionPresentation(ticket) });
    };

    expect(presentFor(execution('execution', 'Running'))).toMatchObject({ headline: 'The system is working' });
    expect(presentFor(execution('recovery', '正在自动恢复'))).toMatchObject({
      chip: '正在自动恢复', headline: '正在自动恢复', tone: 'info', automation: '模型限流，30 秒后自动重试。',
    });
  });

  it('prefers the execution state over a blocker record, and the blocker over the generic copy', () => {
    const blocked = (executionState?: TicketSummary['executionState']) => ticketSummaryToTicket(summary({
      stage: 'blocked', status: 'blocked', reviewState: undefined, ...(executionState ? { executionState } : {}),
    }));
    const blocker = { title: 'Run #50 交接失败', summary: '工具桥断开，交接没有送达。' };

    const recorded = blocked();
    expect(ticketStatePresentation({ ticket: recorded, actions: buildTicketActionPresentation(recorded), blocker }))
      .toMatchObject({ headline: 'Run #50 交接失败', why: '工具桥断开，交接没有送达。', tone: 'danger' });
    const failed = blocked({
      kind: 'rework', state: 'failed', label: '返工启动失败', dispatchRequestId: 7, attemptId: null,
      reason: 'Codex 账号余额不足。', updatedAt: null,
    });
    expect(ticketStatePresentation({ ticket: failed, actions: buildTicketActionPresentation(failed), blocker }))
      .toMatchObject({ headline: '返工启动失败', why: 'Codex 账号余额不足。', tone: 'danger' });
  });

  it('uses the shared next-action copy outside review', () => {
    const ticket = ticketSummaryToTicket(summary({ stage: 'active', status: 'active', reviewState: undefined }));
    const state = ticketStatePresentation({ ticket, actions: buildTicketActionPresentation(ticket) });

    expect(state).toMatchObject({ chip: ticket.statusLabel, headline: 'The system is working', tone: 'info' });
    expect(state.options.map((option) => option.label)).toEqual(['Stop', 'Cancel ticket']);
  });

  it('writes the state in Chinese when the interface language is Chinese', () => {
    const ticket = ticketSummaryToTicket(summary({ reviewState: ticket66 }), undefined, 'zh');
    const state = ticketStatePresentation({
      ticket, actions: buildTicketActionPresentation(ticket, 'zh'), outcome, deliveryNumbers: deliveries66, locale: 'zh',
    });
    expect(state).toMatchObject({
      chip: '核查未派发',
      headline: '第 2 次交付还没有独立核查。',
      why: '系统不会自动派发核查，需要你决定下一步。返工额度已用完。',
      automation: '当前没有自动动作在进行。',
    });
    expect(state.options.map((option) => option.label)).toEqual(['派发独立核查', '仍要验收通过', '手动返工', '取消工单']);
    expect(state.options.map((option) => option.consequence)).toEqual([
      '派一个独立核查员核查第 2 次交付。',
      '没有核查结论就结单。',
      '从第 2 次交付继续返工；这是你发起的返工，不占用 Paimon 的返工额度。',
      '放弃这次交付，工单结束。',
    ]);
  });

  // 设计规范 P14.6（用户 2026-11-02）：「Run #49」是系统内部的记录编号，用户在界面上找不到。交付写「第 N 次交付」；
  // 不知道第几次时写「最新的交付」，也不退回去写编号。
  it('names a delivery by its number, and never by the internal run number', () => {
    const numbered = present(ticket66);
    const unnumbered = present(ticket66, {}, deliveryNumbersOf([]));
    for (const state of [numbered, unnumbered]) {
      expect(JSON.stringify(state)).not.toMatch(/Run #\d|#4[239]\b/);
    }
    expect(unnumbered.headline).toBe('The latest delivery has no independent review yet.');
    expect(unnumbered.facts.map((fact) => fact.label)).not.toContain('Latest delivery');
    expect(unnumbered.facts).toContainEqual({ label: 'Previous review', value: 'Failed (FAIL) · Superseded by a later delivery' });
    expect(unnumbered.options.find((option) => option.id === 'rework')?.consequence)
      .toBe('Continue the rework from the latest delivery. You started this rework, so it does not use the rework budget of Paimon.');
  });

  it('offers to start again, not to continue from a delivery, when nothing was delivered', () => {
    const ticket = ticketSummaryToTicket(summary({ reviewState: { ...ticket66, deliveryRunId: null, supersededReview: null } }));
    const state = ticketStatePresentation({ ticket, actions: buildTicketActionPresentation(ticket), outcome: null });
    expect(state.options.find((option) => option.id === 'rework')?.consequence).toMatch(/^Start this ticket again\./);
  });
});
