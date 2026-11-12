// Jira 最小拉取（.scratch/external-worker-hub/spec.md S1，计划 Task 13）：按设置里的间隔经现有的 Atlassian 连接查指派给用户、
// 近一天更新的单，在台账里各建一张工单。不经过任何模型：deps 里只有库、查单的函数、时钟和设置。
//   - 查单的函数（call）由 daemon 注入（连接 hub 的 callTool，角色 lead，带只读的收窄清单 JIRA_INTAKE_GRANT（protocol 的 jira-intake.ts），读结果文本）；测试里是替身。
//   - 工具名是常量（DEFAULT_JIRA_SEARCH_TOOL），不在设置里（ruling R23）。
//   - JQL 里只有过了 JIRA_PROJECT_KEY 校验的项目 key；设置、查询、读结果每一层都不信上一层。
//   - 一张单一笔事务：建单、记来源（kind=jira，external_key=单号，按 (kind, key) 去重，store 的 addTicketSource）、记一条活动。
//     哪一步抛错这一张单什么都不留；call 抛错时一张都不建，下一个间隔再来。
//   - external_origin=1：指派给用户的单不是别人发来的消息，但里面的文字是第三方写的，失败时宁可当外部（Task 7b 同一条规则）。
//   - 浏览链接只收 https（protocol 的 sourceLink）。拼不出来时没有链接，宁可没有。
import { DEFAULT_JIRA_SEARCH_TOOL, JIRA_PROJECT_KEY, sourceLink, type JiraIntakeSettings } from "@pi-lead-child/protocol";
import { addActivity, addTicketSource, createItem, findItemByExternalKey, getJiraIntake, getLocale, type Db } from "@pi-lead-child/store";
import { jiraPullMessages } from "./jira-pull.messages.js";

export const JIRA_PULLED_DECISION = "jira_pulled";
export const JIRA_TITLE_MAX = 200;
// 一次最多读几张。近一天更新、指派给用户的单远少于这个数；超出的下一个间隔再看（按更新时间，不分页）。
export const JIRA_PULL_MAX_RESULTS = 50;

const ISSUE_KEY = /^([A-Z][A-Z0-9_]{1,19})-[1-9]\d{0,9}$/;

export interface JiraPullDeps {
  db: Db;
  // 调 Atlassian 连接里的一个工具，返回结果（文本或者已经解析好的 JSON）。失败时抛错。
  call: (tool: string, args: unknown) => Promise<unknown>;
  now: Date;
  settings: JiraIntakeSettings;
  // 不带任何密钥和连接返回的原文：只写单号、数量、错误的名字。
  log?: (line: string) => void;
}

export interface JiraPullResult {
  created: number;
  skipped: number;
}

/** 指派给用户、近一天更新、在白名单项目里的单的 JQL。没有一个合格的项目 key 时是 null（不查）。 */
export function jiraSearchQuery(projects: readonly string[]): string | null {
  const keys = [...new Set(projects.filter((key) => JIRA_PROJECT_KEY.test(key)))];
  return keys.length === 0 ? null : `assignee = currentUser() AND updated >= -1d AND project in (${keys.join(", ")})`;
}

interface PulledIssue {
  key: string;
  summary: string | null;
  url: string | null;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

// 连接返回的是 JSON 文本或者已经解析好的对象：{ issues: [...] } 或者直接是数组。别的形状抛错（一张都不建）。
function issuesOf(raw: unknown): unknown[] {
  const value = typeof raw === "string" ? parseJson(raw) : raw;
  if (Array.isArray(value)) return value;
  const issues = asRecord(value)?.issues;
  if (Array.isArray(issues)) return issues;
  throw new Error("jira search result has no issue list");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("jira search result is not JSON");
  }
}

// 站点的 https 地址：cloudId 是主机名（或者 https 地址）时用它，UUID 那一种拼不出。
function siteOrigin(cloudId: string): string | null {
  const trimmed = cloudId.trim();
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && url.hostname.includes(".") && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

function browseUrl(issue: Record<string, unknown>, key: string, cloudId: string): string | null {
  const given = sourceLink(issue.url) ?? sourceLink(issue.browseUrl) ?? sourceLink(issue.webUrl);
  if (given) return given;
  // 经站点自己的 REST 地址（/rest/api/…）能认出站点；经 api.atlassian 这类网关的地址不行。
  const self = sourceLink(issue.self);
  const fromSelf = self !== null && /^\/rest\/api\//u.test(new URL(self).pathname) ? new URL(self).origin : null;
  const origin = siteOrigin(cloudId) ?? fromSelf;
  return origin ? sourceLink(`${origin}/browse/${key}`) : null;
}

function titleOf(summary: unknown, key: string): string {
  // eslint-disable-next-line no-control-regex
  const plain = typeof summary === "string" ? summary.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim() : "";
  return plain === "" ? key : plain.length > JIRA_TITLE_MAX ? `${plain.slice(0, JIRA_TITLE_MAX - 1).trimEnd()}…` : plain;
}

function readIssue(entry: unknown, allowed: ReadonlySet<string>, cloudId: string): PulledIssue | null {
  const issue = asRecord(entry);
  const key = typeof issue?.key === "string" ? issue.key : "";
  const project = ISSUE_KEY.exec(key)?.[1];
  if (!issue || !project || !allowed.has(project)) return null;
  return { key, summary: titleOf(asRecord(issue.fields)?.summary, key), url: browseUrl(issue, key, cloudId) };
}

// 日志里只写错误的名字和（连接给的）错误码，不写消息：消息里可能带连接返回的原文。
function errorLabel(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return `${error instanceof Error ? error.name : "error"}${typeof code === "string" && /^[a-z_]{1,40}$/u.test(code) ? ` (${code})` : ""}`;
}

/**
 * 拉一次。没开、白名单里没有合格的项目、没填站点时不调用连接，返回 0、0。
 * 返回建了几张、跳过几张（已经有的单号、白名单外或者格式不对的、写不进去的）。call 抛错、结果读不了时抛错，一张都不建。
 */
export async function pullJira(deps: JiraPullDeps): Promise<JiraPullResult> {
  const { db, call, now, settings } = deps;
  const jql = settings.enabled && settings.cloudId ? jiraSearchQuery(settings.projects) : null;
  if (jql === null || !settings.cloudId) return { created: 0, skipped: 0 };
  const cloudId = settings.cloudId;
  const allowed = new Set(settings.projects.filter((key) => JIRA_PROJECT_KEY.test(key)));

  let entries: unknown[];
  try {
    entries = issuesOf(await call(DEFAULT_JIRA_SEARCH_TOOL, {
      cloudId, jql, fields: ["summary"], maxResults: JIRA_PULL_MAX_RESULTS,
    }));
  } catch (error) {
    deps.log?.(`jira pull failed: ${errorLabel(error)}`);
    throw error;
  }

  const brief = jiraPullMessages(getLocale(db)).brief;
  let created = 0;
  let skipped = 0;
  for (const entry of entries) {
    const issue = readIssue(entry, allowed, cloudId);
    if (!issue) {
      skipped += 1;
      continue;
    }
    try {
      const made = db.transaction((): boolean => {
        if (findItemByExternalKey(db, "jira", issue.key) !== null) return false;
        const itemId = createItem(db, { title: issue.summary ?? issue.key, brief: brief(issue.key), createdBy: "system", externalOrigin: true });
        const owner = addTicketSource(db, { itemId, kind: "jira", url: issue.url, externalKey: issue.key, now });
        if (owner !== itemId) throw new Error("jira source is owned by another ticket");
        addActivity(db, {
          itemId, actor: "system", kind: "decision", payload: { decision: JIRA_PULLED_DECISION, externalKey: issue.key, sourceUrl: issue.url },
        });
        return true;
      }).immediate();
      if (made) created += 1;
      else skipped += 1;
    } catch (error) {
      // 这一张写不进去：什么都没留（事务回滚），下一个间隔再试；别的照建。
      deps.log?.(`jira pull could not record ${issue.key}: ${errorLabel(error)}`);
      skipped += 1;
    }
  }
  return { created, skipped };
}

export interface JiraPuller {
  /** 每一拍（daemon 的轮询）调一次：没开、还没到间隔、上一次还没结束时什么也不做。返回这一拍有没有拉。 */
  tick(now?: Date): Promise<boolean>;
}

/**
 * daemon 里的定时拉取。设置每一拍现读（kv 一行）：没开时这一拍什么都不做，用户打开以后不用重启 daemon，下一拍就按间隔开始拉。
 * 间隔从上一次尝试起算，失败也算一次：错误只记名字，下一个间隔再来（一张都没建，不会留半张）。
 */
export function createJiraPuller(deps: { db: Db; call: JiraPullDeps["call"]; log?: (line: string) => void; now?: () => Date }): JiraPuller {
  let lastAttempt: number | null = null;
  let running = false;
  return {
    // 从不抛错：daemon 用 void 调它，抛出来就是没人接的 rejection（会让 Node 退出）。读设置出错（库的错）也在这里接住，只记错误的名字。
    async tick(at = deps.now?.() ?? new Date()): Promise<boolean> {
      if (running) return false;
      running = true;
      let pulling = false;
      try {
        const settings = getJiraIntake(deps.db);
        if (!settings.enabled) return false;
        if (lastAttempt !== null && at.getTime() - lastAttempt < settings.everyMinutes * 60_000) return false;
        lastAttempt = at.getTime();
        pulling = true;
        const result = await pullJira({ db: deps.db, call: deps.call, now: at, settings, ...(deps.log ? { log: deps.log } : {}) });
        if (result.created > 0) deps.log?.(`jira pull: ${result.created} created, ${result.skipped} skipped`);
        return true;
      } catch (error) {
        // pullJira 失败时它已经记了一行（只有错误的名字）；这里只记读设置失败。拉失败也算一次尝试，下一个间隔再来。
        if (!pulling) deps.log?.(`jira pull could not read its settings: ${errorLabel(error)}`);
        return pulling;
      } finally {
        running = false;
      }
    },
  };
}
