// @vitest-environment happy-dom
// 设置 → Shadow（2026-11-19，用户：「在 UI 上开设置功能」）：模式是一组单选（关、试运行、开），每类来源一行比例的分段选择，
// 模型一个下拉，合批等待一行分段选择。改了马上保存（操作层的 lead_shadow.set），只写改的那个字段；没保存成功时写原因，控件退回。
// 旧 daemon 不支持时不给改。契约在 packages/protocol/src/lead-shadow.ts；客户端方法是假的。
import { DEFAULT_LEAD_SHADOW, LEAD_SHADOW_SETTINGS_CAPABILITY, type LeadShadowDto, type SetLeadShadowRequest } from '@pi-lead-child/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithRuntime } from '../../../test/connections';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { ShadowSection } from './ShadowSection';
import { shadowMessages } from './shadow.messages';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/settings/shadow', Slot: () => null, Stack: () => null }));

const MODELS = ['magpie/codex/gpt-sol', 'magpie/codex/gpt-terra'];

function shadowRuntime(initial: LeadShadowDto, options: { capabilities?: string[]; fail?: string } = {}) {
  let current = initial;
  const option = (model: string) => ({ model, provider: 'magpie', id: model.slice('magpie/'.length), prefix: null, source: null, name: null });
  const fake = {
    getLeadShadow: vi.fn(async () => current),
    getLeadModels: vi.fn(async () => ({
      current: { model: MODELS[0], effort: null }, selected: { model: MODELS[0], effort: null }, models: MODELS.map(option),
    })),
    performUiAction: vi.fn(async (type: string, id: string, action: string, request: { input: SetLeadShadowRequest }) => {
      if (options.fail) throw new Error(options.fail);
      const before = current;
      current = { ...current, ...request.input, shares: { ...current.shares, ...request.input.shares } } as LeadShadowDto;
      return { target: { type, id }, action, result: { changed: true, before, shadow: current } };
    }),
  };
  const runtime = createCompanionStateRuntime({
    client: fake as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  (runtime as unknown as { scopes: Set<string> }).scopes = new Set(['chat', 'tickets:view', 'tickets:create']);
  runtime.control.setState((state) => ({
    phase: 'ready',
    connectionState: 'connected',
    capabilities: options.capabilities ?? [LEAD_SHADOW_SETTINGS_CAPABILITY],
    leadShadow: initial,
    resourceState: {
      ...state.resourceState,
      'lead-shadow': { state: 'ready', generation: 0, observerCount: 0, lastSuccessAt: 0, error: null },
    },
  }));
  return { runtime, client: fake };
}

// react-native-web 的 measureInWindow 是异步的：量完位置才打开下拉。
async function openModels() {
  fireEvent.click(screen.getByTestId('shadow-model-input'));
  await screen.findByTestId('shadow-model-input-panel');
}

const checked = (testID: string) => screen.getByTestId(testID).getAttribute('aria-checked');
const pressed = (testID: string) => screen.getByTestId(testID).getAttribute('aria-pressed') ?? screen.getByTestId(testID).getAttribute('aria-selected');

describe('the shadow settings', () => {
  it('shows the mode as radio buttons with the Lead name, and the saved shares, model and wait', async () => {
    const { runtime } = shadowRuntime({ ...DEFAULT_LEAD_SHADOW, mode: 'on', shares: { channel: 50, ticket: 0, other: 0 }, model: MODELS[1]! });
    await act(async () => { renderWithRuntime(<ShadowSection />, runtime); });
    expect(screen.getByTestId('shadow-mode').getAttribute('role')).toBe('radiogroup');
    expect(checked('shadow-mode-on')).toBe('true');
    expect(checked('shadow-mode-off')).toBe('false');
    expect(screen.getByTestId('shadow-mode-trial').textContent)
      .toBe('TrialThe shadow handles the same events as Paimon, but its actions do not take effect. It only records what it would do, so you can compare.');
    expect(pressed('shadow-share-channel-50')).toBe('true');
    expect(pressed('shadow-share-ticket-0')).toBe('true');
    expect(screen.getByTestId('shadow-model').textContent).toContain(MODELS[1]);
    expect(pressed('shadow-gather-20')).toBe('true');
  });

  it('saves only the field you change, right away, through the operation', async () => {
    const { runtime, client } = shadowRuntime(DEFAULT_LEAD_SHADOW);
    await act(async () => { renderWithRuntime(<ShadowSection />, runtime); });
    await act(async () => { fireEvent.click(screen.getByTestId('shadow-mode-trial')); });
    expect(client.performUiAction).toHaveBeenLastCalledWith('lead_shadow', 'lead', 'set', { input: { mode: 'trial' } });
    expect(checked('shadow-mode-trial')).toBe('true');

    await act(async () => { fireEvent.click(screen.getByTestId('shadow-share-ticket-25')); });
    expect(client.performUiAction).toHaveBeenLastCalledWith('lead_shadow', 'lead', 'set', { input: { shares: { ticket: 25 } } });
    expect(runtime.control.getState().leadShadow?.shares).toEqual({ channel: 100, ticket: 25, other: 0 });

    await act(async () => { fireEvent.click(screen.getByTestId('shadow-gather-0')); });
    expect(client.performUiAction).toHaveBeenLastCalledWith('lead_shadow', 'lead', 'set', { input: { gatherSeconds: 0 } });
  });

  it('picks the model from Lead\'s model list, and back to the conversation\'s model', async () => {
    const { runtime, client } = shadowRuntime(DEFAULT_LEAD_SHADOW);
    await act(async () => { renderWithRuntime(<ShadowSection />, runtime); });
    expect(screen.getByTestId('shadow-model').textContent).toContain('Same as the conversation');
    await openModels();
    await act(async () => { fireEvent.click(screen.getByTestId(`shadow-model-${MODELS[1]}`)); });
    expect(client.performUiAction).toHaveBeenLastCalledWith('lead_shadow', 'lead', 'set', { input: { model: MODELS[1] } });

    await openModels();
    await act(async () => { fireEvent.click(screen.getByTestId('shadow-model-same')); });
    expect(client.performUiAction).toHaveBeenLastCalledWith('lead_shadow', 'lead', 'set', { input: { model: null } });
  });

  it('says what the share is when Lead set a value that is not one of the steps', async () => {
    const { runtime } = shadowRuntime({ ...DEFAULT_LEAD_SHADOW, shares: { channel: 30, ticket: 0, other: 0 } });
    await act(async () => { renderWithRuntime(<ShadowSection />, runtime); });
    expect(screen.getByTestId('shadow-share-channel').textContent).toContain('Now 30%. Pick a value to change it.');
  });

  it('shows why the change did not save, and keeps the saved mode selected', async () => {
    const { runtime } = shadowRuntime(DEFAULT_LEAD_SHADOW, { fail: 'The daemon is busy' });
    await act(async () => { renderWithRuntime(<ShadowSection />, runtime); });
    await act(async () => { fireEvent.click(screen.getByTestId('shadow-mode-on')); });
    expect(screen.getByTestId('shadow-error').textContent).toBe('Not saved: The daemon is busy');
    expect(checked('shadow-mode-off')).toBe('true');
  });

  it('offers no settings when the daemon does not serve them', () => {
    const { runtime } = shadowRuntime(DEFAULT_LEAD_SHADOW, { capabilities: [] });
    renderWithRuntime(<ShadowSection />, runtime);
    expect(screen.getByTestId('shadow-unsupported')).toBeTruthy();
    expect(screen.queryByTestId('shadow-mode')).toBeNull();
  });

  it('has the same texts in Chinese, with the Lead name', () => {
    const zh = shadowMessages('zh');
    expect(zh.options).toEqual({ off: '关', trial: '试运行', on: '开' });
    expect(zh.title('Fairy')).toBe('Fairy 的分身 shadow');
    expect(zh.notes.on('Fairy')).toBe('后台事件按下面的比例先交给 shadow。它交回的事带着查到的情况交给 Fairy。');
  });
});
