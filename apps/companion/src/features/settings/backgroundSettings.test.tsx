// @vitest-environment happy-dom
// 设置 → 模型的「后台工作」卡（2026-11-20，.scratch/background-models/spec.md）：后台模型是一个下拉，第一项自动（写出现在是哪个），
// 然后是现在便宜的模型，再下面是不便宜的模型。选了马上保存（操作层的 background_model.set），只交选的那个模型；没保存成功时写原因，
// 下拉退回。每个后台任务一行：今天的次数和状态；一直失败时写从什么时候起、原因、系统做了什么。旧 daemon 不认识这个操作时只写一行说明。
// 契约在 packages/protocol/src/background-model.ts；客户端方法是假的。
import { ControlPlaneClientError } from '@pi-lead-child/client';
import type { BackgroundModelReadResult, SetBackgroundModelRequest } from '@pi-lead-child/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithRuntime } from '../../../test/connections';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { BackgroundSection } from './BackgroundSection';
import { backgroundMessages } from './background.messages';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/settings/model', Slot: () => null, Stack: () => null }));

const MAIN = 'magpie/codex/gpt-sol';
const LUNA = 'magpie/codex/gpt-luna';
const FLASH = 'magpie/auto/deepseek-flash';
const TERRA = 'magpie/codex/gpt-terra';

const READ: BackgroundModelReadResult = {
  setting: null,
  resolved: LUNA,
  source: 'cheap',
  main: MAIN,
  cheap: [LUNA, FLASH],
  broken: [],
  jobs: [
    { job: 'background_model', state: 'ok', since: null, reasonClass: null, reason: null, action: null, callsToday: 42, failuresToday: 0 },
    { job: 'channel_memory', state: 'ok', since: null, reasonClass: null, reason: null, action: null, callsToday: 1, failuresToday: 1 },
  ],
};

type Options = { fail?: string; read?: Error };

function backgroundRuntime(initial: BackgroundModelReadResult, options: Options = {}) {
  let current = initial;
  const option = (model: string) => ({
    model, provider: 'magpie', id: model.slice('magpie/'.length), prefix: null, source: null, name: null,
    image: false, efforts: [], defaultEffort: null, blockedUntil: null,
  });
  const fake = {
    getLeadModels: vi.fn(async () => ({
      current: { model: MAIN, effort: null }, selected: { model: MAIN, effort: null }, models: [MAIN, TERRA, LUNA, FLASH].map(option),
    })),
    performUiAction: vi.fn(async (type: string, id: string, action: string, request: { input: unknown }) => {
      if (action === 'read') {
        if (options.read) throw options.read;
        return { target: { type, id }, action, result: current };
      }
      if (options.fail) throw new Error(options.fail);
      const { model } = request.input as SetBackgroundModelRequest;
      current = { ...current, setting: model, resolved: model ?? current.cheap[0] ?? null, source: model ? 'setting' : 'cheap' };
      return { target: { type, id }, action, result: { changed: true } };
    }),
  };
  const runtime = createCompanionStateRuntime({
    client: fake as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  return { runtime, client: fake };
}

async function render(runtime: ReturnType<typeof backgroundRuntime>['runtime']) {
  await act(async () => { renderWithRuntime(<BackgroundSection />, runtime); });
}

// react-native-web 的 measureInWindow 是异步的：量完位置才打开下拉。
async function openModels() {
  fireEvent.click(screen.getByTestId('background-model-input'));
  await screen.findByTestId('background-model-input-panel');
}

const text = (testID: string) => screen.getByTestId(testID).textContent ?? '';
const setCalls = (client: ReturnType<typeof backgroundRuntime>['client']) =>
  client.performUiAction.mock.calls.filter((call) => call[2] === 'set');

describe('the background work card', () => {
  it('shows the automatic choice with the model it resolves to', async () => {
    const { runtime, client } = backgroundRuntime(READ);
    await render(runtime);
    expect(client.performUiAction).toHaveBeenCalledWith('background_model', 'lead', 'read', { input: {} });
    expect(text('background-model-value')).toBe(`Automatic: cheapest suitable (${LUNA})`);
    expect(text('background-model-source')).toBe(`In use: ${LUNA}, the newest cheap model.`);
    expect(text('background-model')).toContain(`at most a quarter of the price of ${MAIN}`);
    expect(text('background-model')).toContain('Paimon can change this model, but only to a cheap model.');
  });

  it('lists the cheap models first, then the other catalog models as not cheap', async () => {
    const { runtime } = backgroundRuntime(READ);
    await render(runtime);
    await openModels();
    const panel = screen.getByTestId('background-model-input-panel');
    const order = [...panel.querySelectorAll('[data-testid^="background-model-"]')]
      .map((node) => node.getAttribute('data-testid'))
      .filter((id) => id !== 'background-model-input-panel');
    expect(order).toEqual([
      'background-model-auto',
      'background-model-cheap-group',
      `background-model-${LUNA}`,
      `background-model-${FLASH}`,
      'background-model-other-group',
      `background-model-${MAIN}`,
      `background-model-${TERRA}`,
    ]);
    expect(text(`background-model-${FLASH}`)).toContain('Cheap');
    expect(text(`background-model-${TERRA}`)).toContain('Not cheap. You can choose it. Paimon cannot.');
  });

  it('saves only the picked model, then reads the state again', async () => {
    const { runtime, client } = backgroundRuntime(READ);
    await render(runtime);
    await openModels();
    await act(async () => { fireEvent.click(screen.getByTestId(`background-model-${TERRA}`)); });
    expect(setCalls(client)).toEqual([['background_model', 'lead', 'set', { input: { model: TERRA } }]]);
    expect(client.performUiAction.mock.calls.filter((call) => call[2] === 'read')).toHaveLength(2);
    expect(text('background-model-value')).toBe(TERRA);
    expect(text('background-model-source')).toBe(`In use: ${TERRA}. You or Paimon chose it.`);

    await openModels();
    await act(async () => { fireEvent.click(screen.getByTestId('background-model-auto')); });
    expect(setCalls(client).at(-1)).toEqual(['background_model', 'lead', 'set', { input: { model: null } }]);
    expect(text('background-model-value')).toBe(`Automatic: cheapest suitable (${LUNA})`);
  });

  it('shows why the change did not save, and goes back to the saved choice', async () => {
    const { runtime } = backgroundRuntime(READ, { fail: 'The model is not in the catalog' });
    await render(runtime);
    await openModels();
    await act(async () => { fireEvent.click(screen.getByTestId(`background-model-${TERRA}`)); });
    expect(text('background-error')).toBe('Not saved: The model is not in the catalog');
    expect(text('background-model-value')).toBe(`Automatic: cheapest suitable (${LUNA})`);
    expect(text('background-footnote')).toContain('Each change saves at once');
  });

  it('shows today\'s calls, and for a failing job since when, why and what the system did', async () => {
    const { runtime } = backgroundRuntime({
      ...READ,
      broken: [{ model: FLASH, until: '2026-11-20T09:30:00', reason: 'quota' }],
      jobs: [
        {
          job: 'background_model', state: 'failing', since: '2026-11-20T08:12:00', reasonClass: 'config',
          reason: 'model not found (404)', action: `switched to ${LUNA}`, callsToday: 7, failuresToday: 4,
        },
        { job: 'hindsight', state: 'ok', since: null, reasonClass: null, reason: null, action: null, callsToday: 1, failuresToday: 0 },
      ],
    });
    await render(runtime);
    expect(text('background-job-background_model')).toContain('Judgments and summaries');
    expect(text('background-job-background_model-state')).toBe('Failing since 11-20 08:12');
    expect(text('background-job-background_model')).toContain('7 calls, 4 failures');
    expect(text('background-job-background_model')).toContain('Reason: model not found (404)');
    expect(text('background-job-background_model')).toContain(`What the system did: switched to ${LUNA}`);
    expect(text('background-job-hindsight-state')).toBe('OK');
    expect(text('background-job-hindsight')).toContain('1 call, 0 failures');
    expect(text(`background-broken-${FLASH}`)).toContain('Paused for 1 hour, until 11-20 09:30. Reason: quota');
  });

  it('says the daemon is too old when it does not know the operation', async () => {
    const { runtime } = backgroundRuntime(READ, { read: new ControlPlaneClientError('没有这种目标：background_model', 'not_found', 404) });
    await render(runtime);
    expect(text('background-unsupported')).toBe('The daemon on this Mac is too old for this setting. Update Bytezard Lead.');
    expect(screen.queryByTestId('background-section')).toBeNull();
  });

  it('shows the reason when the state cannot be read', async () => {
    const { runtime } = backgroundRuntime(READ, { read: new ControlPlaneClientError('Lead 的会话还没建好', 'unavailable', 409) });
    await render(runtime);
    expect(text('background-loading')).toBe('Could not load the background work: Lead 的会话还没建好');
  });

  it('has the same texts in Chinese, with the Lead name', () => {
    const zh = backgroundMessages('zh');
    expect(zh.title).toBe('后台工作');
    expect(zh.automatic(LUNA)).toBe(`自动：最便宜的合适模型（${LUNA}）`);
    expect(zh.notCheapTag('Fairy')).toBe('不便宜。你可以选，Fairy 不能选。');
    expect(zh.failingSince('11-20 08:12')).toBe('从 11-20 08:12 起一直失败');
    expect(zh.today(7, 4)).toBe('调用 7 次，失败 4 次');
    expect(zh.rule('Fairy', MAIN)).toContain(`输入和输出的价格都不超过 ${MAIN} 的四分之一，就算便宜。`);
  });
});
