// 设置 → 模型的「后台工作」卡的文案（2026-11-20，.scratch/background-models/spec.md）。
import type { BackgroundModelSource } from '@pi-lead-child/protocol';

import { defineMessages } from '@/i18n';

// background_model.read 的 jobs 里会出现的任务。别的名字原样显示。
export const BACKGROUND_JOBS = ['background_model', 'channel_memory', 'hindsight'] as const;
export type BackgroundJobName = typeof BACKGROUND_JOBS[number];

const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

export const backgroundMessages = defineMessages({
  en: {
    title: 'Background work',
    intro: (leadName: string) =>
      `These are the model calls outside ${leadName}'s turns: notes from external conversations, summaries and long-term memory. They use a cheap model.`,
    loading: 'Loading the background work…',
    loadFailed: (reason: string) => `Could not load the background work: ${reason}`,
    unsupported: 'The daemon on this Mac is too old for this setting. Update Bytezard Lead.',
    modelLabel: 'Background model',
    automatic: (model: string | null) => (model ? `Automatic: cheapest suitable (${model})` : 'Automatic: cheapest suitable'),
    cheapGroup: 'Cheap now',
    otherGroup: 'Not cheap',
    cheapTag: 'Cheap',
    notCheapTag: (leadName: string) => `Not cheap. You can choose it. ${leadName} cannot.`,
    pausedTag: (until: string) => `Paused until ${until}`,
    modelsFailed: (reason: string) => `Could not load the other models: ${reason}`,
    rule: (leadName: string, main: string | null) =>
      `${leadName} can change this model, but only to a cheap model. A model is cheap when its input and output prices are each at most a quarter of the price of ${main ?? `${leadName}'s model`}.`
      + ' The system calculates this from the current prices. The list changes when your subscription changes or a new model comes out.',
    source: {
      setting: (model: string | null, leadName: string) => `In use: ${model ?? 'none'}. You or ${leadName} chose it.`,
      cheap: (model: string | null) => `In use: ${model ?? 'none'}, the newest cheap model.`,
      cheapest: (model: string | null, leadName: string) =>
        `No model is cheap now. In use: ${model ?? 'none'}, the cheapest model that does not cost more than ${leadName}'s model.`,
      main: (model: string | null, leadName: string) => `No model has a price. In use: ${model ?? 'none'}, ${leadName}'s own model.`,
      none: () => 'No model is known yet.',
    } satisfies Record<BackgroundModelSource, (model: string | null, leadName: string) => string>,
    jobsLabel: 'Background jobs today',
    jobs: {
      background_model: 'Judgments and summaries',
      channel_memory: 'Notes from Slack and other channels',
      hindsight: 'Long-term memory (Hindsight)',
    } satisfies Record<BackgroundJobName, string>,
    noJobs: 'No background calls are recorded yet.',
    today: (calls: number, failures: number) => `${count(calls, 'call', 'calls')}, ${count(failures, 'failure', 'failures')}`,
    ok: 'OK',
    failingSince: (since: string) => `Failing since ${since}`,
    failing: 'Failing',
    reason: (reason: string) => `Reason: ${reason}`,
    action: (action: string) => `What the system did: ${action}`,
    brokenLabel: 'Paused models',
    broken: (until: string, reason: string) => `Paused for 1 hour, until ${until}. Reason: ${reason}`,
    saving: 'Saving…',
    failed: (reason: string) => `Not saved: ${reason}`,
    footnote: 'Each change saves at once and applies from the next background call. All devices use the same setting.',
  },
  zh: {
    title: '后台工作',
    intro: (leadName) => `这些是 ${leadName} 的回合以外的模型调用：外部对话的笔记、摘要和长期记忆。它们用便宜的模型。`,
    loading: '正在读取后台工作…',
    loadFailed: (reason) => `没有读到后台工作：${reason}`,
    unsupported: '这台 Mac 上的 daemon 太旧，没有这一项。请更新 Bytezard Lead。',
    modelLabel: '后台模型',
    automatic: (model) => (model ? `自动：最便宜的合适模型（${model}）` : '自动：最便宜的合适模型'),
    cheapGroup: '现在便宜的',
    otherGroup: '不便宜的',
    cheapTag: '便宜',
    notCheapTag: (leadName) => `不便宜。你可以选，${leadName} 不能选。`,
    pausedTag: (until) => `暂停到 ${until}`,
    modelsFailed: (reason) => `没有读到其他模型：${reason}`,
    rule: (leadName, main) =>
      `${leadName} 可以自己换这个模型，但只能换成便宜的模型。输入和输出的价格都不超过 ${main ?? `${leadName} 的模型`} 的四分之一，就算便宜。`
      + '系统按现在的价格算，所以换订阅或者出了新模型时，列表跟着变。',
    source: {
      setting: (model, leadName) => `现在用 ${model ?? '没有'}，是你或 ${leadName} 选的。`,
      cheap: (model) => `现在用 ${model ?? '没有'}，是最新的便宜模型。`,
      cheapest: (model, leadName) => `现在没有便宜的模型。现在用 ${model ?? '没有'}，是不比 ${leadName} 的模型贵的最便宜的模型。`,
      main: (model, leadName) => `没有模型有价格。现在用 ${model ?? '没有'}，就是 ${leadName} 自己的模型。`,
      none: () => '还不知道有哪些模型。',
    },
    jobsLabel: '今天的后台任务',
    jobs: {
      background_model: '判断和摘要',
      channel_memory: 'Slack 等外部对话的笔记',
      hindsight: '长期记忆（Hindsight）',
    },
    noJobs: '还没有记录到后台调用。',
    today: (calls, failures) => `调用 ${calls} 次，失败 ${failures} 次`,
    ok: '正常',
    failingSince: (since) => `从 ${since} 起一直失败`,
    failing: '一直失败',
    reason: (reason) => `原因：${reason}`,
    action: (action) => `系统已经做了：${action}`,
    brokenLabel: '暂停的模型',
    broken: (until, reason) => `暂停 1 小时，到 ${until}。原因：${reason}`,
    saving: '正在保存…',
    failed: (reason) => `没有保存成功：${reason}`,
    footnote: '改了马上保存，下一次后台调用起生效。所有设备用同一个设置。',
  },
});
