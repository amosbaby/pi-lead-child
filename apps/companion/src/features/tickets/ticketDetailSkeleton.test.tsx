// @vitest-environment happy-dom
// 工单 12：工单详情的骨架（spec 第 3 节，4.0–4.4、4.6；第四轮画板 D4-running、D4-review-pass）。
// - 每个阶段的块顺序、默认展开、出处标签都对；没有「这张工单」标题；入口叫「关联工单」。
// - 按钮的可用状态和 GET /v1/tickets/:id/actions 一致（底部操作栏另见 ticketDecisionCard.test.tsx）。
// - 已完成的工单，「还没合并」不用警告色（原则 6）。
// 复核以后的详情和确认框在 ticketDetailReview.test.tsx；共用的数据和渲染在 test/ticketDetail.tsx。
import type { TicketAction, TicketSummary } from '@pi-lead-child/protocol';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ticketSummaryToTicket } from '@/features/workspace/model';

import { cssVar } from '../../../test/render';
import { BRIEF, criteria, delivery, expanded, openHistory, plan, renderThread, sectionOrder, summary } from '../../../test/ticketDetail';
import { setViewportWidth, ticket66, ticketAction } from '../../../test/workbench';
import type { TicketThreadProps } from './TicketThread';
import {
  briefSummary, clockText, detailActionBar, detailStage, integrationBadge, nextStepText, planSteps, reviewWentAgainst,
  reviewerStatus, sectionCollapsed,
} from './ticketDetailSections';
import { legacyTicketActions } from './legacyTicketActions';
import type { TicketStoryEntry } from './ticketStory';
import { resetRememberedSectionsForTesting } from './useRememberedSections';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

beforeEach(() => {
  setViewportWidth(1280);
  localStorage.clear();
  resetRememberedSectionsForTesting();
});

afterEach(() => {
  cleanup();
  setViewportWidth(0);
});

describe('the ticket detail skeleton', () => {
  // 画布 M3（2026-11-15）：页面在「验收标准」「经过与记录」两行收尾。工单信息、交付在「经过与记录」里；执行一块没有了，
  // 计划单独一块，token 的四部分在属性的 Token 明细里，每次执行在完整记录里。
  it('runs the sections in one order while the ticket runs, with the plan open and the records folded at the end', () => {
    const thread = renderThread(summary({ stage: 'active', status: 'active' }));

    expect(sectionOrder(thread)).toEqual(['relations', 'task', 'criteria', 'history']);
    for (const kind of ['criteria', 'history']) expect(expanded(thread, kind)).toBe(false);
    expect(within(thread).getByTestId('ticket-section-plan')).toBeTruthy();
    for (const gone of ['ticket-section-execution', 'ticket-section-delivery', 'ticket-execution-now']) {
      expect(within(thread).queryByTestId(gone)).toBeNull();
    }

    // 工单信息在「经过与记录」里面。
    openHistory(thread);
    expect(sectionOrder(thread)).toEqual(['relations', 'task', 'criteria', 'history', 'info']);
  });

  it('opens the criteria while the ticket waits for acceptance, and sums up the folded records with the latest event', () => {
    const story: TicketStoryEntry[] = [
      { key: 'a', tone: 'neutral', title: '开始执行', detail: null, at: '2026-10-21T07:03:04.000Z', until: null, runs: [] },
      { key: 'b', tone: 'accent', title: '第 1 次交付', detail: null, at: '2026-10-21T07:18:55.000Z', until: null, runs: [] },
    ];
    const thread = renderThread(summary({ stage: 'review', status: 'review' }), {
      story,
      outcome: {
        latest: {
          id: 9, executorAttemptId: 118, summary: '调研发现 aish 做 PR 审查没有专门触发入口。', deliverables: [], validations: [],
          completeness: 'complete', missingFields: [], createdAt: '2026-10-21T07:18:55.000Z',
        },
      } as unknown as TicketThreadProps['outcome'],
    });

    expect(sectionOrder(thread)).toEqual(['relations', 'task', 'criteria', 'history']);
    expect(expanded(thread, 'criteria')).toBe(true);
    expect(expanded(thread, 'history')).toBe(false);
    // 折叠后标题行右边写最近的一件事，不写事件数。
    expect(within(thread).getByTestId('ticket-section-history-toggle').textContent)
      .toContain(`${clockText('2026-10-21T07:18:55.000Z')} 第 1 次交付`);

    // 交付的内容在「经过与记录」里。
    const history = openHistory(thread);
    expect(within(history).getByTestId('ticket-delivery-summary').textContent).toContain('调研发现 aish 做 PR 审查没有专门触发入口。');
  });

  it('opens only the records, with the delivery inside, once the ticket is done', () => {
    const thread = renderThread(summary({ stage: 'done', status: 'done' }), {
      outcome: {
        latest: {
          id: 9, executorAttemptId: 118, summary: '交付了三项产物。', deliverables: [], validations: [],
          completeness: 'complete', missingFields: [], createdAt: '2026-10-21T07:18:55.000Z',
        },
      } as unknown as TicketThreadProps['outcome'],
    });

    expect(expanded(thread, 'history')).toBe(true);
    expect(expanded(thread, 'criteria')).toBe(false);
    expect(within(thread).getByTestId('ticket-delivery-summary').textContent).toContain('交付了三项产物。');
  });

  it('leaves out the execution and the delivery for a draft that never ran', () => {
    const thread = renderThread(summary({ stage: 'draft', status: 'draft', hasRun: false }));

    expect(sectionOrder(thread)).toEqual(['relations', 'task', 'criteria', 'history']);
    expect(within(thread).queryByTestId('ticket-delivery-summary')).toBeNull();
  });

  it('labels where each block comes from', () => {
    const thread = renderThread(summary({ stage: 'active', status: 'active' }));

    expect(within(thread).getByTestId('ticket-section-task').textContent).toContain('Written by Paimon');
    // 折叠行展开时，出处写在标题行右边。
    fireEvent.click(within(thread).getByTestId('ticket-section-criteria-toggle'));
    expect(within(thread).getByTestId('ticket-section-criteria-toggle').textContent).toContain('Written by Paimon');
    openHistory(thread);
    expect(within(thread).getByTestId('ticket-section-info').textContent).toContain('System record');
    expect(within(thread).getByTestId('ticket-history-story').textContent).toContain('System record');
  });

  // token 按计费拆开（用户 2026-11-06）：缓存读、缓存写、未缓存输入和输出的价钱差很多。四个数在属性里 Token 一行的明细里（画布 M3）。
  it('shows the four billed parts of the tokens in the token details, and nothing without a breakdown', async () => {
    const facts = {
      createdAt: '2026-10-21T07:02:00.000Z', createdBy: 'lead' as const, updatedAt: '2026-10-21T07:06:00.000Z', dueAt: null,
      totalTokens: 6_081_433, totalCostUsd: 2.58, tokenBudget: null, costBudgetUsd: null,
      usageParts: {
        uncachedInputTokens: 134, cacheWriteTokens: 296_699, cacheReadTokens: 5_631_822, outputTokens: 52_778, unsplitTokens: 100_000,
      },
    };
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), { facts });
    fireEvent.click(within(thread).getByTestId('ticket-token-details'));
    const details = (await screen.findByTestId('ticket-token-details-panel')).textContent;
    expect(screen.getByTestId('ticket-usage-parts')).toBeTruthy();
    expect(details).toContain('Uncached input');
    expect(details).toContain('Cache reads');
    expect(details).toContain('about 5.6M');
    expect(details).toContain('About 100K tokens from before this split have no breakdown.');
    cleanup();

    const zh = renderThread(summary({ stage: 'active', status: 'active' }), { facts }, 'zh');
    fireEvent.click(within(zh).getByTestId('ticket-token-details'));
    expect((await screen.findByTestId('ticket-token-details-panel')).textContent).toContain('缓存读');
    cleanup();

    // 没有明细的工单：Token 一行写总数，圆圈里的 i 也在（2026-11-15）；四部分的明细不画。
    const old = renderThread(summary({ stage: 'active', status: 'active' }));
    expect(within(old).getByTestId('ticket-token-details')).toBeTruthy();
    expect(screen.queryByTestId('ticket-usage-parts')).toBeNull();
  });

  // 2026-11-15：旧工单的用量没有缓存的拆分，Token 一行整个不见了。没有拆分时也写一行总数。
  it('still shows a Token row with the total when the usage has no cache breakdown', async () => {
    const facts = {
      createdAt: '2026-10-21T07:02:00.000Z', createdBy: 'lead' as const, updatedAt: '2026-10-21T07:06:00.000Z', dueAt: null,
      totalTokens: 5_300_000, totalCostUsd: 3.67, tokenBudget: null, costBudgetUsd: null,
      usageParts: { uncachedInputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, unsplitTokens: 5_300_000 },
    };
    const thread = renderThread(summary({ stage: 'review', status: 'review' }), { facts });
    expect(within(thread).getByTestId('ticket-attributes').textContent).toContain('about 5.3M');
    // 圆圈里的 i 照样在：明细里说这些用量没有拆分。
    fireEvent.click(within(thread).getByTestId('ticket-token-details'));
    expect((await screen.findByTestId('ticket-token-breakdown')).textContent).toContain('No breakdown');
  });

  // 2026-11-15：只由你验收的工单也画了核查员那一列，一排「—」把标准的文字挤成窄窄一条。
  it('draws the reviewer column of the criteria only when the ticket has a reviewer', () => {
    const delivered = criteria({ delivery: { sequence: 1, attemptId: 118, deliveredAt: '2026-10-21T07:18:55.000Z', latest: true } });
    const alone = renderThread(summary({ stage: 'review', status: 'review' }), { acceptanceCriteria: delivered, reviewer: null });
    expect(within(alone).getByTestId('ticket-criteria').textContent).not.toContain('Reviewer');
    expect(within(alone).getByTestId('ticket-criteria').textContent).toContain('You');
    cleanup();

    const reviewed = renderThread(summary({ stage: 'review', status: 'review' }), {
      acceptanceCriteria: delivered, reviewer: { runtime: 'Codex', model: null, effort: null, status: 'done' },
    });
    expect(within(reviewed).getByTestId('ticket-criteria').textContent).toContain('Reviewer');
  });

  // 2026-11-15 用户：从会话的工单卡打开详情，页面会重排。详情还没读到时，任务说明、关联、Token、执行计划先画同高的占位。
  it('holds the place of the brief, relations, tokens and plan while the ticket detail loads', () => {
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), { taskDescription: undefined, executionPlan: undefined });
    expect(within(thread).getByTestId('ticket-task-placeholder')).toBeTruthy();
    expect(within(thread).getByTestId('ticket-relations-placeholder')).toBeTruthy();
    expect(within(thread).getByTestId('ticket-plan-placeholder')).toBeTruthy();
    expect(within(thread).getByTestId('ticket-attributes').textContent).toContain('Tokens');
    cleanup();

    const loaded = renderThread(summary({ stage: 'active', status: 'active' }));
    expect(within(loaded).queryByTestId('ticket-task-placeholder')).toBeNull();
    expect(within(loaded).queryByTestId('ticket-relations-placeholder')).toBeNull();
  });

  it('has no 这张工单 heading and calls the relation entry 关联工单', () => {
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), {
      actions: [ticketAction('link', { label: 'Link ticket' })],
    });

    expect(within(thread).queryByText('这张工单')).toBeNull();
    expect(thread.textContent).not.toContain('New relation');
    const relations = within(thread).getByTestId('ticket-section-relations');
    expect(within(relations).getByTestId('ticket-link-open').textContent).toBe('Link ticket');
    expect(within(relations).getByTestId('ticket-split-request').textContent).toBe('Split into child tickets');
  });

  it('asks Lead to split the ticket by prefilling the ticket chat', () => {
    const onPrefillChat = vi.fn();
    const onChatExpandedChange = vi.fn();
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), { onPrefillChat, onChatExpandedChange });

    fireEvent.click(within(thread).getByTestId('ticket-split-request'));

    expect(onPrefillChat).toHaveBeenCalledWith('Split #102 into child tickets:');
    expect(onChatExpandedChange).toHaveBeenCalledWith(true);
  });

  it('remembers a folded block on this device by its kind, for every ticket', () => {
    renderThread(summary({ stage: 'active', status: 'active' }));
    fireEvent.click(screen.getByTestId('ticket-section-criteria-toggle'));
    expect(expanded(screen.getByTestId('ticket-thread'), 'criteria')).toBe(true);
    expect(JSON.parse(localStorage.getItem('pi-lead-child.ticket-detail-sections.v1') ?? '{}')).toEqual({ criteria: false });
    cleanup();

    const other = renderThread(summary({ id: 103, stage: 'active', status: 'active' }));

    expect(expanded(other, 'criteria')).toBe(true);
    expect(expanded(other, 'history')).toBe(false);
  });

  it('reads the remembered blocks back from this device', async () => {
    localStorage.setItem('pi-lead-child.ticket-detail-sections.v1', JSON.stringify({ history: false }));
    resetRememberedSectionsForTesting();
    const thread = renderThread(summary({ stage: 'active', status: 'active' }));
    await act(async () => { await Promise.resolve(); });

    expect(expanded(thread, 'history')).toBe(true);
  });

  it('shows the plan with the step in progress as the current step', () => {
    const thread = renderThread(summary({ stage: 'active', status: 'active' }));
    const planBlock = within(thread).getByTestId('ticket-section-plan');

    expect(within(planBlock).getByLabelText('In progress')).toBeTruthy();
    // 跳过的步骤不算进分母（和 planSummary、engine 的 executionPlanText 一样）。
    expect(planBlock.textContent).toContain('1 / 2');
    expect(planBlock.textContent).toContain('Skipped: 宿主架构层已经做对');
  });

  it('says so when the executing agent submitted no plan', () => {
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), { executionPlan: null });

    expect(within(thread).getByTestId('ticket-section-plan').textContent).toContain('The executor did not submit a plan.');
  });

  it('lets you confirm a criterion only when the action list allows it', () => {
    const delivered = criteria({ delivery: { sequence: 1, attemptId: 118, deliveredAt: '2026-10-21T07:18:55.000Z', latest: true } });
    const onRunAction = vi.fn();
    const thread = renderThread(summary({ stage: 'review', status: 'review' }), {
      acceptanceCriteria: delivered,
      actions: [ticketAction('confirm_criterion', { label: '确认一条验收标准' }), ticketAction('unconfirm_criterion', { label: '取消确认' })],
      onRunAction,
    });

    fireEvent.click(within(thread).getByTestId('ticket-criteria-check-2'));

    expect(onRunAction).toHaveBeenCalledWith('confirm_criterion', { input: { criterionId: 2, deliverySequence: 1 } });
    cleanup();

    const locked = renderThread(summary({ stage: 'review', status: 'review' }), {
      acceptanceCriteria: delivered,
      actions: [
        ticketAction('confirm_criterion', { available: false, reason: '最新一次交付的快照还没存好。' }),
        ticketAction('unconfirm_criterion', { available: false, reason: '最新一次交付的快照还没存好。' }),
      ],
      onRunAction,
    });
    expect(within(locked).getByTestId('ticket-criteria-check-2').getAttribute('aria-disabled')).toBe('true');
  });

  it('shows the header actions from the action list, with the reason when one cannot be done', async () => {
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), {
      ticketLink: 'http://127.0.0.1:47130/ticket/102',
      actions: [
        ticketAction('set_priority', { label: '改优先级' }),
        ticketAction('set_project', { label: '改项目', available: false, reason: '这张工单是子工单，项目跟着父工单。' }),
        ticketAction('link', { label: 'Link ticket' }),
      ],
    });

    fireEvent.click(within(thread).getByTestId('ticket-header-more'));
    const panel = await screen.findByTestId('ticket-header-more-panel');

    // 复制的是完整的地址，不只是 /ticket/102。
    expect(within(panel).getByTestId('ticket-copy-link').textContent).toContain('http://127.0.0.1:47130/ticket/102');
    expect(within(panel).getByTestId('ticket-header-set_priority').getAttribute('role')).toBe('button');
    expect(within(panel).getByTestId('ticket-header-set_project').textContent).toContain('这张工单是子工单，项目跟着父工单。');
    expect(within(panel).getByTestId('ticket-header-set_project').getAttribute('role')).not.toBe('button');
  });

  it('principle 6: a done ticket shows 还没合并 in the neutral grey, not the warning colour', () => {
    const thread = renderThread(summary({ stage: 'done', status: 'done' }), { delivery: delivery('unmerged') });
    // 工作区一行在「经过与记录」的工单信息里；已完成时它默认展开。
    const info = within(openHistory(thread)).getByTestId('ticket-section-info');
    const label = within(info).getByText('Not merged');

    // 中性徽章：灰底、次要文字色（Badge 的 neutral）。
    expect(getComputedStyle(label).color).toBe(cssVar('--c-text-secondary'));
    expect(getComputedStyle(label.parentElement!).backgroundColor).toBe(cssVar('--c-surface-muted'));
  });

  it('does not hang 还没合并 on the workspace while the ticket runs', () => {
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), { delivery: delivery('unmerged') });

    expect(within(openHistory(thread)).getByTestId('ticket-section-info').textContent).toContain('plc/item-102-d2d16749');
    expect(within(thread).queryByText('Not merged')).toBeNull();
  });

  it('cancelled: keeps the order, opens only the records, and says there is nothing to do', () => {
    const thread = renderThread(summary({ stage: 'cancelled', status: 'cancelled' }));

    expect(sectionOrder(thread)).toEqual(['relations', 'task', 'criteria', 'history', 'info']);
    expect(expanded(thread, 'history')).toBe(true);
    expect(expanded(thread, 'criteria')).toBe(false);
    // 没有交付，「经过与记录」里不画交付的摘要。
    expect(within(thread).queryByTestId('ticket-delivery-summary')).toBeNull();
    // 没有要你做的事时不出决定卡（主题 11.21，2026-11-15）。
    expect(within(thread).queryByTestId('ticket-decision-card')).toBeNull();
  });

  it('draft: opens what the ticket is about and starts it with 确认开跑', () => {
    const onRunAction = vi.fn();
    const thread = renderThread(summary({ stage: 'draft', status: 'draft', hasRun: false }), {
      actions: [ticketAction('confirm', { label: '确认开跑' }), ticketAction('cancel', { label: 'Cancel ticket' })],
      onRunAction,
    });

    // 草稿：验收标准和执行计划展开，开跑前要确认；经过与记录收着。
    for (const kind of ['criteria', 'plan']) expect(expanded(thread, kind)).toBe(true);
    expect(expanded(thread, 'history')).toBe(false);
    fireEvent.click(within(thread).getByTestId('ticket-bar-confirm'));

    expect(onRunAction).toHaveBeenCalledWith('confirm', {});
  });

  it('done: keeps the same order of blocks', () => {
    const thread = renderThread(summary({ stage: 'done', status: 'done' }));

    expect(sectionOrder(thread)).toEqual(['relations', 'task', 'criteria', 'history', 'info']);
  });
});

// 独立审查（2026-10-22）以后的修复。每条一个测试。

describe('ticketDetailSections', () => {
  const actions: TicketAction[] = [
    ticketAction('pause_run', { label: '暂停', available: false, reason: '没有正在运行的 Run 可以暂停。' }),
    ticketAction('resume_run', { label: '继续' }),
    ticketAction('stop_run', { label: '停下' }),
    ticketAction('cancel', { label: 'Cancel ticket' }),
    ticketAction('abandon', { label: '放弃改动', available: false, reason: '没有改动。' }),
  ];

  it('reads the stage from TicketSummary only', () => {
    expect(detailStage('active')).toBe('running');
    expect(detailStage('blocked')).toBe('running');
    expect(detailStage('review')).toBe('review');
    expect(detailStage('done')).toBe('done');
    expect(detailStage('cancelled')).toBe('cancelled');
  });

  it('lets your own choice override the stage default', () => {
    expect(sectionCollapsed('review', 'task')).toBe(true);
    expect(sectionCollapsed('review', 'task', { task: false })).toBe(false);
    expect(sectionCollapsed('done', 'history')).toBe(false);
    expect(sectionCollapsed('done', 'criteria')).toBe(true);
  });

  it('puts whichever of pause and resume can be done in the same slot, and only doable actions in 更多', () => {
    const bar = detailActionBar('running', actions);

    expect(bar.primary).toBeNull();
    expect(bar.secondary?.id).toBe('resume_run');
    expect(bar.more.map((action) => action.id)).toEqual(['stop_run', 'cancel']);
  });

  it('keeps an unavailable action in its slot, disabled with its reason', () => {
    const bar = detailActionBar('running', actions.filter((action) => action.id !== 'resume_run'));

    expect(bar.secondary?.id).toBe('pause_run');
    expect(bar.secondary?.available).toBe(false);
  });

  it('sums up a folded brief with its first line of prose, not a heading', () => {
    expect(briefSummary(BRIEF, '摘要')).toBe('当前 aish 在执行代码审查时存在严重的 Token 消耗过度与效率低下问题。');
    expect(briefSummary('## 只有标题', '摘要')).toBe('只有标题');
    expect(briefSummary('', '摘要')).toBe('摘要');
  });

  it('gives the reviewer one of the six states, also after the ticket left review', () => {
    const independent = { verificationPolicy: 'independent_reviewer' as const, reviewState: undefined };
    expect(reviewerStatus({ verificationPolicy: 'lead_static', reviewState: undefined }, null)).toBeNull();
    expect(reviewerStatus(independent, null)).toBe('after_delivery');
    expect(reviewerStatus(independent, { state: 'settled', errorCode: null })).toBe('done');
    expect(reviewerStatus(independent, { state: 'settled', errorCode: 'account_deactivated' })).toBe('failed');
    expect(reviewerStatus(independent, { state: 'crashed' })).toBe('failed');
    expect(reviewerStatus(independent, { state: 'running' })).toBe('after_delivery');
    expect(reviewerStatus({ ...independent, reviewState: { ...ticket66().reviewState!, reviewProgress: 'suspended' } as never }, null)).toBe('suspended');
  });

  it('maps in_progress to the current step', () => {
    expect(planSteps(plan).map((step) => step.state)).toEqual(['done', 'current', 'skipped']);
  });

  it('never paints 还没合并 with a warning or danger tone, and hangs no badge before delivery', () => {
    for (const stage of ['review', 'done', 'cancelled'] as const) {
      expect(integrationBadge(stage, 'unmerged')).toEqual({ label: 'Not merged', tone: 'neutral' });
    }
    expect(integrationBadge('running', 'unmerged')).toBeNull();
    expect(integrationBadge('running', 'conflict')?.tone).toBe('danger');
    expect(integrationBadge('done', 'conflict')?.tone).toBe('neutral');
    expect(integrationBadge('review', 'conflict')?.tone).toBe('danger');
  });

  it('recommends rework, not acceptance, when the review went against the delivery', () => {
    const review = (state: string) => ({ status: 'review' as const, reviewState: { state } as never });
    expect(reviewWentAgainst(review('review_failed'))).toBe(true);
    expect(reviewWentAgainst(review('evidence_conflict'))).toBe(true);
    expect(reviewWentAgainst(review('rework_exhausted'))).toBe(true);
    expect(reviewWentAgainst(review('review_passed'))).toBe(false);
    const bar = detailActionBar('review', [ticketAction('complete'), ticketAction('rework')], { reviewAgainst: true });
    expect(bar.primary?.id).toBe('rework');
    expect(bar.more.map((action) => action.id)).toEqual(['complete']);
  });

  it('says where a stuck running ticket stopped', () => {
    const input = {
      stage: 'running' as const, ticket: { status: 'active' as const }, agentName: 'Claude Code', paused: false,
      decisionHeadline: '派发失败', integration: null, pullRequestUrl: null,
    };
    expect(nextStepText({ ...input, stuck: false })).toBe('Claude Code continues. You do not need to do anything now');
    expect(nextStepText({ ...input, stuck: true })).toBe('派发失败');
  });
});

// 恢复、开始执行、撤回确认、释放工作区还不在操作清单里，先走旧接口、用旧的判断（legacyTicketActions.ts）。
// P03/P04 把它们登记进操作层以后，页面改读清单：这几条测试会提醒删掉旧的判断。
describe('legacy actions (not in the action list yet)', () => {
  const ids = (overrides: Partial<TicketSummary>, cancelledChildCount = 0) =>
    legacyTicketActions(ticketSummaryToTicket(summary(overrides)), { cancelledChildCount }).map((action) => action.id);
  const isolated = { id: 7, ownerTicketId: 102, mode: 'isolated', kind: 'isolated_child', state: 'active', inherited: false } as const;

  it('offers what the old judgement allows, and nothing else', () => {
    expect(ids({ stage: 'cancelled', status: 'cancelled' })).toEqual(['restore']);
    expect(ids({ stage: 'ready', status: 'ready', workspace: { ...isolated, availableActions: [] } })).toEqual(['start', 'unconfirm']);
    expect(ids({ stage: 'active', status: 'active', workspace: { ...isolated, availableActions: ['release'] } })).toEqual(['release']);
    // 旧的判断说不能做的不出现：执行中没有可释放的工作区，受阻时不给开始，已完成什么都没有。
    expect(ids({ stage: 'active', status: 'active', workspace: { ...isolated, availableActions: [] } })).toEqual([]);
    expect(ids({ stage: 'blocked', status: 'blocked', workspace: { ...isolated, availableActions: [] } })).toEqual([]);
    expect(ids({ stage: 'done', status: 'done', workspace: { ...isolated, availableActions: [] } })).toEqual([]);
    // 草稿下面还有已取消的子工单：继续恢复。
    expect(ids({ stage: 'draft', status: 'draft', hasRun: false }, 2)).toEqual(['restore']);
  });

  it('puts them into 更多 and restores a cancelled ticket after a confirmation, through the old route', async () => {
    const onLegacyAction = vi.fn();
    const ticket = summary({ stage: 'cancelled', status: 'cancelled' });
    const thread = renderThread(ticket, {
      legacyActions: legacyTicketActions(ticketSummaryToTicket(ticket)),
      onLegacyAction,
    });
    // 已取消的工单不出决定卡，旧接口的操作并进顶栏的「⋯」（主题 11.21，2026-11-15）；确认框出在决定卡里。
    fireEvent.click(within(thread).getByTestId('ticket-header-more'));
    const menu = await screen.findByTestId('ticket-header-more-panel');
    fireEvent.click(within(menu).getByTestId('ticket-bar-menu-restore'));
    const confirm = within(thread).getByTestId('ticket-confirm');

    expect(confirm.textContent).toContain('Restore this ticket?');
    expect(onLegacyAction).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByText('Restore'));
    expect(onLegacyAction).toHaveBeenCalledWith('restore', { restoreMode: 'review_tree' });
  });

  it('starts a ready ticket from 更多 without a confirmation', async () => {
    const onLegacyAction = vi.fn();
    const ticket = summary({ stage: 'ready', status: 'ready' });
    const thread = renderThread(ticket, { legacyActions: legacyTicketActions(ticketSummaryToTicket(ticket)), onLegacyAction });
    fireEvent.click(within(thread).getByTestId('ticket-header-more'));
    fireEvent.click(within(await screen.findByTestId('ticket-header-more-panel')).getByTestId('ticket-bar-menu-start'));

    expect(onLegacyAction).toHaveBeenCalledWith('start');
  });
});

// 界面语言（2026-11-01）：缺省英文；外观偏好选了中文时，工单详情整页按中文写。
describe('the ticket detail in Chinese', () => {
  it('writes the section titles, the sources and the next step in Chinese', () => {
    const thread = renderThread(summary({ stage: 'active', status: 'active' }), {}, 'zh');
    const header = (kind: string) => within(thread).getByTestId(`ticket-section-${kind}-toggle`).textContent;

    const task = within(thread).getByTestId('ticket-section-task').textContent;
    expect(task).toContain('任务说明');
    expect(task).toContain('Paimon 写的');
    expect(header('history')).toContain('经过与记录');
    expect(within(thread).getByTestId('ticket-section-relations').textContent).toContain('关联工单');
  });
});
