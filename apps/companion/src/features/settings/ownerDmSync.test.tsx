// @vitest-environment jsdom
// 设置 → 消息通道里「我不在看 App 时，把 Lead 的消息同步到我的 Slack 私信」开关（工单 #88）。client 是假的：
// 现在开没开从 listUiActions('owner_dm_sync', 'user') 读（开着时能做的是 disable），改动走 performUiAction。
//   - 缺省关；打开调 enable，然后重读，开关变成开。
//   - 开着时关掉调 disable。
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

function views(enabled: boolean): UiActionView[] {
  const view = (id: string, available: boolean) => ({
    target: { type: 'owner_dm_sync', id: 'user' }, id, label: id, permission: 'user_only', external: false, irreversible: false,
    where: '', confirm: null, available, reason: available ? null : 'no',
  }) as UiActionView;
  return [view('enable', !enabled), view('disable', enabled)];
}

function setup(first: boolean) {
  let enabled = first;
  const client = {
    getChannelSettings: vi.fn(async () => ({ sources: [SOURCE] })),
    getChannelConnection: vi.fn(() => new Promise(() => {})),
    listUiActions: vi.fn(async () => views(enabled)),
    performUiAction: vi.fn(async (type: string, id: string, action: string) => {
      enabled = action === 'enable';
      return { target: { type, id }, action, result: { enabled } };
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

describe('sync to the Slack DM switch', () => {
  it('is off by default, and turning it on calls enable and shows it on', async () => {
    const client = setup(false);
    const toggle = await waitFor(() => screen.getByTestId('owner-dm-sync-switch'));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(client.listUiActions).toHaveBeenCalledWith('owner_dm_sync', 'user');
    await act(async () => { fireEvent.click(toggle); });
    expect(client.performUiAction).toHaveBeenCalledWith('owner_dm_sync', 'user', 'enable', { input: {} });
    await waitFor(() => expect(screen.getByTestId('owner-dm-sync-switch').getAttribute('aria-checked')).toBe('true'));
  });

  it('turns it off with disable', async () => {
    const client = setup(true);
    const toggle = await waitFor(() => screen.getByTestId('owner-dm-sync-switch'));
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await act(async () => { fireEvent.click(toggle); });
    expect(client.performUiAction).toHaveBeenCalledWith('owner_dm_sync', 'user', 'disable', { input: {} });
  });
});
