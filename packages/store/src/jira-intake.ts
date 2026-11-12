// Jira 最小拉取的设置（protocol 的 jira-intake.ts，计划 Task 13）：plc.db 的 kv，一行 JSON。缺省关、项目白名单为空。
// 读的时候不信库里的值：项目 key 不合格的丢掉，间隔夹在范围里，坏了的整行按缺省（关）算。改它走 engine 的操作层 jira_intake.set。
import {
  DEFAULT_JIRA_INTAKE, DEFAULT_JIRA_SEARCH_TOOL, JIRA_INTAKE_MAX_MINUTES, JIRA_INTAKE_MAX_PROJECTS, JIRA_INTAKE_MIN_MINUTES, JIRA_PROJECT_KEY,
  JIRA_TOOL_NAME_PATTERN, type JiraIntakeSettings,
} from "@pi-lead-child/protocol";
import type { Db } from "./db.js";

export const JIRA_INTAKE_KEY = "intake.jira";

const TOOL_NAME = new RegExp(JIRA_TOOL_NAME_PATTERN);

/** 把一份不可信的设置整理成合格的：不合格的字段回到缺省，项目 key 去重、丢掉不合格的。 */
export function normalizeJiraIntake(value: unknown): JiraIntakeSettings {
  if (value === null || typeof value !== "object") return { ...DEFAULT_JIRA_INTAKE, projects: [] };
  const raw = value as Record<string, unknown>;
  const projects = Array.isArray(raw.projects)
    ? [...new Set(raw.projects.filter((key): key is string => typeof key === "string" && JIRA_PROJECT_KEY.test(key)))].slice(0, JIRA_INTAKE_MAX_PROJECTS)
    : [];
  const minutes = typeof raw.everyMinutes === "number" && Number.isInteger(raw.everyMinutes)
    ? Math.min(JIRA_INTAKE_MAX_MINUTES, Math.max(JIRA_INTAKE_MIN_MINUTES, raw.everyMinutes))
    : DEFAULT_JIRA_INTAKE.everyMinutes;
  const cloudId = typeof raw.cloudId === "string" && raw.cloudId.trim() !== "" && raw.cloudId.length <= 200 ? raw.cloudId.trim() : null;
  const tool = typeof raw.tool === "string" && TOOL_NAME.test(raw.tool) ? raw.tool : DEFAULT_JIRA_SEARCH_TOOL;
  return { enabled: raw.enabled === true, projects, everyMinutes: minutes, cloudId, tool };
}

/** 现在的设置。没存过、坏了时是缺省（关）。 */
export function getJiraIntake(db: Db): JiraIntakeSettings {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(JIRA_INTAKE_KEY) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_JIRA_INTAKE, projects: [] };
  try {
    return normalizeJiraIntake(JSON.parse(row.value));
  } catch {
    return { ...DEFAULT_JIRA_INTAKE, projects: [] };
  }
}

/** 写入设置（engine 的 jira_intake.set 调它）。 */
export function writeJiraIntake(db: Db, settings: JiraIntakeSettings): JiraIntakeSettings {
  const next = normalizeJiraIntake(settings);
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(JIRA_INTAKE_KEY, JSON.stringify(next));
  return next;
}
