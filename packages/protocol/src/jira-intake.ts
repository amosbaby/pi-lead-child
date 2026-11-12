// Jira 最小拉取的设置（.scratch/external-worker-hub/spec.md S1，计划 Task 13）：daemon 按间隔经现有的 Atlassian 连接查指派给用户的单，
// 在台账里各建一张工单，不经过任何模型。
// - 设置只来自用户本地（plc.db 的 kv，store 的 jira-intake.ts）：缺省关，项目白名单为空；代码里没有项目、站点的缺省值。
// - 改它是操作层的 jira_intake.set（engine 的 ui-actions/jira-intake.ts）：页面走 POST /v1/actions/jira_intake/user/set，Lead 走
//   perform_action。改规则：外部消息叫醒的一轮、读过外部内容的一轮里被拒。
// - 项目 key 先过 JIRA_PROJECT_KEY 才会拼进 JQL；不合格的 key 在设置里就被拒，读设置时也丢掉。
// 这个文件不 import index.ts（index.ts 从这里 re-export，反过来会循环）。
import { Type, type Static, type TProperties } from "typebox";
import type { RunGrant } from "./run-grants.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

// Jira 项目 key：大写字母开头，后面大写字母、数字、下划线，一共 2 到 20 位。
export const JIRA_PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,19}$/;
export const JIRA_PROJECT_KEY_PATTERN = "^[A-Z][A-Z0-9_]{1,19}$";
export const JIRA_INTAKE_MAX_PROJECTS = 50;
export const JIRA_INTAKE_MIN_MINUTES = 5;
export const JIRA_INTAKE_MAX_MINUTES = 1440;
export const DEFAULT_JIRA_INTAKE_MINUTES = 15;
// Atlassian 连接里按 JQL 查单的工具名：常量，不进设置（ruling R23：设置里的值不能让 daemon 去调任何 Atlassian 工具，包括写工具）。
// 服务方改了名字就改这一行。
export const DEFAULT_JIRA_SEARCH_TOOL = "searchJiraIssuesUsingJql";

export const JiraIntakeSettingsSchema = StrictObject({
  enabled: Type.Boolean(),
  projects: Type.Array(Type.String({ pattern: JIRA_PROJECT_KEY_PATTERN }), { maxItems: JIRA_INTAKE_MAX_PROJECTS }),
  everyMinutes: Type.Integer({ minimum: JIRA_INTAKE_MIN_MINUTES, maximum: JIRA_INTAKE_MAX_MINUTES }),
  // 查单工具要的站点（Atlassian 的 cloudId：UUID 或者站点地址）。用户自己填，没有缺省；空时不拉。
  cloudId: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
});
export type JiraIntakeSettings = Static<typeof JiraIntakeSettingsSchema>;

export const DEFAULT_JIRA_INTAKE: JiraIntakeSettings = {
  enabled: false, projects: [], everyMinutes: DEFAULT_JIRA_INTAKE_MINUTES, cloudId: null,
};

// jira_intake.set 的输入：给哪些字段就改哪些，别的不动。projects 整个换掉。
export const SetJiraIntakeRequestSchema = StrictObject({
  enabled: Type.Optional(Type.Boolean()),
  projects: Type.Optional(Type.Array(Type.String({ pattern: JIRA_PROJECT_KEY_PATTERN }), { maxItems: JIRA_INTAKE_MAX_PROJECTS })),
  everyMinutes: Type.Optional(Type.Integer({ minimum: JIRA_INTAKE_MIN_MINUTES, maximum: JIRA_INTAKE_MAX_MINUTES })),
  cloudId: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()])),
});
export type SetJiraIntakeRequest = Static<typeof SetJiraIntakeRequestSchema>;

// Atlassian 连接的 key（连接中心的 connectionKey）。
export const JIRA_CONNECTION_KEY = "atlassian";

/**
 * daemon 调连接时带的收窄清单（ruling R23）：只放行 Atlassian 连接上的只读工具。连接中心按它检查（callTool 的 options.grant），
 * 所以就算查单的工具名以后被改成写工具（或者服务器把它标成了写工具），这一次调用也在连接中心被拒，不会每个间隔写一次外部账号。
 */
export const JIRA_INTAKE_GRANT: RunGrant = {
  version: 1, intent: "knowledge", localRepos: [],
  rules: [{
    id: "jira-intake:read", connection: JIRA_CONNECTION_KEY, tools: "read",
    label: "Read Jira issues for the ledger (read-only tools of the Atlassian connection)",
  }],
};
