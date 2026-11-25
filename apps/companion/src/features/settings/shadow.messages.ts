// 设置 → Shadow 的文案（2026-11-19）。
import type { LeadShadowDto } from '@pi-lead-child/protocol';

import { defineMessages } from '@/i18n';

type Mode = LeadShadowDto['mode'];
type Source = keyof LeadShadowDto['shares'];

export const shadowMessages = defineMessages({
  en: {
    loading: 'Loading the shadow setting…',
    loadFailed: (reason: string) => `Could not load the shadow setting: ${reason}`,
    unsupported: 'The daemon on this Mac is too old for this setting. Update Bytezard Lead.',
    title: (leadName: string) => `${leadName}'s shadow`,
    intro: (leadName: string) =>
      `The shadow is ${leadName} in a small session without the conversation history. It handles background events, and hands back to ${leadName} what it cannot or should not handle. It uses far fewer tokens.`,
    options: { off: 'Off', trial: 'Trial', on: 'On' } satisfies Record<Mode, string>,
    notes: {
      off: (leadName: string) => `${leadName} handles every background event in the conversation.`,
      trial: (leadName: string) =>
        `The shadow handles the same events as ${leadName}, but its actions do not take effect. It only records what it would do, so you can compare.`,
      on: (leadName: string) =>
        `Background events go to the shadow first, in the shares below. What it hands back goes to ${leadName} with what it found.`,
    } satisfies Record<Mode, (leadName: string) => string>,
    routingTitle: 'What goes to the shadow',
    shareLabels: { channel: 'External messages', ticket: 'Ticket events', other: 'Other system events' } satisfies Record<Source, string>,
    shareNotes: {
      channel: 'Messages from all external channels. One conversation always goes to the same side.',
      ticket: 'Tickets, executions and blockers. One ticket always goes to the same side.',
      other: 'Other system events, for example connection and runtime events.',
    } satisfies Record<Source, string>,
    percent: (value: number) => `${value}%`,
    otherValue: (value: number) => `Now ${value}%. Pick a value to change it.`,
    modelLabel: 'Model',
    modelSame: 'Same as the conversation',
    modelNote: (leadName: string) => `The shadow can use a smaller model than ${leadName}'s conversation.`,
    modelsFailed: (reason: string) => `Could not load the models: ${reason}`,
    gatherLabel: 'Wait before a batch',
    gatherValue: (seconds: number) => (seconds === 0 ? 'None' : `${seconds} s`),
    gatherNote: 'When the cache is warm, ordinary background events wait this long and go out as one batch.',
    alwaysMain: (leadName: string) =>
      `Reminders, your follow-ups, urgent events and things you must decide always go to ${leadName}'s conversation.`,
    saving: 'Saving…',
    failed: (reason: string) => `Not saved: ${reason}`,
    footnote: (leadName: string) => `Each change saves at once and applies from the next batch of events. You can also ask ${leadName} to change it.`,
  },
  zh: {
    loading: '正在读取 shadow 的设置…',
    loadFailed: (reason) => `没有读到 shadow 的设置：${reason}`,
    unsupported: '这台 Mac 上的 daemon 太旧，没有这一项。请更新 Bytezard Lead。',
    title: (leadName) => `${leadName} 的分身 shadow`,
    intro: (leadName) =>
      `shadow 是不带会话历史的 ${leadName}，在一个小会话里处理后台事件，处理不了或不该处理的交回给 ${leadName}。它用的 token 少得多。`,
    options: { off: '关', trial: '试运行', on: '开' },
    notes: {
      off: (leadName) => `每件后台事件都由 ${leadName} 在会话里处理。`,
      trial: (leadName) => `shadow 和 ${leadName} 处理同样的事件，但它的动作不执行，只记下它会怎么做，用来比对。`,
      on: (leadName) => `后台事件按下面的比例先交给 shadow。它交回的事带着查到的情况交给 ${leadName}。`,
    },
    routingTitle: '交给 shadow 的事',
    shareLabels: { channel: '外部消息', ticket: '工单事件', other: '其他系统事件' },
    shareNotes: {
      channel: '所有外部通道的消息。同一个对话固定走同一边。',
      ticket: '工单、执行和 blocker 的事件。同一张工单固定走同一边。',
      other: '其他系统事件，例如连接和执行器的事件。',
    },
    percent: (value) => `${value}%`,
    otherValue: (value) => `现在是 ${value}%。选一个值就改成它。`,
    modelLabel: '模型',
    modelSame: '和会话相同',
    modelNote: (leadName) => `shadow 可以用比 ${leadName} 的会话更小的模型。`,
    modelsFailed: (reason) => `没有读到模型列表：${reason}`,
    gatherLabel: '合批等待',
    gatherValue: (seconds) => (seconds === 0 ? '不等' : `${seconds} 秒`),
    gatherNote: '缓存热的时候，普通的后台事件先等这么久，合成一批再交出去。',
    alwaysMain: (leadName) => `提醒、你设的跟进、紧急的事和要你决定的事，永远交给 ${leadName} 的会话。`,
    saving: '正在保存…',
    failed: (reason) => `没有保存成功：${reason}`,
    footnote: (leadName) => `改了马上保存，下一批事件起生效。也可以在会话里让 ${leadName} 改。`,
  },
});
