import type { KernelOutcomeSnapshotResource, KernelTicketPow } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import { deliveryNumbersOf } from './deliveryNumbers';
import { buildEvidencePresentation } from './ticketEvidence';

// #66 交付了两次：Run #42 是第 1 次，Run #49 是第 2 次。Run #45 没有交付。
const deliveries = deliveryNumbersOf([{ attemptId: 42, sequence: 1 }, { attemptId: 49, sequence: 2 }]);

// #66 的真实证据（DB 只读查询，2026-10-13）：Run #42 写了两条 failed（EPERM 借口）和四条 passed，
// Run #45 写了两条 passed；最新交付 Run #49 没有 proof items，它的验证结果在成果快照 #2 里。
const pow: KernelTicketPow = {
  verdict: 'attention',
  items: [
    { id: 'socket-tests', label: 'Daemon socket/e2e listener tests', state: 'failed', evidence: 'sandbox rejects listen with EPERM', checkpointId: 67, attemptId: 42, updatedAt: '2026-08-17T11:00:09.202Z' },
    { id: 'build', label: 'Production build', state: 'passed', evidence: 'npm run build passed', checkpointId: 68, attemptId: 42, updatedAt: '2026-08-17T11:01:46.424Z' },
    { id: 'listener-suite', label: 'Listener-dependent daemon/e2e suite', state: 'failed', evidence: 'failed because sandbox rejects listen with EPERM', checkpointId: 68, attemptId: 42, updatedAt: '2026-08-17T11:01:46.424Z' },
    { id: 'e2e-repro', label: 'Previously failing E2E', state: 'passed', evidence: 'exited 0; 2 tests passed.', checkpointId: 87, attemptId: 45, updatedAt: '2026-08-21T08:13:04.674Z' },
  ],
  metrics: { passed: 2, total: 4, checkpointCount: 21, toolOperationCount: 405, elapsedMs: 1, pendingInterventionCount: 0 },
  deliveryAttemptId: 49,
  computedAt: '2026-10-13T02:00:28.832Z',
};

const outcome: KernelOutcomeSnapshotResource = {
  latest: {
    id: 2, ticketId: 66, executorAttemptId: 49, completionCheckpointId: null, source: 'system_recovered',
    sourceEventSeq: 447, sourceOutputSha256: 'c52eaf3a94d7ac85849cd03b668ec404bd84a875d3183278cf456adcb0b53e14',
    summary: 'Closed the outcome-registry gap.', changes: [], deliverables: [],
    validations: [
      { command: './node_modules/.bin/vitest run', outcome: 'passed', exitCode: 0, summary: 'Full root suite green: 158 files / 1238 tests passed', evidenceRef: null },
      { command: 'npm run typecheck', outcome: 'not_run', exitCode: null, summary: 'Blocked: requires-approval', evidenceRef: null },
    ],
    completeness: 'complete', missingFields: [], recoveryNote: null, createdAt: '2026-08-21T10:48:04.022Z',
  },
  historyCount: 2,
  facts: { implementationCompleted: true, independentEvidence: 'missing', acceptance: 'none' },
  reviewerVerdict: null,
};

describe('evidence presentation', () => {
  it('regression #66: shows the latest delivery evidence and moves older runs into history', () => {
    const evidence = buildEvidencePresentation(pow, outcome, 'en', deliveries);

    expect(evidence.currentTitle).toBe('This delivery · delivery 2');
    expect(evidence.current).toEqual([
      { id: 'validation-0', label: './node_modules/.bin/vitest run', detail: 'Full root suite green: 158 files / 1238 tests passed', state: 'passed' },
      { id: 'validation-1', label: 'npm run typecheck', detail: 'Blocked: requires-approval', state: 'not_run' },
    ]);
    expect(evidence.history.map((group) => [group.title, group.rows.map((row) => row.state)])).toEqual([
      ['Earlier evidence · replaced by delivery 2', ['passed']],
      ['Evidence of delivery 1 · replaced by delivery 2', ['failed', 'passed', 'failed']],
    ]);
    expect(evidence.summary).toEqual({ title: '1 passed · 1 not run', tone: 'attention', mark: '!' });
    expect(JSON.stringify(evidence)).not.toMatch(/Run #\d/);
  });

  it('never relabels a failed item as an environment limit', () => {
    const evidence = buildEvidencePresentation({ ...pow, deliveryAttemptId: 42 }, null);

    expect(evidence.summary.title).toBe('1 passed · 2 failed');
    expect(evidence.summary.title).not.toContain('environment');
  });

  it('marks a fully passed delivery with a check, and an empty one plainly', () => {
    expect(buildEvidencePresentation(null, { ...outcome, latest: { ...outcome.latest!, validations: [outcome.latest!.validations[0]!] } }).summary)
      .toEqual({ title: '1 passed', tone: 'passed', mark: '✓' });
    expect(buildEvidencePresentation({ ...pow, items: [], deliveryAttemptId: 49 }, null).summary)
      .toEqual({ title: 'The latest delivery registered no validation results', tone: 'muted', mark: '·' });
    expect(buildEvidencePresentation({ ...pow, items: [], deliveryAttemptId: 49 }, null, 'zh', deliveries).summary.title)
      .toBe('第 2 次交付没有登记验证结果');
  });

  // release review 4：reviewer 和对话 Run 报的条目属于它们之前那次交付。
  it('keeps reviewer and conversation evidence with the delivery it belongs to', () => {
    const evidence = buildEvidencePresentation({
      ...pow,
      items: [
        ...pow.items.map((item) => ({ ...item, deliveryAttemptId: item.attemptId })),
        { id: 'regression', label: 'Regression replay', state: 'passed', evidence: 'replayed', checkpointId: 95, attemptId: 52, deliveryAttemptId: 49, updatedAt: '2026-10-13T02:00:00.000Z' },
        { id: 'manual', label: 'Manual check', state: 'failed', evidence: 'button missing', checkpointId: 96, attemptId: 53, deliveryAttemptId: 49, updatedAt: '2026-10-13T02:10:00.000Z' },
      ],
    }, null);

    expect(evidence.current.map((row) => [row.id, row.state])).toEqual([['proof-regression', 'passed'], ['proof-manual', 'failed']]);
    // 交付列表还没读到：不知道第几次交付，也不写执行记录的编号。
    expect(evidence.history.map((group) => group.title)).toEqual([
      'Earlier evidence · replaced by the latest delivery',
      'Earlier evidence · replaced by the latest delivery',
    ]);
    expect(evidence.history.map((group) => group.attemptId)).toEqual([45, 42]);
    expect(evidence.needsAttention).toBe(true);
  });

  it('keeps every item current when an older daemon sends no run attribution', () => {
    const legacy = { ...pow, deliveryAttemptId: undefined, items: pow.items.map(({ attemptId: _, ...item }) => item) };

    expect(buildEvidencePresentation(legacy, null).current).toHaveLength(4);
    expect(buildEvidencePresentation(legacy, null).history).toEqual([]);
  });
});
