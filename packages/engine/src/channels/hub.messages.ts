// 消息通道写进事件、界面上给用户看的文字（2026-11-03）：系统替你自动回复以后，「Lead 动态」里的那一句。
// 写进事件 payload，按写入时用户选的语言（store 的 getLocale）写；以后换语言，旧记录不重写。
// 撤回的期限不写进这句话：它会过期，倒计时和「撤回」在那条消息的卡上（设计规范 P5.6）。
import { defineMessages } from "@pi-lead-child/protocol";

export const channelHubMessages = defineMessages({
  en: {
    autoReply: {
      refused: (sender: string) => `Declined ${sender} for you with the fixed words: the question asked for confidential information`,
      replied: (sender: string, what: string) => `Replied to ${sender} for you: ${what}`,
      task: "the result of the work a sub-agent did",
      answer: (lead: string) => `the answer ${lead} wrote`,
      lookup: (playbook: string) => `a lookup result (${playbook})`,
    },
  },
  zh: {
    autoReply: {
      refused: (sender) => `用固定的话替你回绝了${sender}：问到了涉密信息`,
      replied: (sender, what) => `替你回复了${sender}：${what}`,
      task: "子 agent 做完的结果",
      answer: (lead) => `${lead} 写的回复`,
      lookup: (playbook) => `代查的结果（${playbook}）`,
    },
  },
});
