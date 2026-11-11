// @vitest-environment happy-dom
// 工单从哪来、怎么处理、谁领着、在哪个会话里（external-worker-hub Task 10）。用户要的是：在网页的工单列表上看到每张单的来源
// （Slack/Jira/Notion 链接）、处理方式和理由、谁领着、在哪个 Claude Code 会话里，并且能跳回去。核对：
//   - 详情的「来源与会话」：链接只认 https: 和 claude:，别的地址写成文字；会话只有 id 时写 `claude --resume <id>`，能复制；
//     处理方式一键在 auto 和 needs_user 之间切换（ticket.set_handling，走工单操作的路由）；
//   - 列表：行上写来源、复杂度、领取人；手动领的单超过 4 小时没动静写「N 小时无动静」，给释放（ticket.release）；
//     筛选和搜索也按这些事实。
import type { TicketLinks, TicketMeta, TicketSummary } from '@pi-lead-child/protocol';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { renderWorkbenchWithTicket, setViewportWidth, ticket66, ticketAction } from '../../../test/workbench';
import { buildTicketRailPresentation, resolveWorkspaceTickets, type TicketFilter } from '../workspace/model';
import { TicketList } from '../workspace/TicketList';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => setViewportWidth(0));

function meta(id: number, overrides: Partial<TicketMeta> = {}): TicketMeta {
  return {
    id, handling: null, complexity: null, claimedBy: null, claimMode: null, idleHours: null, sourceLabel: null, needsYou: false, ...overrides,
  };
}

const source = (id: number, overrides: Partial<TicketLinks['sources'][number]>): TicketLinks['sources'][number] => ({
  id, itemId: 66, kind: 'slack', url: null, externalKey: null, conversation: null, messageTs: null, createdAt: '2026-11-12T01:00:00.000Z',
  ...overrides,
});

const links: TicketLinks = {
  sources: [
    source(1, { kind: 'jira', url: 'https://acme.example.com/browse/PROJ-123', externalKey: 'PROJ-123' }),
    source(2, { kind: 'slack', url: null, conversation: 'slack:dm:alice' }),
    source(3, { kind: 'manual', url: 'javascript:alert(1)' }),
  ],
  sessions: [
    { url: 'claude://resume?session=abc', sessionId: null },
    { url: 'http://acme.example.com/session', sessionId: null },
    { url: null, sessionId: '4f2a-session' },
  ],
  handlingReason: 'External source with side effects: your call.',
};

async function openDetail(options: { meta?: TicketMeta; runTicketAction?: ReturnType<typeof vi.fn> } = {}) {
  const runTicketAction = options.runTicketAction ?? vi.fn(async () => ({ ticketId: 66, action: 'ticket.set_handling', result: {}, ticket: null }));
  renderWorkbenchWithTicket(ticket66(), {
    actions: [ticketAction('ticket.set_handling', { permission: 'user_direct' })],
    client: {
      getTicketLinks: vi.fn(async () => links),
      getTicketsMeta: vi.fn(async () => [options.meta ?? meta(66, { handling: 'needs_user', claimedBy: 'ethan-cc', claimMode: 'manual', idleHours: 1 })]),
      runTicketAction,
    } as never,
  });
  const section = await screen.findByTestId('ticket-links');
  return { section, runTicketAction };
}

describe('the source and session block in the ticket detail', () => {
  it('links only https: and claude: addresses, and writes the rest as text', async () => {
    const { section } = await openDetail();
    expect(within(section).getByTestId('ticket-source-1').getAttribute('role')).toBe('link');
    expect(within(section).getByTestId('ticket-source-1').textContent).toBe('PROJ-123');
    // 私信建的单没有地址：只写来源的标签，不是链接，也不写内部的对话编号（P14.6）。
    expect(within(section).getByTestId('ticket-source-2').getAttribute('role')).toBeNull();
    expect(within(section).getByTestId('ticket-source-2').textContent).toBe('Slack');
    expect(within(section).getByTestId('ticket-source-3').getAttribute('role')).toBeNull();

    const claude = within(section).getByTestId('ticket-session-link');
    expect(claude.getAttribute('role')).toBe('link');
    expect(claude.textContent).toBe('Open in Claude Code');
    expect(within(section).getByTestId('ticket-session-text').getAttribute('role')).toBeNull();
    expect(within(section).getByTestId('ticket-session-text').textContent).toBe('http://acme.example.com/session');
  });

  it('writes claude --resume <id> for a session with only an id, and copies it', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { section } = await openDetail();
    expect(within(section).getByTestId('ticket-session-resume').textContent).toBe('claude --resume 4f2a-session');
    await act(async () => { fireEvent.click(within(section).getByTestId('ticket-session-copy')); });
    expect(writeText).toHaveBeenCalledWith('claude --resume 4f2a-session');
    expect(within(section).getByTestId('ticket-session-copy').textContent).toBe('Copied');
  });

  it('shows the handling and its reason, and switches needs_user to auto with one click', async () => {
    const { section, runTicketAction } = await openDetail();
    expect(section.textContent).toContain('Needs your call');
    expect(section.textContent).toContain('External source with side effects: your call.');
    expect(section.textContent).toContain('ethan-cc');
    await act(async () => { fireEvent.click(within(section).getByTestId('ticket-handling-auto')); });
    expect(runTicketAction).toHaveBeenCalledWith(66, 'ticket.set_handling', { input: { handling: 'auto' } });
  });

  it('switches auto back to needs_user', async () => {
    const { section, runTicketAction } = await openDetail({ meta: meta(66, { handling: 'auto' }) });
    await act(async () => { fireEvent.click(within(section).getByTestId('ticket-handling-needs-user')); });
    expect(runTicketAction).toHaveBeenCalledWith(66, 'ticket.set_handling', { input: { handling: 'needs_user' } });
  });
});

function summary(id: number, overrides: Partial<TicketSummary> = {}): TicketSummary {
  return { ...ticket66({ id, rootTicketId: id, title: `Ticket ${id}`, stage: 'active', status: 'active', project: null }), ...overrides };
}

describe('the ticket list with the hub facts', () => {
  const items = resolveWorkspaceTickets(true, [
    summary(1), summary(2), summary(3), summary(4), summary(5, { stage: 'done', status: 'done' }), summary(6),
  ]);
  // needsYou 由服务端按 needs_me 的规则算（ruling R18）：#2 要你拿主意；#5 已完成、#1 被工人领着，handling 虽是 needs_user 也不算。
  const facts = new Map<string, TicketMeta>([
    ['1', meta(1, { sourceLabel: 'PROJ-123', complexity: 'simple', handling: 'needs_user', claimedBy: 'ethan-cc', claimMode: 'manual', idleHours: 5 })],
    ['2', meta(2, { sourceLabel: 'Slack', handling: 'needs_user', needsYou: true })],
    ['3', meta(3, { claimedBy: 'queue-cc', claimMode: 'auto', idleHours: 9 })],
    ['4', meta(4, { handling: 'auto' })],
    ['5', meta(5, { handling: 'needs_user' })],
    ['6', meta(6, { sourceLabel: 'Slack', claimedBy: 'nina-cc', claimMode: 'manual', idleHours: 2 })],
  ]);

  it('writes the source, the complexity and the worker on the row', () => {
    renderUI(<TicketList items={items} grouped meta={facts} onSelect={() => {}} />);
    const row = screen.getByTestId('ticket-row-1');
    expect(row.textContent).toContain('PROJ-123');
    expect(row.textContent).toContain('Simple');
    expect(row.textContent).toContain('with ethan-cc');
    expect(screen.getByTestId('ticket-handling-2').textContent).toBe('Needs your call');
  });

  it('marks only what needsYou says: not a finished ticket, not a claimed one', () => {
    renderUI(<TicketList items={items} grouped meta={facts} onSelect={() => {}} />);
    fireEvent.click(screen.getByTestId('ticket-group-completed'));
    expect(screen.getByTestId('ticket-row-5')).toBeTruthy();
    expect(screen.queryByTestId('ticket-handling-5')).toBeNull();
    expect(screen.queryByTestId('ticket-handling-1')).toBeNull();
  });

  it('shows N h no activity and a release button for a manual claim idle over 4 hours only', async () => {
    const onReleaseTicket = vi.fn(async () => {});
    renderUI(<TicketList items={items} grouped meta={facts} onSelect={() => {}} onReleaseTicket={onReleaseTicket} />);
    expect(screen.getByTestId('ticket-idle-1').textContent).toBe('5 h no activity');
    expect(screen.queryByTestId('ticket-idle-6')).toBeNull();
    // 从队列领的单有租约，到期由系统收回，不给释放。
    expect(screen.queryByTestId('ticket-idle-3')).toBeNull();
    expect(screen.queryByTestId('ticket-release-6')).toBeNull();
    expect(screen.queryByTestId('ticket-release-3')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByTestId('ticket-release-1')); });
    expect(onReleaseTicket).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }));
  });

  it('filters by handling and by worker, and searches the source label and the worker', () => {
    const ids = (filter: TicketFilter, query = '') =>
      buildTicketRailPresentation(items, { filter, query, meta: facts }).groups.flatMap((group) => group.items.map((ticket) => ticket.id));
    expect(ids('needs_call')).toEqual(['2']);
    expect(ids('worker').sort()).toEqual(['1', '3', '6']);
    expect(ids('all', 'proj-123')).toEqual(['1']);
    expect(ids('all', 'nina')).toEqual(['6']);
    expect(buildTicketRailPresentation(items, { filter: 'all', meta: facts }).filterCounts).toMatchObject({ needs_call: 1, worker: 3 });
  });
});

// ruling R18：idleHours 是服务端在请求那一刻算的。工单不变时也要每 10 分钟重读一次，「N 小时无动静」才会按时出现。
describe('reading the hub facts again as time passes', () => {
  afterEach(() => vi.useRealTimers());

  it('shows the idle hint after the interval, with no ticket update', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let idleHours = 3;
    const getTicketsMeta = vi.fn(async () => [meta(66, { claimedBy: 'ethan-cc', claimMode: 'manual', idleHours })]);
    const getTicketLinks = vi.fn(async () => links);
    const runtime = renderWorkbenchWithTicket(ticket66(), { client: { getTicketLinks, getTicketsMeta } as never });
    act(() => { runtime.workspace.getState().setRailView('tickets'); });
    expect(await screen.findByTestId('ticket-row-66')).toBeTruthy();
    const section = await screen.findByTestId('ticket-links');
    await act(async () => {});
    expect(screen.queryByTestId('ticket-idle-66')).toBeNull();
    expect(section.textContent).not.toContain('no activity');
    const listReads = getTicketsMeta.mock.calls.length;
    const linkReads = getTicketLinks.mock.calls.length;

    idleHours = 4;
    await act(async () => { vi.advanceTimersByTime(10 * 60_000); });
    await act(async () => {});
    expect(getTicketLinks.mock.calls.length).toBeGreaterThan(linkReads);
    expect(getTicketsMeta.mock.calls.length).toBeGreaterThan(listReads);
    expect(screen.getByTestId('ticket-idle-66').textContent).toBe('4 h no activity');
    expect(screen.getByTestId('ticket-links').textContent).toContain('4 h no activity');
  });
});
