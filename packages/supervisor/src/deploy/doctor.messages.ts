// plc doctor 里 Claude Code 那一行的文字。doctor 的其余检查项还是写死的中文，迁到这里以后语言才能整体跟着走。
import { defineMessages } from "@pi-lead-child/protocol";

export const doctorMessages = defineMessages({
  en: {
    claudeName: "Claude Code",
    claudeDisabled: "Disabled. The daemon does not run claude (no --version, --help or auth status).",
    claudeEnabled: "Not disabled. The daemon runs claude to check the install, the login and the model list.",
    claudeEnabledFix: "To keep the daemon from running claude, turn it off in Settings → Runtimes.",
  },
  zh: {
    claudeName: "Claude Code",
    claudeDisabled: "已停用。daemon 不会执行 claude（不跑 --version、--help、auth status）。",
    claudeEnabled: "没有停用。daemon 会执行 claude，检查安装、登录和模型列表。",
    claudeEnabledFix: "不想让 daemon 执行 claude，在 设置 → 执行器 里停用它。",
  },
});
