// @vitest-environment happy-dom
// 工单列表页的「找不到」（计划 Task 14）：小按钮点开一行输入框，发送记一行（操作 ticket_miss.record，和 plc miss 同一个）。核对：
//   - 在整个工作台里：列表上有按钮，点开、写、发送 → performUiAction('ticket_miss', 'hub', 'record', { input: { text } })，原话去掉首尾空白；
//   - 空的发不了；进行中写「正在发送…」，同行按钮停用；失败时在下面写原因、输入框里的字还在；成功以后收起，写「已记下」（en + zh 的文案在 ticketMiss.messages.ts，typecheck 保证两种语言键一致）；
//   - 取消不记。
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { renderWorkbenchWithTicket, setViewportWidth, ticket66 } from '../../../test/workbench';
import { TicketMissRow } from './TicketMissRow';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => setViewportWidth(0));

const type = (value: string) => fireEvent.change(screen.getByTestId('ticket-miss-input'), { target: { value } });

describe('the "can\'t find it" row in the ticket list', () => {
  it('is on the ticket list of the workbench and records through ticket_miss.record', async () => {
    const performUiAction = vi.fn(async () => ({ target: { type: 'ticket_miss', id: 'hub' }, action: 'record', result: {} }));
    renderWorkbenchWithTicket(ticket66(), { client: { performUiAction } as never });
    // 工作台缺省停在收件箱：「找不到」只在工单这一页。
    expect(screen.queryByTestId('ticket-miss-open')).toBeNull();
    await act(async () => { fireEvent.click(await screen.findByTestId('rail-view-tickets')); });
    await act(async () => { fireEvent.click(await screen.findByTestId('ticket-miss-open')); });
    await act(async () => { type('  the Jira ticket from Nina  '); });
    await act(async () => { fireEvent.click(screen.getByTestId('ticket-miss-send')); });
    expect(performUiAction).toHaveBeenCalledWith('ticket_miss', 'hub', 'record', { input: { text: 'the Jira ticket from Nina' } });
    await waitFor(() => expect(screen.getByTestId('ticket-miss-saved').textContent).toBe('Noted.'));
    expect(screen.queryByTestId('ticket-miss-input')).toBeNull();
  });

  it('cannot send an empty text, and cancel records nothing', async () => {
    const onReport = vi.fn(async () => undefined);
    renderUI(<TicketMissRow onReport={onReport} />);
    fireEvent.click(screen.getByTestId('ticket-miss-open'));
    const send = screen.getByTestId('ticket-miss-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await act(async () => { type('   '); });
    expect((screen.getByTestId('ticket-miss-send') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { type('something'); });
    fireEvent.click(screen.getByTestId('ticket-miss-cancel'));
    expect(screen.queryByTestId('ticket-miss-input')).toBeNull();
    expect(onReport).not.toHaveBeenCalled();
    expect(screen.queryByTestId('ticket-miss-saved')).toBeNull();
  });

  it('writes sending while it works and disables the row, then keeps the text and shows the reason on failure', async () => {
    let fail!: (reason: Error) => void;
    const onReport = vi.fn(() => new Promise<unknown>((_resolve, reject) => { fail = reject; }));
    renderUI(<TicketMissRow onReport={onReport} />);
    fireEvent.click(screen.getByTestId('ticket-miss-open'));
    await act(async () => { type('the report ticket'); });
    await act(async () => { fireEvent.click(screen.getByTestId('ticket-miss-send')); });
    expect(screen.getByTestId('ticket-miss-send').textContent).toBe('Sending…');
    expect((screen.getByTestId('ticket-miss-send') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('ticket-miss-cancel') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { fail(new Error('missing scope: tickets:create')); });
    expect(screen.getByTestId('ticket-miss-error').textContent).toBe('Could not save: missing scope: tickets:create');
    expect((screen.getByTestId('ticket-miss-input') as HTMLInputElement).value).toBe('the report ticket');
    expect((screen.getByTestId('ticket-miss-send') as HTMLButtonElement).disabled).toBe(false);
  });
});
