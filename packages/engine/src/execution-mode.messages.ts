// 执行模式推迟了工单对话时，用户在工单对话里看到的话（apps/daemon 的 handleTicketMessage 把这一轮按它收口）。
// 给 Lead 的话在 execution-mode.ts 的 executionDeferredNote（只给模型读，不翻译）。
import { defineMessages, type ExecutionMode } from "@pi-lead-child/protocol";

export const executionModeMessages = defineMessages({
  en: {
    chatDeferred: (mode: ExecutionMode) => mode === "paused"
      ? "Execution is paused, so no agent was started. Your message is saved on the ticket."
      : "This ticket is worked by an external worker, so no agent was started here. Your message is saved on the ticket for the worker.",
  },
  zh: {
    chatDeferred: (mode) => mode === "paused"
      ? "执行已经暂停，没有启动 agent。你的消息已经记在工单上。"
      : "这张工单由外部工人处理，这里没有启动 agent。你的消息已经记在工单上，工人会看到。",
  },
});
