// Lead 动态里「Lead 装了什么」的那句话（.scratch/lead-self-install/spec.md D7）。按写入时用户选的语言写。
// who：lead 是 Lead（用它的名字），user 是你。
import { defineMessages, type LeadInstallKind } from "@pi-lead-child/protocol";

type Who = { actor: "lead" | "user"; leadName: string };

const KIND_EN: Record<LeadInstallKind, string> = { remote_mcp: "remote MCP", local_mcp: "local MCP", skill: "skill" };
// 「skill」和前面的汉字隔一个空格（「装了 skill「…」」）。
const KIND_ZH: Record<LeadInstallKind, string> = { remote_mcp: "远程 MCP", local_mcp: "本地 MCP", skill: " skill" };

const whoEn = (who: Who) => (who.actor === "lead" ? who.leadName : "You");
const whoZh = (who: Who) => (who.actor === "lead" ? `${who.leadName} ` : "你");

export const installMessages = defineMessages({
  en: {
    installed: (who: Who, kind: LeadInstallKind, name: string, source: string) =>
      `${whoEn(who)} added the ${KIND_EN[kind]} "${name}" (${source}).`,
    pendingAuthorization: (name: string) => ` It waits for you to authorize ${name}.`,
    tools: (count: number) => (count === 1 ? " It has 1 tool." : ` It has ${count} tools.`),
    scripts: (files: readonly string[]) => ` Scripts (they run only in the sandbox): ${files.join(", ")}.`,
    removed: (who: Who, kind: LeadInstallKind, name: string) => `${whoEn(who)} removed the ${KIND_EN[kind]} "${name}".`,
    basis: (reason: string) => ` Reason: ${reason}.`,
    // 本地 MCP 的确认卡（改规则的确认卡同一套）：要做什么、为什么要用户确认。
    confirmLabel: "Install a local MCP",
    confirmWhy: (command: string) =>
      `A local MCP starts a process on your computer, outside the sandbox (${command}). It passed the review. Confirm it before it is installed`,
  },
  zh: {
    installed: (who, kind, name, source) => `${whoZh(who)}装了${KIND_ZH[kind]}「${name}」（${source}）。`,
    pendingAuthorization: (name) => `等你授权 ${name}。`,
    tools: (count) => `有 ${count} 个工具。`,
    scripts: (files) => `带的脚本（只在沙箱里跑）：${files.join("、")}。`,
    removed: (who, kind, name) => `${whoZh(who)}撤销了${KIND_ZH[kind]}「${name}」。`,
    basis: (reason) => `依据：${reason}。`,
    confirmLabel: "装本地 MCP",
    confirmWhy: (command) => `本地 MCP 会在你的电脑上、沙箱外起一个进程（${command}）。审查通过了，装之前要你确认`,
  },
});
