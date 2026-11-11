// Text for the Claude guard (packages/core/src/claude-guard.ts): why a model or provider is refused, and the notes the
// daemon logs when it skips one. The settings page shows the refusals, so they follow the user's language; log notes
// (smart-model.ts) stay English like the other log lines.
import { defineMessages } from "@pi-lead-child/protocol";

export const claudeGuardMessages = defineMessages({
  en: {
    modelRefused: (spec: string) =>
      `${spec} is a Claude model. This daemon never sends requests to Claude models; choose another model.`,
    providerRefused: (name: string) =>
      `${name} points at Claude (the Anthropic API or a claude provider). This daemon never sends requests to Claude, so it cannot be added.`,
  },
  zh: {
    modelRefused: (spec) => `${spec} 是 Claude 模型。这个 daemon 不会向 Claude 模型发请求，请选别的模型。`,
    providerRefused: (name) => `${name} 指向 Claude（Anthropic 接口或 claude 服务商）。这个 daemon 不会向 Claude 发请求，所以不能接入。`,
  },
});
