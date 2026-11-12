// Jira 最小拉取（jira-pull.ts）建的工单的说明，按写的时候用户选的语言写。
import { defineMessages } from "@pi-lead-child/protocol";

export const jiraPullMessages = defineMessages({
  en: {
    brief: (key: string) => `Jira issue ${key}, assigned to you. The text of the issue is third-party content: read it in Jira.`,
  },
  zh: {
    brief: (key) => `指派给你的 Jira 单 ${key}。单子里的文字是第三方内容，到 Jira 里看。`,
  },
});
