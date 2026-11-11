// @vitest-environment happy-dom
// 设置 → 消息通道里「待你处理推送」的两个开关（计划 Task 12）：推到 Slack 私信（slack_dm）、弹桌面通知（desktop），缺省都开。
// client 是假的：现在开没开从 listUiActions('ticket_push', <编号>) 读（开着时能做的是 disable），改动走 performUiAction。
import { type ChannelSourceSettingsDto, type UiActionView } from '@pi-lead-child/protocol';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithRuntime } from '../../../test/connections';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { ChannelSettingsSection } from './ChannelSettingsSection';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/settings/channels', Slot: () => null, Stack: () => null }));

const SOURCE: ChannelSourceSettingsDto = {
  source: 'slack', label: 'Slack', status: 'connected', account: null, missingScopes: [], lastError: null, lastConnectedAt: null,
  secrets: [], manifest: null, setupUrl: null, setupNote: null, noEventsWarning: null, editable: false,
};

function setup() {
  const enabled: Record<string, boolean> = { slack_dm: true, desktop: true };
  const views = (type: string, id: string): UiActionView[] => {
    const on = type === 'ticket_push' ? enabled[id] ?? false : false;
    const view = (action: string, available: boolean) => ({
      target: { type, id }, id: action, label: action, permission: 'lead_allowed', external: false, irreversible: false,
      where: '', confirm: null, available, reason: available ? null : 'no',
    }) as UiActionView;
    return [view('enable', !on), view('disable', on)];
  };
  const client = {
    getChannelSettings: vi.fn(async () => ({ sources: [SOURCE] })),
    getChannelConnection: vi.fn(() => new Promise(() => {})),
    listUiActions: vi.fn(async (type: string, id: string) => views(type, id)),
    performUiAction: vi.fn(async (type: string, id: string, action: string) => {
      if (type === 'ticket_push') enabled[id] = action === 'enable';
      return { target: { type, id }, action, result: { enabled: enabled[id] } };
    }),
  };
  const runtime = createCompanionStateRuntime({
    client: client as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  (runtime as unknown as { scopes: Set<string> }).scopes = new Set(['chat', 'tickets:view', 'tickets:create']);
  runtime.control.setState((state) => ({
    phase: 'ready', connectionState: 'connected', channelSettings: { sources: [SOURCE] },
    resourceState: { ...state.resourceState, 'channel-settings': { state: 'ready', generation: 0, observerCount: 0, lastSuccessAt: 0, error: null } },
  }));
  renderWithRuntime(<ChannelSettingsSection />, runtime);
  return client;
}

describe('the switches for pushing tickets that need you', () => {
  it('are on by default, and each one turns off and on through the ticket_push operation', async () => {
    const client = setup();
    const slack = await waitFor(() => screen.getByTestId('ticket-push-slack_dm-switch'));
    const desktop = await waitFor(() => screen.getByTestId('ticket-push-desktop-switch'));
    expect(slack.getAttribute('aria-checked')).toBe('true');
    expect(desktop.getAttribute('aria-checked')).toBe('true');
    expect(client.listUiActions).toHaveBeenCalledWith('ticket_push', 'slack_dm');
    expect(client.listUiActions).toHaveBeenCalledWith('ticket_push', 'desktop');

    await act(async () => { fireEvent.click(slack); });
    expect(client.performUiAction).toHaveBeenCalledWith('ticket_push', 'slack_dm', 'disable', { input: {} });
    await waitFor(() => expect(screen.getByTestId('ticket-push-slack_dm-switch').getAttribute('aria-checked')).toBe('false'));
    expect(screen.getByTestId('ticket-push-desktop-switch').getAttribute('aria-checked')).toBe('true');

    await act(async () => { fireEvent.click(screen.getByTestId('ticket-push-slack_dm-switch')); });
    expect(client.performUiAction).toHaveBeenCalledWith('ticket_push', 'slack_dm', 'enable', { input: {} });
    await waitFor(() => expect(screen.getByTestId('ticket-push-slack_dm-switch').getAttribute('aria-checked')).toBe('true'));
  });
});
