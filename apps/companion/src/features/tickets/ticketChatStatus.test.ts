// 回归：#66 上点了「派发独立核查」，对话里什么都没有；核查 Run #73 停在 starting，没有任何地方说它卡住了。
import { describe, expect, it } from 'vitest';

import { RUN_START_STALL_MS, elapsedText, latestUserAction, liveRunProgress } from './ticketChatStatus';

describe('the receipt of your latest action', () => {
  it('regression #66: says you dispatched the review', () => {
    const receipt = latestUserAction([
      { actor: 'user', kind: 'decision', payload: { decision: '开始执行' }, createdAt: '2026-08-21T10:27:45.000Z' },
      { actor: 'system', kind: 'decision', payload: { decision: 'dispatch_requested' }, createdAt: '2026-10-14T10:10:53.000Z' },
      { actor: 'user', kind: 'decision', payload: { decision: 'review_requested_by_user' }, createdAt: '2026-10-14T10:10:53.000Z' },
      { actor: 'lead', kind: 'comment', payload: { content: '分类' }, createdAt: '2026-10-14T10:11:00.000Z' },
    ], 'Paimon');
    expect(receipt).toEqual({ title: 'You requested an independent review', createdAt: '2026-10-14T10:10:53.000Z' });
  });

  it('counts your own transitions and ignores the system ones', () => {
    expect(latestUserAction([
      { actor: 'user', kind: 'transition', payload: { from: 'review', to: 'done' }, createdAt: '2026-10-14T10:00:00.000Z' },
      { actor: 'system', kind: 'transition', payload: { from: 'active', to: 'blocked' }, createdAt: '2026-10-14T11:00:00.000Z' },
    ], 'Paimon')).toEqual({ title: 'You accepted this ticket', createdAt: '2026-10-14T10:00:00.000Z' });
    expect(latestUserAction([], 'Paimon')).toBeNull();
  });

  it('calls Lead by its name in the receipt', () => {
    expect(latestUserAction([
      { actor: 'user', kind: 'decision', payload: { decision: 'delegation_preflight_accepted' }, createdAt: '2026-10-14T10:00:00.000Z' },
    ], 'Jarvis')).toEqual({ title: 'You delegated the ticket to Jarvis', createdAt: '2026-10-14T10:00:00.000Z' });
  });
});

describe('the progress of the run in flight', () => {
  const startedAt = '2026-10-14T10:10:54.000Z';
  const at = (ms: number) => Date.parse(startedAt) + ms;
  const reviewer = { id: 73, role: 'reviewer' as const, purpose: 'review' as const, state: 'starting' as const, startedAt };

  it('regression #66: says a review run that has been starting for minutes may be stuck', () => {
    const progress = liveRunProgress([reviewer], new Map(), at(13 * 60_000));
    expect(progress).toMatchObject({ runId: 73, label: 'Review · Preparing', phase: 'starting', stalled: true });
    expect(elapsedText(progress!.elapsedMs)).toBe('13 min so far');
  });

  it('does not call a run stuck in its first minute', () => {
    expect(liveRunProgress([reviewer], new Map(), at(RUN_START_STALL_MS - 1))?.stalled).toBe(false);
  });

  it('names a running conversation as answering', () => {
    const chat = { id: 72, role: 'executor' as const, purpose: 'conversation' as const, state: 'running' as const, startedAt };
    expect(liveRunProgress([chat], new Map(), at(20_000))).toMatchObject({ label: 'Conversation · Answering', stalled: false });
  });

  it('takes the newest run when several are live, and none when all have ended', () => {
    const old = { ...reviewer, id: 70, state: 'running' as const };
    expect(liveRunProgress([old, reviewer], new Map(), at(1_000))?.runId).toBe(73);
    expect(liveRunProgress([{ ...reviewer, state: 'settled' as never }], new Map(), at(1_000))).toBeNull();
  });

  it('writes elapsed time in words', () => {
    expect(elapsedText(40_000)).toBe('40 sec so far');
    expect(elapsedText(68 * 60_000)).toBe('1 h 8 min so far');
    expect(elapsedText(120 * 60_000)).toBe('2 h so far');
    expect(elapsedText(68 * 60_000, 'zh')).toBe('已 1 小时 8 分钟');
  });
});
