// @vitest-environment happy-dom
// 设置 → 模型的接入列表和「添加模型」（模型配置方案 C，2026-11-16，.scratch/model-config-c/spec.md 切片 S1）。
// API key 只有三种：自定义、vibeproxy、magpie。添加走 save_provider；添加以后从新的模型设置里读出模型、账号、路由别名。
import type { BrainModel, ModelProvider, ModelSettingsDto } from '@pi-lead-child/protocol';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithRuntime, setViewportWidth } from '../../../test/connections';
import ModelRoute from '../../app/settings/model';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import {
  addModelRequest, freeProviderName, hasSubscriptionField, librarySections, providerAccounts, providerGroup, providerKind, providerSummary,
  type AddModelForm,
} from './modelSettingsModel';
import { SettingsDesktopShell } from './SettingsDesktopShell';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), canGoBack: () => false, dismissTo: vi.fn() }),
  usePathname: () => '/settings/model', Slot: () => null, Stack: () => null,
}));

function model(provider: string, id: string, extra: Partial<BrainModel> = {}): BrainModel {
  return {
    model: `${provider}/${id}`, id, name: null, image: false, contextWindow: 128_000, efforts: [], defaultEffort: null,
    released: null, blockedUntil: null, group: null, source: null, ...extra,
  };
}

const vibeproxy: ModelProvider = {
  name: 'vibeproxy', baseUrl: 'http://127.0.0.1:8317/v1', api: 'openai-completions', keySet: false, keySource: null, keyHost: null, problem: null,
  accountPrefix: true, accountPrefixActive: true, capabilities: 'auto', catalog: 'detailed', preset: null,
  models: [
    model('vibeproxy', 'as4/claude-sonnet-5-5', { group: 'as4', source: 'anthropic' }),
    model('vibeproxy', 'as1/claude-sonnet-5-5', { group: 'as1', source: 'anthropic', blockedUntil: '2026-11-17T08:00:00.000Z' }),
    model('vibeproxy', 'as1/claude-haiku-5-5', { group: 'as1', source: 'anthropic', blockedUntil: '2026-11-18T08:00:00.000Z' }),
    model('vibeproxy', 'gemini-3.8-flash', { source: 'antigravity' }),
  ],
};

const magpie: ModelProvider = {
  name: 'magpie', baseUrl: 'https://gateway.example.com/v1', api: 'openai-completions', keySet: true, keySource: 'settings',
  keyHost: 'gateway.example.com', problem: null, accountPrefix: false, accountPrefixActive: false, capabilities: 'auto', catalog: 'plain',
  models: [
    model('magpie', 'auto/deepseek-flash', { source: 'deepseek' }),
    model('magpie', 'auto/fast', { source: 'deepseek' }),
    model('magpie', 'deepseek/deepseek-flash', { name: 'DeepSeek Flash', source: 'deepseek' }),
    model('magpie', 'qwen/qwen-max', { source: 'qwen' }),
  ],
};

function settings(providers: ModelProvider[], extra: Record<string, unknown> = {}): ModelSettingsDto {
  return {
    brain: { chain: [{ model: 'vibeproxy/as4/claude-sonnet-5-5', effort: null }], current: { model: 'vibeproxy/as4/claude-sonnet-5-5', effort: null }, providers },
    fast: { models: [], chain: [], llmFallback: null, effectiveLlm: null },
    maxBackups: 3,
    ...extra,
  } as ModelSettingsDto;
}

type Perform = (type: string, id: string, action: string, request: unknown) => Promise<{ target: unknown; action: string; result: unknown }>;

// 假的客户端：save_provider 以后，下一次读模型设置拿到 after。
function addRuntime(before: ModelSettingsDto, after: ModelSettingsDto = before) {
  let current = before;
  const perform = vi.fn<Perform>(async (_type, _id, action) => {
    current = after;
    return { target: { type: 'model_settings', id: 'models' }, action, result: { summary: 'ok', note: null } };
  });
  const fake = {
    getModelSettings: vi.fn(async () => current),
    performUiAction: perform,
    getMemory: vi.fn(async () => { throw new Error('not used'); }),
    getDecisionModel: vi.fn(async () => { throw new Error('not used'); }),
  };
  const runtime = createCompanionStateRuntime({
    client: fake as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  (runtime as unknown as { scopes: Set<string> }).scopes = new Set(['chat', 'tickets:view', 'tickets:create']);
  const ready = { state: 'ready' as const, generation: 0, observerCount: 0, lastSuccessAt: 0, error: null };
  runtime.control.setState((state) => ({
    phase: 'ready', connectionState: 'connected', modelSettings: before, memory: null,
    resourceState: { ...state.resourceState, memory: ready, 'decision-model': ready, 'model-settings': ready },
  }));
  return { runtime, perform };
}

// 页面上的「后台工作」卡打开时读一次 background_model：只看模型设置的调用。
const modelCalls = (perform: ReturnType<typeof vi.fn>) => perform.mock.calls.filter((call) => call[0] !== 'background_model');
const inputOf = (perform: ReturnType<typeof vi.fn>, call = 0) => (modelCalls(perform)[call]![3] as { input: unknown }).input;
const form = (extra: Partial<AddModelForm>): AddModelForm => ({ kind: 'custom', name: '', baseUrl: '', apiKey: '', api: 'openai-completions', ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  setViewportWidth(1280);
});

describe('the rules of the provider rows', () => {
  it('uses the saved preset, and infers the kind only for display when there is none', () => {
    expect(providerKind(vibeproxy)).toBe('vibeproxy');
    expect(providerKind(magpie)).toBe('magpie');
    expect(providerKind({ ...magpie, preset: 'custom' })).toBe('custom');
    expect(providerKind({ ...magpie, models: magpie.models.filter((entry) => !entry.id.startsWith('auto/')) })).toBe('custom');
  });

  it('lists the vibeproxy accounts and says when an account waits for its quota', () => {
    expect(providerAccounts(vibeproxy)).toEqual([
      { group: 'as4', models: 1, blockedUntil: null },
      { group: 'as1', models: 2, blockedUntil: '2026-11-17T08:00:00.000Z' },
    ]);
    const now = new Date('2026-11-16T08:00:00.000Z');
    expect(providerSummary(vibeproxy, now, 'en')).toMatch(/^2 accounts · as1 quota used up, available again \S+ \d\d:00$/);
    expect(providerSummary(vibeproxy, now, 'zh')).toMatch(/^2 个账号 · as1 额度用完，\S+ \d\d:00 恢复$/);
  });

  it('counts the magpie route aliases and names the direct sources, and says when the catalog failed', () => {
    const now = new Date('2026-11-16T08:00:00.000Z');
    expect(providerSummary(magpie, now, 'en')).toBe('2 route aliases · Direct: deepseek, qwen');
    expect(providerSummary(magpie, now, 'zh')).toBe('2 个路由别名 · 直连 deepseek、qwen');
    expect(providerSummary({ ...magpie, problem: 'timeout' }, now, 'en')).toBe('Could not get the catalog');
  });

  it('puts the magpie route aliases in their own section, titled as chosen by magpie', () => {
    const sections = librarySections(providerGroup(magpie, new Set()), 'en');
    expect(sections.map((section) => [section.title, section.models.map((entry) => entry.id)])).toEqual([
      ['Chosen by magpie', ['auto/deepseek-flash', 'auto/fast']],
      ['deepseek', ['deepseek/deepseek-flash']],
      ['qwen', ['qwen/qwen-max']],
    ]);
    expect(librarySections(providerGroup(magpie, new Set()), 'zh')[0]!.title).toBe('由 magpie 选');
  });
});

describe('the add model request', () => {
  const withPreset = settings([vibeproxy, { ...magpie, preset: 'magpie' }]);

  it('fills the vibeproxy default address and account prefix, and picks a free name', () => {
    expect(freeProviderName('vibeproxy', ['vibeproxy', 'vibeproxy-2'])).toBe('vibeproxy-3');
    expect(addModelRequest(form({ kind: 'vibeproxy' }), withPreset, 'en')).toEqual({
      ok: true,
      input: { name: 'vibeproxy-2', baseUrl: 'http://127.0.0.1:8317/v1', api: 'openai-completions', accountPrefix: true, preset: 'vibeproxy' },
    });
  });

  it('needs an address for magpie and sends accountPrefix false', () => {
    expect(addModelRequest(form({ kind: 'magpie' }), withPreset, 'en')).toEqual({ ok: false, problem: 'Enter the address.' });
    expect(addModelRequest(form({ kind: 'magpie', baseUrl: 'https://magpie.example.com/v1/', apiKey: ' mk-1 ' }), withPreset, 'en')).toEqual({
      ok: true,
      input: { name: 'magpie-2', baseUrl: 'https://magpie.example.com/v1', api: 'openai-completions', apiKey: 'mk-1', accountPrefix: false, preset: 'magpie' },
    });
  });

  it('names a custom provider from its host when the name is empty, and checks a typed name', () => {
    expect(addModelRequest(form({ baseUrl: 'https://api.example.com/v1', api: 'openai-responses' }), withPreset, 'en')).toEqual({
      ok: true, input: { name: 'example', baseUrl: 'https://api.example.com/v1', api: 'openai-responses', preset: 'custom' },
    });
    expect(addModelRequest(form({ name: 'Azure DS', baseUrl: 'https://api.example.com/v1' }), withPreset, 'en'))
      .toEqual({ ok: false, problem: expect.stringContaining('lowercase letters') });
    expect(addModelRequest(form({ name: 'magpie', baseUrl: 'https://api.example.com/v1' }), withPreset, 'en'))
      .toEqual({ ok: false, problem: 'A provider with the name magpie already exists.' });
  });

  // 旧 daemon 的 save_provider 是严格的 schema，不认 preset：它给的服务商没有 preset 字段时不发。
  it('does not send the preset to a daemon that does not know it', () => {
    const { preset: _preset, ...legacy } = vibeproxy;
    const old = settings([legacy]);
    expect(addModelRequest(form({ kind: 'vibeproxy' }), old, 'en')).toEqual({
      ok: true, input: { name: 'vibeproxy-2', baseUrl: 'http://127.0.0.1:8317/v1', api: 'openai-completions', accountPrefix: true },
    });
  });

  it('knows when the daemon gives subscriptions', () => {
    expect(hasSubscriptionField(settings([vibeproxy]))).toBe(false);
    expect(hasSubscriptionField(settings([vibeproxy], { subscriptions: { subscriptions: [], logins: [], multiPass: true } }))).toBe(true);
  });
});

describe('the add model panel', () => {
  it('adds a magpie gateway and then shows the route aliases and sources it found', async () => {
    const added = { ...magpie, name: 'magpie', preset: 'magpie' as const };
    const { runtime, perform } = addRuntime(settings([vibeproxy]), settings([vibeproxy, added]));
    renderWithRuntime(<ModelRoute />, runtime);
    fireEvent.click(screen.getByTestId('model-add-open'));
    expect(await screen.findByTestId('model-add-panel')).toBeTruthy();
    // 没有订阅时只有 API key，没有 tab。
    expect(screen.queryByTestId('model-add-tabs')).toBeNull();
    fireEvent.click(screen.getByTestId('model-add-kind-2'));
    expect(screen.getByTestId('model-add-status').textContent).toBe('Name: magpie');
    expect((screen.getByTestId('model-add-key') as HTMLInputElement).type).toBe('password');
    fireEvent.click(screen.getByTestId('model-add-save'));
    expect(screen.getByTestId('model-add-status').textContent).toBe('Enter the address.');
    expect(modelCalls(perform)).toEqual([]);
    fireEvent.change(screen.getByTestId('model-add-url'), { target: { value: 'https://gateway.example.com/v1' } });
    fireEvent.change(screen.getByTestId('model-add-key'), { target: { value: 'mk-secret' } });
    await act(async () => { fireEvent.click(screen.getByTestId('model-add-save')); });
    expect(perform).toHaveBeenCalledWith('model_settings', 'models', 'save_provider', expect.anything());
    expect(inputOf(perform)).toEqual({
      name: 'magpie', baseUrl: 'https://gateway.example.com/v1', api: 'openai-completions', apiKey: 'mk-secret', accountPrefix: false, preset: 'magpie',
    });
    await waitFor(() => expect(screen.getByTestId('model-add-result-summary').textContent).toBe('Found 4 models'));
    expect(screen.getByTestId('model-add-result-aliases').textContent).toContain('Chosen by magpie');
    expect(screen.getByTestId('model-add-result-source-qwen').textContent).toContain('qwen/qwen-max');
    fireEvent.click(screen.getByTestId('model-add-done'));
    await waitFor(() => expect(screen.queryByTestId('model-add-panel')).toBeNull());
  });

  it('prefills the vibeproxy address and shows the accounts it found', async () => {
    const { runtime, perform } = addRuntime(settings([magpie]), settings([magpie, vibeproxy]));
    renderWithRuntime(<ModelRoute />, runtime);
    fireEvent.click(screen.getByTestId('model-add-open'));
    fireEvent.click(await screen.findByTestId('model-add-kind-1'));
    expect((screen.getByTestId('model-add-url') as HTMLInputElement).value).toBe('http://127.0.0.1:8317/v1');
    await act(async () => { fireEvent.click(screen.getByTestId('model-add-save')); });
    // magpie 没有 preset 字段（旧 daemon 的样子）：不发 preset。
    expect(inputOf(perform)).toEqual({ name: 'vibeproxy', baseUrl: 'http://127.0.0.1:8317/v1', api: 'openai-completions', accountPrefix: true });
    await waitFor(() => expect(screen.getByTestId('model-add-result-summary').textContent).toBe('Found 2 accounts · 4 models'));
    expect(screen.getByTestId('model-add-result-account-as1').textContent).toContain('Quota used up');
  });

  it('shows the catalog problem after adding a custom provider whose catalog fails', async () => {
    const broken: ModelProvider = { ...magpie, name: 'example', models: [], problem: 'HTTP 401', preset: 'custom' };
    const { runtime, perform } = addRuntime(settings([vibeproxy]), settings([vibeproxy, broken]));
    renderWithRuntime(<ModelRoute />, runtime);
    fireEvent.click(screen.getByTestId('model-add-open'));
    fireEvent.change(await screen.findByTestId('model-add-url'), { target: { value: 'https://api.example.com/v1' } });
    expect(screen.getByTestId('model-add-status').textContent).toBe('Models are written as example/model id.');
    fireEvent.click(screen.getByTestId('model-add-advanced-toggle'));
    fireEvent.click(screen.getByText('Responses'));
    await act(async () => { fireEvent.click(screen.getByTestId('model-add-save')); });
    expect(inputOf(perform)).toEqual({ name: 'example', baseUrl: 'https://api.example.com/v1', api: 'openai-responses', preset: 'custom' });
    await waitFor(() => expect(screen.getByTestId('model-add-result-problem').textContent).toContain('HTTP 401'));
  });

  it('shows the subscription tab only when the daemon gives subscriptions', async () => {
    const { runtime } = addRuntime(settings([vibeproxy], { subscriptions: { subscriptions: [], logins: [], multiPass: true } }));
    renderWithRuntime(<ModelRoute />, runtime);
    fireEvent.click(screen.getByTestId('model-add-open'));
    expect(await screen.findByTestId('model-add-tabs')).toBeTruthy();
    fireEvent.click(screen.getByTestId('model-add-tab-subscription'));
    // 订阅 tab 的内容在 subscriptions.test.tsx 里测。
    expect(screen.getByTestId('subscription-add-choose')).toBeTruthy();
    expect(screen.queryByTestId('model-add-save')).toBeNull();
  });

  it('opens in the right drawer of the desktop settings page', async () => {
    const { runtime } = addRuntime(settings([vibeproxy]));
    renderWithRuntime(<SettingsDesktopShell selected="model" onSelect={() => {}} onExit={() => {}}><ModelRoute /></SettingsDesktopShell>, runtime);
    expect(screen.queryByTestId('settings-drawer')).toBeNull();
    fireEvent.click(screen.getByTestId('model-add-open'));
    const drawer = await screen.findByTestId('settings-drawer');
    expect(drawer.querySelector('[data-testid="model-add-panel"]')).toBeTruthy();
    fireEvent.click(screen.getByTestId('model-add-close'));
    await waitFor(() => expect(screen.queryByTestId('model-add-panel')).toBeNull());
  });
});
