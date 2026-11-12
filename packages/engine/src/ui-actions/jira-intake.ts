// Jira 最小拉取的设置（protocol 的 jira-intake.ts，计划 Task 13）的操作：set。页面（POST /v1/actions/jira_intake/user/set）和 Lead
// （perform_action）调同一个定义。
//   - set：lead_allowed，改规则（设置页的选项，AGENTS.md「UI Actions」）。外部消息叫醒的一轮、读过外部内容的一轮里被拒，
//     拒绝里带确认卡。项目白名单只来自用户本地的设置，这条路是唯一的写入口。
//   - 给哪些字段改哪些字段，别的不动；什么都没变时什么也不写。
// 真正拉的是 daemon（apps/daemon 的 server.ts 的轮询里的 jira-pull 一拍，设置每拍现读，没开时什么也不做），拉的逻辑在 intake/jira-pull.ts。
import { type JiraIntakeSettings, type SetJiraIntakeRequest } from "@pi-lead-child/protocol";
import { getJiraIntake, writeJiraIntake } from "@pi-lead-child/store";
import { AVAILABLE } from "../ticket-actions/types.js";
import type { UiActionDefinition, UiActionTargetKind } from "./types.js";

export const JIRA_INTAKE_WHERE = "在你自己的对话里让 Lead 改（这项设置还没有设置页）";

export interface JiraIntakeChange {
  changed: boolean;
  settings: JiraIntakeSettings;
}

export const JIRA_INTAKE_TARGET: UiActionTargetKind<JiraIntakeSettings> = {
  type: "jira_intake",
  label: "Jira 拉取",
  idHint: "user",
  load: (env, id) => (id === "user" ? getJiraIntake(env.db) : null),
  name: () => "Jira 拉取",
  describe: (settings) => ({
    enabled: settings.enabled, projects: settings.projects, everyMinutes: settings.everyMinutes, site: settings.cloudId !== null,
    words: settings.enabled
      ? `开着：每 ${settings.everyMinutes} 分钟经 Atlassian 连接拉指派给用户的单（项目：${settings.projects.join("、") || "还没填"}）。`
      : "关着。",
  }),
};

export const JIRA_INTAKE_ACTIONS = {
  set: {
    target: "jira_intake", id: "set", label: "改 Jira 拉取的设置", scope: "tickets:create",
    permission: "lead_allowed", changesRules: true, external: false, irreversible: false,
    where: JIRA_INTAKE_WHERE,
    hint: "enabled 开关；projects 是 Jira 项目 key 的白名单（大写字母开头，例如 PROJ，整个换掉）；everyMinutes 拉的间隔（5 到 1440 分钟）；"
      + "cloudId 是 Atlassian 站点（UUID 或者站点地址）。用户说「把指派给我的 Jira 单自动放进工单」「只看 PROJ 项目」这类话时用，只写他说了的字段。"
      + "拉进来的工单只进台账，不会自己开工。",
    defaultReason: "改了 Jira 拉取的设置",
    available: () => AVAILABLE,
    run: (run): JiraIntakeChange => {
      const input = run.input as SetJiraIntakeRequest;
      const before = run.target;
      const merged: JiraIntakeSettings = {
        enabled: input.enabled ?? before.enabled,
        projects: input.projects ? [...new Set(input.projects)] : before.projects,
        everyMinutes: input.everyMinutes ?? before.everyMinutes,
        cloudId: input.cloudId === undefined ? before.cloudId : input.cloudId,
      };
      if (JSON.stringify(merged) === JSON.stringify(before)) return { changed: false, settings: before };
      return { changed: true, settings: writeJiraIntake(run.db, merged) };
    },
    forLead: (_run, result) => {
      const change = result as JiraIntakeChange;
      return change.changed
        ? { result: "updated", enabled: change.settings.enabled, projects: change.settings.projects, site: change.settings.cloudId !== null, next: "已经保存。用一句话告诉用户改了什么；daemon 下一拍起按新的设置拉。" }
        : { result: "unchanged", enabled: change.settings.enabled, projects: change.settings.projects };
    },
    detail: (run, result) => {
      const change = result as JiraIntakeChange;
      return {
        before: { enabled: run.target.enabled, projects: run.target.projects, everyMinutes: run.target.everyMinutes, cloudId: run.target.cloudId },
        after: {
          enabled: change.settings.enabled, projects: change.settings.projects, everyMinutes: change.settings.everyMinutes,
          cloudId: change.settings.cloudId,
        },
      };
    },
  },
} satisfies Record<string, UiActionDefinition<JiraIntakeSettings, any>>;
