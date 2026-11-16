// @vitest-environment happy-dom
// 设置 → 模型的订阅（模型配置方案 C 的 S3，.scratch/model-config-c/spec.md）：接入列表的订阅行、添加面板的订阅 tab（两种登录）、订阅详情。
// 登录的每个状态都来自模型设置 DTO 的 subscriptions.logins：测试直接换 store 里的 DTO，模拟 daemon 推来的新状态。
import type {
  ModelSettingsDto, Subscription, SubscriptionAccount, SubscriptionLogin, SubscriptionModel,
} from '@pi-lead-child/protocol';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithRuntime, setViewportWidth } from '../../../test/connections';
import ModelRoute from '../../app/settings/model';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { SettingsDesktopShell } from './SettingsDesktopShell';
import {
  activeAccount, clockLabel, daysLabel, quotaBars, subscriptionSummary, subscriptionUse, windowFromForm, windowLabel,
} from './subscriptionsModel';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), canGoBack: () => false, dismissTo: vi.fn() }),
  usePathname: () => '/settings/model', Slot: () => null, Stack: () => null,
}));

const NOW = new Date('2026-11-16T10:00:00');
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

function account(provider: string, index: number, extra: Partial<SubscriptionAccount> = {}): SubscriptionAccount {
  return {
    provider, index, label: null, loggedIn: true, email: null, plan: null, quota: null, coolingUntil: null, role: 'default', windows: [], inUse: false, ...extra,
  };
}

function quota(fiveHoursLeft: number, sevenDaysLeft: number) {
  return {
    windows: [
      { label: '5h', remainingPercent: fiveHoursLeft, resetAt: later(160) },
      { label: '7d', remainingPercent: sevenDaysLeft, resetAt: later(3 * 24 * 60) },
    ],
    checkedAt: NOW.toISOString(),
    problem: null,
  };
}

function model(base: string, id: string, extra: Partial<SubscriptionModel> = {}): SubscriptionModel {
  return { model: `${base}/${id}`, id, name: null, image: false, contextWindow: 400_000, efforts: [], ...extra };
}

const work = account('openai-codex', 1, { label: 'Work', email: 'alice@example.com', plan: 'pro', quota: quota(76, 59), inUse: true });
const personal = account('openai-codex-2', 2, { label: 'Personal', email: 'bob@example.com', plan: 'plus', quota: quota(9, 37) });
const codex: Subscription = {
  base: 'openai-codex', accounts: [work, personal], strategy: 'quota-first', quotaSupported: true,
  models: [model('openai-codex', 'gpt-5.5', { name: 'GPT-5.5', image: true }), model('openai-codex', 'gpt-5.5-codex'), model('openai-codex', 'gpt-5.5-mini'),
    model('openai-codex', 'o9')],
};
const copilot: Subscription = {
  base: 'github-copilot', accounts: [account('github-copilot', 1, { label: 'Work' })], strategy: 'round-robin', quotaSupported: false,
  models: [model('github-copilot', 'claude-sonnet-5.5')],
};
const noAccounts = (base: Subscription['base'], quotaSupported: boolean): Subscription => ({ base, accounts: [], strategy: 'round-robin', quotaSupported, models: [] });

function settings(subscriptions: Subscription[], logins: SubscriptionLogin[] = [], current = 'openai-codex-2/gpt-5.5'): ModelSettingsDto {
  return {
    brain: {
      chain: [{ model: 'openai-codex/gpt-5.5', effort: 'high' }, { model: 'github-copilot/claude-sonnet-5.5', effort: null }],
      current: { model: current, effort: null }, providers: [],
    },
    fast: { models: [], chain: [], llmFallback: null, effectiveLlm: null },
    maxBackups: 3,
    subscriptions: { subscriptions, logins, multiPass: true },
  };
}

function login(extra: Partial<SubscriptionLogin>): SubscriptionLogin {
  return {
    id: 'login-1', base: 'openai-codex', provider: 'openai-codex-3', label: 'Side', state: 'starting', authUrl: null, deviceCode: null,
    awaitingCode: false, progress: null, error: null, startedAt: new Date(Date.now() - 42_000).toISOString(), ...extra,
  };
}

type Perform = (type: string, id: string, action: string, request: unknown) => Promise<{ target: unknown; action: string; result: unknown }>;
type Reply = { result?: unknown; error?: string; next?: ModelSettingsDto };

// 假的客户端：每个操作按 replies 回答；给了 next 时，下一次读模型设置拿到它。
function subscriptionRuntime(initial: ModelSettingsDto, replies: Record<string, Reply> = {}) {
  let current = initial;
  const perform = vi.fn<Perform>(async (_type, _id, action) => {
    const reply = replies[action] ?? {};
    if (reply.error) throw new Error(reply.error);
    if (reply.next) current = reply.next;
    return { target: { type: 'model_settings', id: 'models' }, action, result: reply.result ?? { summary: 'ok', note: null } };
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
    phase: 'ready', connectionState: 'connected', modelSettings: initial, memory: null,
    resourceState: { ...state.resourceState, memory: ready, 'decision-model': ready, 'model-settings': ready },
  }));
  // daemon 推来新状态（snapshot.required 以后重取到的）。
  const push = (next: ModelSettingsDto) => {
    current = next;
    act(() => { runtime.control.setState({ modelSettings: next }); });
  };
  return { runtime, perform, push };
}

const inputOf = (perform: ReturnType<typeof vi.fn>, call = 0) => (perform.mock.calls[call]![3] as { input: unknown }).input;
const actionOf = (perform: ReturnType<typeof vi.fn>, call = 0) => perform.mock.calls[call]![2];

beforeEach(() => {
  vi.clearAllMocks();
  setViewportWidth(1280);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the rules of the subscription rows', () => {
  it('shows the used part of each quota window and marks it when it is nearly used up', () => {
    const bars = quotaBars(personal, NOW, 'en');
    expect(bars.map((bar) => [bar.name, bar.used, bar.near, bar.percent])).toEqual([['5h', 91, true, '91%'], ['7d', 63, false, '63%']]);
    expect(bars[0]!.detail).toBe('91% · resets 12:40');
    expect(quotaBars(personal, NOW, 'zh').map((bar) => bar.name)).toEqual(['5 小时', '7 天']);
    expect(quotaBars(copilot.accounts[0]!, NOW, 'en')).toEqual([]);
  });

  it('marks the account in use only when the daemon can know it', () => {
    expect(activeAccount(settings([codex]), codex)).toBe('openai-codex-2');
    // <base>/<id> with two accounts: pi-multi-pass picks the account in its pool, so no account is marked.
    expect(activeAccount(settings([codex], [], 'openai-codex/gpt-5.5'), codex)).toBeNull();
    expect(activeAccount(settings([copilot], [], 'github-copilot/claude-sonnet-5.5'), copilot)).toBe('github-copilot');
    expect(activeAccount(settings([copilot], [], 'magpie/auto/fast'), copilot)).toBeNull();
  });

  it('writes the account count, the strategy and the place in the assignment', () => {
    const dto = settings([codex, copilot]);
    expect(subscriptionSummary(codex, 'en')).toBe('2 accounts · Most quota first');
    expect(subscriptionSummary(copilot, 'zh')).toBe('1 个账号');
    expect(subscriptionUse(dto, codex, 'en')).toBe('4 models · Primary');
    expect(subscriptionUse(dto, copilot, 'en')).toBe('1 model · Backup 1');
  });

  it('turns the hours form into a time window and names it', () => {
    expect(windowFromForm({ days: ['fri', 'mon', 'tue', 'wed', 'thu'], from: '9', to: '17' }, 'en'))
      .toEqual({ ok: true, window: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], hours: [9, 17] } });
    expect(windowFromForm({ days: ['sat'], from: '22', to: '6' }, 'en')).toEqual({ ok: true, window: { days: ['sat'], hours: [22, 6] } });
    expect(windowFromForm({ days: [], from: '9', to: '17' }, 'en')).toMatchObject({ ok: false });
    expect(windowFromForm({ days: ['mon'], from: '9', to: '25' }, 'en')).toMatchObject({ ok: false });
    expect(windowLabel({ days: ['mon', 'tue', 'wed', 'thu', 'fri'], hours: [9, 17] }, 'zh')).toBe('工作日 9–17');
    expect(daysLabel(['mon', 'wed'], 'en')).toBe('Mon, Wed');
    expect(clockLabel(42_000)).toBe('0:42');
    expect(clockLabel(860_000)).toBe('14:20');
  });
});

describe('the subscription group in the connections card', () => {
  it('shows one row for each subscription and one row for each account, with quota only for Codex', () => {
    const { runtime } = subscriptionRuntime(settings([codex, copilot]));
    renderWithRuntime(<ModelRoute />, runtime);
    expect(screen.getByTestId('model-sources-subscriptions').textContent).toBe('Subscriptions');
    expect(screen.getByTestId('subscription-row-summary-openai-codex').textContent).toBe('2 accounts · Most quota first');
    expect(screen.getByTestId('subscription-row-use-openai-codex').textContent).toBe('4 models · Primary');
    // 快用完的那一条：琥珀色，读屏的名字里写「快用完了」，不只靠颜色。
    const near = screen.getByTestId('subscription-account-row-quota-openai-codex-2-5h-0');
    expect(near.getAttribute('aria-label')).toBe('5h: 91% used · Nearly used up');
    expect(screen.getByTestId('subscription-account-row-quota-openai-codex-7d-1').getAttribute('aria-label')).toBe('7d: 41% used');
    expect(screen.getByTestId('subscription-account-row-active-openai-codex-2').textContent).toBe('In use');
    expect(screen.queryByTestId('subscription-account-row-active-openai-codex')).toBeNull();
    expect(screen.getByTestId('subscription-account-row-status-github-copilot').textContent).toContain('GitHub gives no quota check');
  });

  it('says how to add one when there is no subscription', () => {
    const { runtime } = subscriptionRuntime(settings([noAccounts('openai-codex', true), noAccounts('github-copilot', false)]));
    renderWithRuntime(<ModelRoute />, runtime);
    expect(screen.getByTestId('subscription-rows-empty').textContent).toContain('Add model');
  });

  it('has no subscription group for a daemon that does not give subscriptions', () => {
    const { subscriptions: _subscriptions, ...legacy } = settings([codex]);
    const { runtime } = subscriptionRuntime(legacy);
    renderWithRuntime(<ModelRoute />, runtime);
    expect(screen.queryByTestId('model-sources-subscriptions')).toBeNull();
  });
});

// 打开「添加模型」的订阅 tab，选一种订阅。
async function openSubscriptionTab(base?: 'openai-codex' | 'github-copilot') {
  fireEvent.click(screen.getByTestId('model-add-open'));
  fireEvent.click(await screen.findByTestId('model-add-tab-subscription'));
  if (base) fireEvent.click(screen.getByTestId(`subscription-add-${base}`));
}

describe('the subscription tab of the add panel', () => {
  it('lists both subscriptions and says what is already connected', async () => {
    const { runtime } = subscriptionRuntime(settings([codex, noAccounts('github-copilot', false)]));
    renderWithRuntime(<ModelRoute />, runtime);
    await openSubscriptionTab();
    expect(screen.getByTestId('subscription-add-openai-codex-sub').textContent).toBe('Connected: 2 · Work, Personal');
    expect(screen.getByTestId('subscription-add-github-copilot-sub').textContent).toBe('Pro / Pro+ / Business');
  });

  it('logs in to Codex in a new browser tab and takes a pasted address', async () => {
    const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const started = settings([codex], [login({})]);
    const { runtime, perform, push } = subscriptionRuntime(settings([codex]), {
      start_subscription_login: { result: { summary: 'ok', note: null, login: 'login-1' }, next: started },
    });
    renderWithRuntime(<ModelRoute />, runtime);
    await openSubscriptionTab('openai-codex');
    fireEvent.change(screen.getByTestId('subscription-login-label'), { target: { value: 'Side' } });
    expect(screen.getByTestId('subscription-login-start').textContent).toBe('Log in to Codex');
    await act(async () => { fireEvent.click(screen.getByTestId('subscription-login-start')); });
    expect(actionOf(perform)).toBe('start_subscription_login');
    expect(inputOf(perform)).toEqual({ base: 'openai-codex', label: 'Side' });
    // 空白标签页在点击里打开，拿到登录地址以后才指过去。
    expect(window.open).toHaveBeenCalledWith('', '_blank');
    await waitFor(() => expect(screen.getByTestId('subscription-login-browser')).toBeTruthy());
    expect(tab.location.href).toBe('');
    expect(screen.getByTestId('subscription-login-waited').textContent).toMatch(/^Waited 0:4\d$/);

    push(settings([codex], [login({ state: 'waiting', authUrl: 'https://auth.example.com/authorize?x=1', awaitingCode: true })]));
    expect(tab.location.href).toBe('https://auth.example.com/authorize?x=1');
    expect(tab.opener).toBeNull();
    expect(screen.getByTestId('subscription-login-browser').textContent).toContain('The login page is open in a new browser tab.');
    // 桌面上粘贴地址收在一个链接后面（浏览器和 daemon 不在同一台电脑时用）。
    fireEvent.click(screen.getByTestId('subscription-login-paste-toggle'));
    fireEvent.change(screen.getByTestId('subscription-login-paste-field'), { target: { value: 'http://localhost:1455/auth/callback?code=abc' } });
    await act(async () => { fireEvent.click(screen.getByTestId('subscription-login-paste-submit')); });
    expect(actionOf(perform, 1)).toBe('submit_subscription_login_code');
    expect(inputOf(perform, 1)).toEqual({ login: 'login-1', code: 'http://localhost:1455/auth/callback?code=abc' });

    const added = account('openai-codex-3', 3, { label: 'Side', email: 'carol@example.com', plan: 'pro' });
    push(settings([{ ...codex, accounts: [work, personal, added] }], [login({ state: 'done' })]));
    expect(screen.getByTestId('subscription-login-result').textContent).toContain('Side · carol@example.com · pro');
    expect(screen.getByTestId('subscription-login-result-models').textContent).toBe('Read 4 models');
    expect(screen.getByTestId('subscription-login-result').textContent).toContain('And 1 more');
    fireEvent.click(screen.getByTestId('subscription-login-done'));
    await waitFor(() => expect(screen.queryByTestId('model-add-panel')).toBeNull());
  });

  it('makes the pasted address the main path on a phone', async () => {
    setViewportWidth(390);
    const open = vi.spyOn(window, 'open');
    const { runtime, perform } = subscriptionRuntime(settings([codex], [
      login({ state: 'waiting', authUrl: 'https://auth.example.com/authorize?x=1', awaitingCode: true }),
    ]));
    renderWithRuntime(<ModelRoute />, runtime);
    // 已经有一次没结束的登录：接着它往下走，不另开一次。
    await openSubscriptionTab('openai-codex');
    expect(screen.getByTestId('subscription-add-back')).toBeTruthy();
    expect(screen.queryByTestId('subscription-login-paste-toggle')).toBeNull();
    expect(screen.getByTestId('subscription-login-paste').textContent).toContain('Open the login page on this phone');
    expect(screen.getByTestId('subscription-login-open')).toBeTruthy();
    fireEvent.change(screen.getByTestId('subscription-login-paste-field'), { target: { value: 'http://localhost:1455/auth/callback?code=abc' } });
    await act(async () => { fireEvent.click(screen.getByTestId('subscription-login-paste-submit')); });
    expect(inputOf(perform)).toEqual({ login: 'login-1', code: 'http://localhost:1455/auth/callback?code=abc' });
    expect(open).not.toHaveBeenCalled();
  });

  it('shows the GitHub device code with a countdown, and gets a new code when it expired', async () => {
    const copilotLogin = (expiresAt: string) => login({
      id: 'login-2', base: 'github-copilot', provider: 'github-copilot-2', label: null, state: 'waiting',
      deviceCode: { code: '8F3K-2QXD', uri: 'https://github.com/login/device', expiresAt },
    });
    const { runtime, perform, push } = subscriptionRuntime(settings([copilot]), {
      start_subscription_login: { result: { summary: 'ok', note: null, login: 'login-2' } },
    });
    const open = vi.spyOn(window, 'open');
    renderWithRuntime(<ModelRoute />, runtime);
    await openSubscriptionTab('github-copilot');
    await act(async () => { fireEvent.click(screen.getByTestId('subscription-login-start')); });
    expect(inputOf(perform)).toEqual({ base: 'github-copilot' });
    // 设备码不开浏览器标签页。
    expect(open).not.toHaveBeenCalled();
    push(settings([copilot], [login({ id: 'login-2', base: 'github-copilot', provider: 'github-copilot-2', label: null })]));
    expect(screen.getByTestId('subscription-login-device-pending').textContent).toBe('Getting the code…');
    push(settings([copilot], [copilotLogin(new Date(Date.now() + 860_500).toISOString())]));
    expect(screen.getByTestId('subscription-login-device-code').textContent).toBe('8F3K-2QXD');
    expect(screen.getByTestId('subscription-login-device-expiry').textContent).toMatch(/expires in 14:2\d\./);
    expect(screen.getByTestId('subscription-login-open-github').textContent).toBe('Copy and open GitHub');
    push(settings([copilot], [copilotLogin(new Date(Date.now() - 1000).toISOString())]));
    expect(screen.getByTestId('subscription-login-device-expiry').textContent).toBe('The code expired.');
    await act(async () => { fireEvent.click(screen.getByTestId('subscription-login-new-code')); });
    expect(actionOf(perform, 1)).toBe('start_subscription_login');
  });

  it('shows why a login failed and tries again, and cancels a login', async () => {
    const { runtime, perform, push } = subscriptionRuntime(settings([codex], [login({ state: 'error', error: 'The login took too long. Start it again.' })]), {
      start_subscription_login: { result: { summary: 'ok', note: 'pi-multi-pass is not loaded yet.', login: 'login-3' } },
      cancel_subscription_login: { next: settings([codex], [login({ id: 'login-3', state: 'cancelled' })]) },
    });
    vi.spyOn(window, 'open').mockReturnValue(null);
    renderWithRuntime(<ModelRoute />, runtime);
    await openSubscriptionTab('openai-codex');
    // 失败的那次不再是「没结束的登录」：先是表单。开始以后才接上新的这次。
    expect(screen.getByTestId('subscription-login-form')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByTestId('subscription-login-start')); });
    expect(screen.getByTestId('subscription-login-message').textContent).toBe('pi-multi-pass is not loaded yet.');
    push(settings([codex], [login({ id: 'login-3', state: 'error', error: 'The login took too long. Start it again.' })]));
    expect(screen.getByTestId('subscription-login-error').textContent).toContain('The login took too long.');
    await act(async () => { fireEvent.click(screen.getByTestId('subscription-login-retry')); });
    expect(actionOf(perform, 1)).toBe('start_subscription_login');
    push(settings([codex], [login({ id: 'login-3', state: 'waiting', authUrl: 'https://auth.example.com/a' })]));
    // 浏览器拦下了空白标签页：写「在浏览器里打开登录页」，有打开和复制的链接。
    expect(screen.getByTestId('subscription-login-browser').textContent).toContain('Open the login page in your browser.');
    await act(async () => { fireEvent.click(screen.getByTestId('subscription-login-cancel')); });
    expect(actionOf(perform, 2)).toBe('cancel_subscription_login');
    expect(inputOf(perform, 2)).toEqual({ login: 'login-3' });
    expect(screen.getByTestId('subscription-login-form')).toBeTruthy();
  });

  it('shows the reason when the daemon refuses to start a login', async () => {
    const { runtime } = subscriptionRuntime(settings([copilot]), { start_subscription_login: { error: 'Only you can do this on the settings page.' } });
    renderWithRuntime(<ModelRoute />, runtime);
    await openSubscriptionTab('github-copilot');
    await act(async () => { fireEvent.click(screen.getByTestId('subscription-login-start')); });
    expect(screen.getByTestId('subscription-login-message').textContent).toContain('Only you can do this');
  });
});

describe('the subscription detail', () => {
  it('opens from the row and shows accounts, quota with reset times and the strategy', async () => {
    const { runtime, perform } = subscriptionRuntime(settings([codex, copilot]));
    renderWithRuntime(<ModelRoute />, runtime);
    fireEvent.click(screen.getByTestId('subscription-row-openai-codex'));
    const detail = await screen.findByTestId('subscription-detail');
    expect(within(detail).getByTestId('subscription-detail-sub').textContent).toBe('ChatGPT subscription · 4 models · Primary');
    expect(within(detail).getByTestId('subscription-account-openai-codex-2').textContent).toContain('bob@example.com · plus');
    expect(within(detail).getByTestId('subscription-account-active-openai-codex-2').textContent).toBe('In use');
    expect(within(detail).getByTestId('subscription-account-quota-openai-codex-2-5h-0').textContent).toContain('91% · resets');
    const radio = within(detail).getByTestId('subscription-strategy-quota-first');
    expect(radio.getAttribute('aria-checked')).toBe('true');
    await act(async () => { fireEvent.click(within(detail).getByTestId('subscription-strategy-scheduled')); });
    expect(actionOf(perform)).toBe('set_subscription_strategy');
    expect(inputOf(perform)).toEqual({ base: 'openai-codex', strategy: 'scheduled' });
  });

  it('says plainly that Copilot has no quota, and that one account does not switch', async () => {
    const { runtime } = subscriptionRuntime(settings([codex, copilot]));
    renderWithRuntime(<ModelRoute />, runtime);
    fireEvent.click(screen.getByTestId('subscription-row-github-copilot'));
    const detail = await screen.findByTestId('subscription-detail');
    expect(detail.textContent).toContain('GitHub gives no quota check, so this panel shows no quota.');
    expect(within(detail).getByTestId('subscription-strategy-one').textContent).toContain('Add a second account');
    expect(within(detail).queryByTestId('subscription-strategy')).toBeNull();
  });

  it('confirms in place before signing out, and shows the refusal as text', async () => {
    const { runtime, perform } = subscriptionRuntime(settings([codex]), {
      remove_subscription_account: { error: 'The brain assignment still uses openai-codex/gpt-5.5. Replace them in "Current assignment" first.' },
    });
    renderWithRuntime(<ModelRoute />, runtime);
    fireEvent.click(screen.getByTestId('subscription-row-openai-codex'));
    await screen.findByTestId('subscription-detail');
    fireEvent.click(screen.getByTestId('subscription-account-more-openai-codex'));
    const menu = await screen.findByTestId('subscription-account-more-openai-codex-panel');
    fireEvent.click(within(menu).getByTestId('subscription-account-remove-openai-codex'));
    expect(screen.getByTestId('subscription-account-remove-confirm-openai-codex').textContent).toContain('Sign out of Work and delete its login?');
    await act(async () => { fireEvent.click(screen.getByTestId('subscription-account-remove-yes-openai-codex')); });
    expect(inputOf(perform)).toEqual({ provider: 'openai-codex' });
    expect(screen.getByTestId('subscription-account-message-openai-codex').textContent).toContain('still uses openai-codex/gpt-5.5');
    expect(screen.queryByTestId('subscription-account-remove-confirm-openai-codex')).toBeNull();
  });

  it('renames an account and logs in to it again', async () => {
    const { runtime, perform } = subscriptionRuntime(settings([codex]), {
      start_subscription_login: { result: { summary: 'ok', note: null, login: 'login-9' } },
    });
    vi.spyOn(window, 'open').mockReturnValue(null);
    renderWithRuntime(<ModelRoute />, runtime);
    fireEvent.click(screen.getByTestId('subscription-row-openai-codex'));
    await screen.findByTestId('subscription-detail');
    fireEvent.click(screen.getByTestId('subscription-account-more-openai-codex-2'));
    fireEvent.click(within(await screen.findByTestId('subscription-account-more-openai-codex-2-panel')).getByTestId('subscription-account-rename-openai-codex-2'));
    fireEvent.change(screen.getByTestId('subscription-account-label-openai-codex-2'), { target: { value: 'Home' } });
    await act(async () => { fireEvent.click(screen.getByTestId('subscription-account-label-save-openai-codex-2')); });
    expect(inputOf(perform)).toEqual({ provider: 'openai-codex-2', label: 'Home' });
    fireEvent.click(screen.getByTestId('subscription-account-more-openai-codex-2'));
    fireEvent.click(within(await screen.findByTestId('subscription-account-more-openai-codex-2-panel')).getByTestId('subscription-account-relogin-openai-codex-2'));
    expect(screen.getByTestId('subscription-login-start').textContent).toBe('Log in to Personal again');
    await act(async () => { fireEvent.click(screen.getByTestId('subscription-login-start')); });
    expect(inputOf(perform, 1)).toEqual({ base: 'openai-codex', provider: 'openai-codex-2' });
  });

  it('sets the role and the hours of an account when the accounts switch by schedule', async () => {
    const scheduled: Subscription = {
      ...codex, strategy: 'scheduled',
      accounts: [{ ...work, role: 'preferred', windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], hours: [9, 17] }] }, personal],
    };
    const { runtime, perform } = subscriptionRuntime(settings([scheduled]));
    renderWithRuntime(<ModelRoute />, runtime);
    fireEvent.click(screen.getByTestId('subscription-row-openai-codex'));
    await screen.findByTestId('subscription-detail');
    expect(screen.getByTestId('subscription-schedule-openai-codex').textContent).toContain('Weekdays 9–17');
    // 角色选了马上保存，时间段不变。
    await act(async () => { fireEvent.click(screen.getByTestId('subscription-role-openai-codex-2-2')); });
    expect(inputOf(perform)).toEqual({ provider: 'openai-codex-2', role: 'overflow', windows: [] });
    fireEvent.click(screen.getByTestId('subscription-window-new-openai-codex'));
    fireEvent.click(screen.getByTestId('subscription-window-day-openai-codex-sat'));
    fireEvent.change(screen.getByTestId('subscription-window-from-openai-codex'), { target: { value: '25' } });
    fireEvent.click(screen.getByTestId('subscription-window-add-openai-codex'));
    expect(screen.getByTestId('subscription-schedule-error-openai-codex').textContent).toContain('enter the hours from 0 to 24');
    fireEvent.change(screen.getByTestId('subscription-window-from-openai-codex'), { target: { value: '20' } });
    fireEvent.change(screen.getByTestId('subscription-window-to-openai-codex'), { target: { value: '23' } });
    await act(async () => { fireEvent.click(screen.getByTestId('subscription-window-add-openai-codex')); });
    expect(inputOf(perform, 1)).toEqual({
      provider: 'openai-codex', role: 'preferred',
      windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], hours: [9, 17] }, { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], hours: [20, 23] }],
    });
    await act(async () => { fireEvent.click(screen.getByTestId('subscription-window-remove-openai-codex-0')); });
    expect(inputOf(perform, 2)).toEqual({ provider: 'openai-codex', role: 'preferred', windows: [] });
  });

  it('opens in the desktop drawer and takes the place of the add panel', async () => {
    const { runtime } = subscriptionRuntime(settings([codex, copilot]));
    renderWithRuntime(<SettingsDesktopShell selected="model" onSelect={() => {}} onExit={() => {}}><ModelRoute /></SettingsDesktopShell>, runtime);
    fireEvent.click(screen.getByTestId('model-add-open'));
    const drawer = await screen.findByTestId('settings-drawer');
    expect(drawer.querySelector('[data-testid="model-add-panel"]')).toBeTruthy();
    fireEvent.click(screen.getByTestId('subscription-row-openai-codex'));
    await waitFor(() => expect(screen.getByTestId('settings-drawer').querySelector('[data-testid="subscription-detail"]')).toBeTruthy());
    expect(screen.queryByTestId('model-add-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('subscription-detail-close'));
    await waitFor(() => expect(screen.queryByTestId('subscription-detail')).toBeNull());
    // 「添加模型」被换掉时已经关上：再点一次还能打开。
    fireEvent.click(screen.getByTestId('model-add-open'));
    expect(await screen.findByTestId('model-add-panel')).toBeTruthy();
  });
});
