// 回归（复核 P1-2）：#66 的生命周期有 56 行，Run #71 的失败在页面上出现 6 次。
// 「经过」把它压成几行：每件事一行，连续的失败合成一行，对话 Run 不进来。
import { describe, expect, it } from 'vitest';

import { deliveryNumbersOf } from './deliveryNumbers';
import { buildRunFacts } from './runFacts';
import { TICKET_66_ACTIVITIES, TICKET_66_ATTEMPTS, TICKET_66_CREATED } from './ticket66.fixture';
import { buildTicketStory, type TicketStoryInput } from './ticketStory';

function story66(overrides: Partial<TicketStoryInput> = {}) {
  const facts = buildRunFacts({ attempts: TICKET_66_ATTEMPTS, activities: TICKET_66_ACTIVITIES });
  return buildTicketStory({
    created: TICKET_66_CREATED,
    attempts: TICKET_66_ATTEMPTS,
    activities: TICKET_66_ACTIVITIES,
    facts,
    // #66 交付了两次：Run #42 和 Run #49。
    deliveryNumbers: deliveryNumbersOf([{ attemptId: 42, sequence: 1 }, { attemptId: 49, sequence: 2 }]),
    leadName: 'Paimon',
    ...overrides,
  });
}

describe('the story of ticket #66', () => {
  it('tells what happened in a few lines, one line for each thing', () => {
    expect(story66().map((entry) => [entry.title, entry.detail])).toEqual([
      ['You created the ticket', null],
      ['Delivery 1', null],
      ['Review failed', expect.stringMatching(/^1\) npm test 全量根测试 exit 1，154 files passed、1 failed；/)],
      ['You delegated the ticket to Paimon and requested rework', null],
      ['5 executions did not deliver', 'Model at capacity, You switched to Claude Code, Authentication failed ×2, Handoff failed'],
      ['Delivery 2', null],
      ['You requested an independent review', null],
      ['A review did not complete', 'Codex does not support model gpt-5.5'],
    ]);
  });

  // 设计规范 P14.6：经过里不写执行记录的编号。不知道第几次交付时只说交付了。
  it('names deliveries by their number, and writes no run numbers', () => {
    const titles = story66().map((entry) => [entry.title, ...entry.runs.map((run) => run.title)]).flat().join('\n');
    expect(titles).not.toMatch(/Run|#\d/);
    expect(story66({ deliveryNumbers: deliveryNumbersOf([]) }).filter((entry) => entry.title === 'Delivered')).toHaveLength(2);
    expect(story66({ locale: 'zh' }).map((entry) => entry.title)).toContain('第 2 次交付');
  });

  it('keeps conversation runs and the run in flight out of the story', () => {
    const titles = story66().map((entry) => entry.title).join('\n');
    // 对话 Run #71 的失败在工单对话里；核查 Run #74 正在准备，决策卡说它。
    expect(titles).not.toMatch(/#(?:50|51|71|72|74)\b/);
  });

  it('lists each run of a group with its own reason', () => {
    const group = story66().find((entry) => entry.title === '5 executions did not deliver')!;
    expect(group.runs.map((run) => [run.runId, run.title, run.reason])).toEqual([
      [44, 'Execution', 'Model at capacity'],
      [45, 'Execution', 'You switched to Claude Code'],
      [46, 'Execution', 'Authentication failed'],
      [47, 'Execution', 'Authentication failed'],
      [48, 'Execution', 'Handoff failed'],
    ]);
    expect(group.at).toBe('2026-08-19T09:42:01.000Z');
    expect(group.until).toBe('2026-08-21T09:17:54.000Z');
    expect(group.tone).toBe('danger');
  });

  it('marks deliveries and passed reviews as success and your decisions as yours', () => {
    const tones = Object.fromEntries(story66().map((entry) => [entry.title, entry.tone]));
    expect(tones['Delivery 1']).toBe('success');
    expect(tones['Review failed']).toBe('danger');
    expect(tones['You requested an independent review']).toBe('accent');
    expect(tones['You created the ticket']).toBe('neutral');
  });
});

describe('the story of a ticket', () => {
  const base = { created: null, facts: new Map(), leadName: 'Paimon' } as const;

  it('breaks a group of failures when something else happens between them', () => {
    const attempts = TICKET_66_ATTEMPTS.filter((attempt) => attempt.id === 44 || attempt.id === 46);
    const activities = [
      ...TICKET_66_ACTIVITIES.filter((activity) => activity.attemptId === 44 || activity.attemptId === 46),
      { id: 900, actor: 'user' as const, kind: 'decision' as const, attemptId: null, createdAt: '2026-08-20T00:00:00.000Z', payload: { decision: 'rework_dispatch_requested' } },
    ];
    const facts = buildRunFacts({ attempts, activities });
    expect(buildTicketStory({ ...base, attempts, activities, facts }).map((entry) => entry.title)).toEqual([
      'An execution did not deliver',
      'You requested rework',
      'An execution did not deliver',
    ]);
  });

  it('writes a runtime switch on its own line when no run was stopped for it', () => {
    const activities = [{
      id: 901, actor: 'user' as const, kind: 'decision' as const, attemptId: null, createdAt: '2026-08-20T00:00:00.000Z',
      payload: { decision: 'ticket_runtime_switched', fromRuntime: 'codex', toRuntime: 'claude', previousRunId: null },
    }];
    expect(buildTicketStory({ ...base, attempts: [], activities }).map((entry) => entry.title)).toEqual([
      'You changed the executor to Claude Code',
    ]);
  });

  it('puts the creation first even when its recorded time is later', () => {
    const activities = [{
      id: 903, actor: 'user' as const, kind: 'decision' as const, attemptId: null, createdAt: '2026-08-20T00:00:00.000Z',
      payload: { decision: 'review_requested_by_user' },
    }];
    const created = { at: '2026-10-15T00:21:00.000Z', by: 'lead' as const };
    expect(buildTicketStory({ ...base, created, attempts: [], activities }).map((entry) => entry.title)).toEqual([
      'Paimon created the ticket',
      'You requested an independent review',
    ]);
    expect(buildTicketStory({ ...base, leadName: 'Jarvis', created, attempts: [], activities })[0]?.title).toBe('Jarvis created the ticket');
  });

  it('ends with the acceptance when you accept the ticket', () => {
    const activities = [{
      id: 902, actor: 'user' as const, kind: 'transition' as const, attemptId: null, createdAt: '2026-08-22T00:00:00.000Z',
      payload: { from: 'review', to: 'done' },
    }];
    expect(buildTicketStory({ ...base, attempts: [], activities })).toMatchObject([{ title: 'You accepted the ticket', tone: 'success' }]);
  });

  it('writes the story in Chinese when the interface language is Chinese', () => {
    const activities = [{
      id: 902, actor: 'user' as const, kind: 'transition' as const, attemptId: null, createdAt: '2026-08-22T00:00:00.000Z',
      payload: { from: 'review', to: 'done' },
    }];
    const created = { at: '2026-08-21T00:00:00.000Z', by: 'lead' as const };
    expect(buildTicketStory({ ...base, locale: 'zh', created, attempts: [], activities }).map((entry) => entry.title))
      .toEqual(['Paimon 创建了工单', '你验收通过']);
  });
});
