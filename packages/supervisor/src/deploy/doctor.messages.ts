// plc doctor 里 Claude Code 那一行的文字。doctor 的其余检查项还是写死的中文，迁到这里以后语言才能整体跟着走。
import { defineMessages } from "@pi-lead-child/protocol";

export const doctorMessages = defineMessages({
  en: {
    claudeName: "Claude Code",
    claudeDisabled: "Disabled. The daemon does not run claude (no --version, --help or auth status).",
    claudeEnabled: "Not disabled. The daemon runs claude to check the install, the login and the model list.",
    claudeEnabledFix: "To keep the daemon from running claude, turn it off in Settings → Runtimes.",
    claudeModelsName: "Claude models over HTTP",
    claudeModelsNone: "No Claude model is configured for Lead, the smart-model fallback or Hindsight.",
    claudeModelsFound: (found: readonly string[]) =>
      `The daemon never sends requests to Claude models, so it refuses these and does not call them: ${found.join("; ")}.`,
    claudeModelsFix: "Pick a model that is not Claude in Settings → Models and Settings → Memory, then this line clears.",
  },
  zh: {
    claudeName: "Claude Code",
    claudeDisabled: "已停用。daemon 不会执行 claude（不跑 --version、--help、auth status）。",
    claudeEnabled: "没有停用。daemon 会执行 claude，检查安装、登录和模型列表。",
    claudeEnabledFix: "不想让 daemon 执行 claude，在 设置 → 执行器 里停用它。",
    claudeModelsName: "HTTP 调用的 Claude 模型",
    claudeModelsNone: "Lead、SmartModel 的 LLM 兜底和 Hindsight 都没有配 Claude 模型。",
    claudeModelsFound: (found) => `daemon 不向 Claude 模型发请求，下面这些被拒绝、不会被调用：${found.join("；")}。`,
    claudeModelsFix: "在 设置 → 模型 和 设置 → 记忆 里换成不是 Claude 的模型，这一行就会消失。",
  },
});
