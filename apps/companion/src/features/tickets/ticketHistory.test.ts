import type { ActivityDto, TicketDetail, TicketSummary } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import type { AttemptEntity } from '@/state/types';

import {
  buildAttemptPresentation,
  buildLifecyclePresentation,
  buildRelationPresentation,
  selectDisplayedAttemptId,
  truncateText,
} from './ticketHistory';

const summary: TicketSummary = {
  id: 19, title: '恢复工单', summary: '', kind: 'task', stage: 'ready', status: 'ready',
  hasRun: false, priority: 'normal', project: null, dueAt: null, deferUntil: null,
  updatedAt: '2026-08-11T03:00:00.000Z',
  parentTicketId: null, rootTicketId: 19,
  runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
  attention: { pendingApprovalCount: 0, blockerCount: 0 },
};

const detail: TicketDetail = {
  ticket: summary, brief: '', body: '', workdir: null,
  createdAt: '2026-08-11T00:00:00.000Z', totalTokens: 0, totalCostUsd: 0, remindAt: null,
  createdBy: 'lead', relations: [],
};

function transition(id: number, from: string, to: string, reason?: string): ActivityDto {
  return {
    id, ticketId: 19, attemptId: null, actor: to === 'cancelled' ? 'lead' : 'system',
    kind: 'transition', payload: { from, to, ...(reason === undefined ? {} : { reason }) },
    sessionCursor: null, createdAt: `2026-08-11T0${id}:00:00.000Z`,
  };
}

function failedAttempt(id: number, errorMessage: string | null): AttemptEntity {
  return {
    id, ticketId: 38, role: 'executor', state: 'crashed', model: id === 1 ? 'gpt-5' : null,
    runtime: id === 1 ? 'codex' : null, purpose: 'execution', exitCode: 1,
    effort: null, errorCode: errorMessage ? 'runtime_error' : null, errorMessage,
    startedAt: `2026-08-11T0${id}:00:00.000Z`, endedAt: `2026-08-11T0${id}:01:00.000Z`,
    kernel: null,
  };
}

describe('ticket history presentation', () => {
  it('prefers a live attempt over a stale workbench pointer', () => {
    expect(selectDisplayedAttemptId([
      { id: 27, state: 'settled' },
      { id: 30, state: 'running' },
    ], 27)).toBe(30);
    expect(selectDisplayedAttemptId([
      { id: 27, state: 'settled' },
      { id: 30, state: 'crashed' },
    ], 27)).toBe(30);
    expect(selectDisplayedAttemptId([], 27)).toBe(27);
  });

  it('keeps cancellation and restoration visible for a ready ticket with no runs', () => {
    const lifecycle = buildLifecyclePresentation({
      ticketId: 19,
      leadName: 'Paimon',
      detail,
      activities: [
        transition(1, 'draft', 'cancelled', '需求暂缓'),
        transition(2, 'cancelled', 'draft', 'restored root item by user'),
        transition(3, 'draft', 'ready', 'restore plan confirmed by user'),
      ],
    });

    expect(lifecycle.map((item) => item.title)).toEqual([
      'Created the ticket',
      'Cancelled (draft → cancelled)',
      'Waiting for confirmation (cancelled → draft)',
      'Confirmed / ready (draft → ready)',
    ]);
    expect(buildAttemptPresentation([])).toEqual([]);
    expect(lifecycle[1]).toMatchObject({ actor: 'Paimon', reason: '需求暂缓', sourceTicketId: 19 });
  });

  it('keeps rework dispatch, attempt start, and blockers visible in the lifecycle', () => {
    const lifecycle = buildLifecyclePresentation({
      ticketId: 19,
      leadName: 'Paimon',
      detail,
      activities: [
        {
          id: 4, ticketId: 19, attemptId: null, actor: 'user', kind: 'decision',
          payload: { decision: 'rework_dispatch_requested', reason: '测试失败', dispatchRequestId: 8 },
          sessionCursor: null, createdAt: '2026-08-11T04:00:00.000Z',
        },
        {
          id: 5, ticketId: 19, attemptId: 30, actor: 'system', kind: 'attempt_start',
          payload: { runtime: 'codex', model: 'gpt-5' },
          sessionCursor: null, createdAt: '2026-08-11T05:00:00.000Z',
        },
        {
          id: 6, ticketId: 19, attemptId: 30, actor: 'system', kind: 'notification',
          payload: { title: 'Run dispatch failed', summary: 'runtime missing' },
          sessionCursor: null, createdAt: '2026-08-11T06:00:00.000Z',
        },
      ],
    });

    expect(lifecycle.map((item) => item.title)).toEqual([
      'Created the ticket',
      'Rework is requested and waits for dispatch',
      'Execution started',
      'Run dispatch failed',
    ]);
    expect(lifecycle[2]).toMatchObject({ reason: 'codex · gpt-5', attemptId: 30 });
    expect(lifecycle[3]).toMatchObject({ reason: 'runtime missing' });
  });

  // 工单 #66：resume 的会话已经不存在，内核在同一个 Run 里开了新会话。时间线上说清楚发生了什么。
  it('names the fresh session that replaced an expired runtime session', () => {
    const reason = 'Claude Code 原来的会话 20fd5938 已经不存在（CLI 按保留期删除了它的记录）。这个 Run 开了一个新会话。';
    const lifecycle = buildLifecyclePresentation({
      ticketId: 66,
      leadName: 'Paimon',
      detail,
      activities: [{
        id: 727, ticketId: 66, attemptId: 71, actor: 'system', kind: 'decision',
        payload: { decision: 'runtime_session_expired', expiredSessionId: '20fd5938', runtime: 'claude', reason },
        sessionCursor: null, createdAt: '2026-10-13T11:02:01.000Z',
      }],
    });

    expect(lifecycle[1]).toMatchObject({ title: 'The old session expired. A new session started', reason, attemptId: 71 });
  });

  it('projects multiple failed runs and tolerates missing optional fields', () => {
    const attempts = buildAttemptPresentation([
      failedAttempt(2, null),
      failedAttempt(1, '模型进程退出'),
    ]);

    expect(attempts.map((item) => item.id)).toEqual([1, 2]);
    expect(attempts[0]).toMatchObject({ runtime: 'codex', model: 'gpt-5', result: 'Failed (exit 1)' });
    expect(attempts[1]).toMatchObject({ runtime: 'Unknown executor', model: 'Model not recorded', failureFull: null });
    expect(attempts[0]?.choice).toBe('codex · gpt-5');
  });

  // Lead 按任务选 runtime、模型和 effort（2026-10-15）。Run 上记着这三样，执行记录和运行日志都写出来。
  it('names the effort a run used next to its runtime and model', () => {
    const [attempt] = buildAttemptPresentation([{ ...failedAttempt(1, null), model: 'gpt-6.1-sol', effort: 'high' }]);
    expect(attempt).toMatchObject({ effort: 'high', choice: 'codex · gpt-6.1-sol · effort high' });

    const lifecycle = buildLifecyclePresentation({
      ticketId: 19,
      leadName: 'Paimon',
      detail,
      activities: [{
        id: 5, ticketId: 19, attemptId: 30, actor: 'system', kind: 'attempt_start',
        payload: { runtime: 'claude', model: 'opus', effort: 'max' },
        sessionCursor: null, createdAt: '2026-08-11T05:00:00.000Z',
      }],
    });
    expect(lifecycle[1]).toMatchObject({ title: 'Execution started', reason: 'claude · opus · effort max' });
  });

  // 设计规范 P14.6：开始、失败的那一行写这次是做什么的，不写 Run 的编号。
  it('names what a run was for when it starts or fails, without its run number', () => {
    const activities: ActivityDto[] = [
      {
        id: 5, ticketId: 19, attemptId: 31, actor: 'system', kind: 'attempt_start',
        payload: { runtime: 'codex' }, sessionCursor: null, createdAt: '2026-08-11T05:00:00.000Z',
      },
      {
        id: 6, ticketId: 19, attemptId: 31, actor: 'system', kind: 'crash',
        payload: { reason: 'exit 1' }, sessionCursor: null, createdAt: '2026-08-11T05:10:00.000Z',
      },
    ];
    const facts = new Map([[31, { purpose: 'review' as const }]]);
    const titles = (locale: 'en' | 'zh') => buildLifecyclePresentation({ ticketId: 19, leadName: 'Paimon', activities, facts, locale })
      .map((item) => item.title);

    expect(titles('en')).toEqual(['Review started', 'Review failed']);
    expect(titles('zh')).toEqual(['核查开始', '核查失败']);
  });

  it('labels relation provenance without merging another ticket history', () => {
    const relatedDetail: TicketDetail = {
      ...detail,
      relations: [
        {
          ticketId: 38,
          kind: 'relates_to',
          sourceTicketId: 19,
          targetTicketId: 38,
          relationId: 7,
          source: 'ticket_relations',
          active: true,
          createdBy: 'lead',
          createdAt: '2026-08-11T03:00:00.000Z',
          reason: 'same investigation',
        },
        {
          ticketId: 40,
          kind: 'implemented_by',
          sourceTicketId: 40,
          targetTicketId: 19,
          relationId: 8,
          source: 'ticket_relations',
          executionGate: 'target_done',
          active: false,
          createdBy: 'child',
          createdByAttemptId: 2,
          createdAt: '2026-08-11T04:00:00.000Z',
          reason: 'implementation based on this ticket',
          revokedAt: '2026-08-11T05:00:00.000Z',
          revokedBy: 'lead',
          revokeReason: 'superseded by a newer implementation',
        },
      ],
    };
    const tickets = [
      summary,
      { ...summary, id: 38, title: '失败执行 A' },
      { ...summary, id: 40, title: '失败执行 B', stage: 'done' as const, status: 'done' as const },
    ];

    expect(buildRelationPresentation(relatedDetail, tickets, 'Paimon')).toEqual([
      expect.objectContaining({
        ticketId: 40,
        label: 'Implementation task',
        groupLabel: 'Implementation',
        sourceTicketId: 40,
        title: '失败执行 B',
        stateLabel: 'Revoked',
        detail: expect.stringContaining('#40 is done'),
      }),
      expect.objectContaining({
        ticketId: 38,
        label: 'Related',
        groupLabel: 'Related',
        sourceTicketId: 19,
        title: '失败执行 A',
        stateLabel: 'Active',
        detail: 'Reason: same investigation',
      }),
    ]);
  });

  it('writes the lifecycle in Chinese when the interface language is Chinese', () => {
    const lifecycle = buildLifecyclePresentation({ ticketId: 19, leadName: 'Paimon', detail, activities: [], locale: 'zh' });
    expect(lifecycle.map((item) => item.title)).toEqual(['创建工单']);
  });

  it('safely truncates long failure text and preserves the expandable full value', () => {
    const longFailure = `${'失败信息🙂'.repeat(80)}\nsecret-looking-but-auditable`;
    const [attempt] = buildAttemptPresentation([failedAttempt(1, longFailure)]);

    expect(Array.from(attempt!.failurePreview!)).toHaveLength(241);
    expect(attempt).toMatchObject({ failureFull: longFailure, failureTruncated: true });
    expect(truncateText('abc', 10)).toBe('abc');
  });
});
