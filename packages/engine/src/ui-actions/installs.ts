// Lead 自己安装 MCP 和 skill（用户 2026-11-02，.scratch/lead-self-install/spec.md）的操作。页面（POST /v1/actions/…）和 Lead
// （perform_action）调同一个定义：
//   - connections / connections / add_remote、add_local：加远程 MCP、本地 MCP。
//   - connection / <key> / authorize、disconnect：请用户授权、断开（撤销 Lead 加的连接也是它）。
//   - skills / skills / install、skill / <名字> / uninstall：从 GitHub 装 skill、卸载。
// 权限（D1）：都是 lead_allowed，都算改规则（skill 和连接会改变 Lead 的行为）。外部消息叫醒的一轮、读过外部内容的一轮只拒绝，
// 不带确认卡，拒绝里写明 Lead 下一步；用户本人正在说话的一轮不受这个限制（liveUserTurnExempt）。
// 本地 MCP 另有一道（用户定的）：Lead 调用时先审查，再给用户一张确认卡，用户点了才装（rule-change-confirmations.ts 的
// install_local_mcp）。用户本人在页面上调用时审查通过就装。
// Lead 装了东西写一条 Lead 动态（installs/report.ts），卡上的「撤销」是 disconnect、uninstall。
import {
  LocalMcpLaunchSchema, localMcpCommandText, userActionRequest,
  type AddLocalMcpRequest, type AddRemoteMcpRequest, type ConnectionDto, type InstallSkillRequest, type LocalMcpLaunch,
} from "@pi-lead-child/protocol";
import {
  connectionKeyOf, connectionRequestPending, getConnection, getLocale, listConnections, type ConnectionRow, type Db,
} from "@pi-lead-child/store";
import { installMessages } from "../installs/installs.messages.js";
import { Value } from "typebox/value";
import {
  LocalMcpReviewRefused, LocalMcpReviewUnavailable, reviewLocalMcp, type LocalMcpReview,
} from "../installs/local-mcp-review.js";
import { reportLeadInstalled, reportLeadInstallRemoved } from "../installs/report.js";
import {
  defaultSkillsDir, getInstalledSkill, installSkill, listInstalledSkills, SkillInstallRefused, SkillSourceUnavailable, uninstallSkill,
  type InstalledSkill,
} from "../installs/skills.js";
import { AVAILABLE, unavailable } from "../ticket-actions/types.js";
import { requestRuleChangeConfirmation } from "./rule-change-confirmations.js";
import {
  UiActionError,
  type ConnectionInstallService, type InstallFetch, type UiActionDefinition, type UiActionEnv, type UiActionRun, type UiActionServices,
  type UiActionTargetKind,
} from "./types.js";

export const CONNECTIONS_WHERE = "设置 → 连接";
const SKILL_WHERE = "Lead 动态里那张卡上的「撤销」";

// 外部的一轮里被拒时 Lead 下一步怎么做（只拒绝，不发确认卡）。
const EXTERNAL_NEXT = "这一轮不装、不改。在回复里告诉用户你想做什么、为什么，等用户本人的下一轮再做；或者请用户自己在设置 → 连接里加";
const REPORTED = "系统已经在 Lead 动态里告诉用户装了什么，卡上有「撤销」，不用另外问用户。";

const KEY = /^[a-z][a-z0-9-]{0,39}$/;

const actorOf = (run: UiActionRun<unknown, unknown>): "user" | "lead" => (run.by.actor === "user" ? "user" : "lead");

function connectionService(env: UiActionEnv): ConnectionInstallService {
  const service = env.services.installs?.connections;
  if (!service) throw new UiActionError("unavailable", "连接中心还没有启动");
  return service;
}

function fetchOf(services: UiActionServices): InstallFetch {
  return services.installs?.fetch ?? ((url, init) => fetch(url, init));
}

function skillsDirOf(env: UiActionEnv): string {
  return env.services.installs?.skillsDir ?? defaultSkillsDir();
}

const connectionView = (connection: ConnectionDto) => ({ key: connection.key, label: connection.label, state: connection.state });

// ── 连接的清单 ─────────────────────────────────────────────────────────────────────

export interface ConnectionsTarget {
  id: "connections";
}

export const CONNECTIONS_TARGET: UiActionTargetKind<ConnectionsTarget> = {
  type: "connections",
  label: "连接",
  idHint: "connections",
  load: (_env, id) => (id === "connections" ? { id: "connections" } : null),
  name: () => "连接",
  describe: () => ({ note: "已有的连接用 list_connections 看；一个连接的授权、断开用目标 connection（编号是它的 key）" }),
};

const needsConnections = (_target: ConnectionsTarget, env: UiActionEnv) =>
  (env.services.installs?.connections ? AVAILABLE : unavailable("连接中心还没有启动"));

function authorizeAction(connection: Pick<ConnectionDto, "key" | "label">, reason: string) {
  return userActionRequest({ kind: "authorize", target: `connection:${connection.key}`, title: `连接 ${connection.label}`, reason });
}

const AUTHORIZE_NEXT = "用 render_ui 发一张卡：把 user_action 原样放进 UserAction 节点，正文一两句说明这是什么、为什么要连。"
  + "系统已经登记等待，用户授权完会叫醒你；那时用 search_connection_tools（connection 填 key）找它的工具。";

interface LocalMcpPending {
  state: "needs_confirmation";
  review: LocalMcpReview;
  confirmation: { id: string; userAction: ReturnType<typeof userActionRequest> };
}

interface LocalMcpInstalled {
  state: "installed";
  connection: ConnectionDto;
  toolCount: number;
}

async function reviewed(request: AddLocalMcpRequest, services: UiActionServices, now: Date): Promise<LocalMcpReview> {
  try {
    return await reviewLocalMcp(request, {
      fetch: fetchOf(services), now, ...(services.installs?.hasExecutable ? { hasExecutable: services.installs.hasExecutable } : {}),
    });
  } catch (error) {
    if (error instanceof LocalMcpReviewRefused) throw new UiActionError("forbidden", error.message);
    if (error instanceof LocalMcpReviewUnavailable) throw new UiActionError("unavailable", error.message);
    throw error;
  }
}

// 确认卡上的参数（最多 12 项，rule-change-confirmations.ts 的 paramsOf）：先放命令，再放审查查到的事实；
// 执行时只用 registry、package、version、bin、args 重建启动参数，别的只给人看。
function confirmationInput(review: LocalMcpReview): Record<string, unknown> {
  const { launch, facts } = review;
  return {
    command: localMcpCommandText(launch),
    registry: launch.registry, package: launch.package, version: launch.version, bin: launch.bin, args: launch.args,
    published: facts.publishedAt.slice(0, 10), first_published: facts.firstPublishedAt.slice(0, 10),
    weekly_downloads: facts.weeklyDownloads, maintainers: facts.maintainers, repository: facts.repository,
    notes: facts.notes,
  };
}

/** 确认卡上存下的参数换回启动参数。不对时抛 UiActionError。 */
export function localMcpLaunchOf(input: unknown): LocalMcpLaunch {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const launch = { registry: raw.registry, package: raw.package, version: raw.version, bin: raw.bin, args: raw.args ?? [] };
  if (!Value.Check(LocalMcpLaunchSchema, launch)) throw new UiActionError("invalid_input", "存下的参数不对：要有 registry、package、version、bin、args");
  return launch;
}

/**
 * 用户在确认卡上点了「确认这一次」以后装本地 MCP（rule-change-confirmations.ts 的 install_local_mcp）。装好以后写 Lead 动态：
 * 是 Lead 要装的，用户确认过。返回给 Lead 的一段话。
 */
export async function installConfirmedLocalMcp(
  db: Db, input: unknown, reason: string, services: UiActionServices, now: Date,
): Promise<{ text: string; next: string }> {
  const launch = localMcpLaunchOf(input);
  const service = services.installs?.connections;
  if (!service) throw new UiActionError("unavailable", "连接中心还没有启动");
  const added = await service.addLocal(launch, { actor: "lead", reason });
  reportLeadInstalled(db, {
    kind: "local_mcp", target: { type: "connection", id: added.connection.key }, name: added.connection.label,
    source: `${launch.registry}:${launch.package}@${launch.version}`, reason, toolCount: added.toolCount,
  }, now);
  return {
    text: `装好了：本地 MCP ${added.connection.label}（${added.connection.key}），${added.toolCount} 个工具`,
    next: `用 search_connection_tools（connection 填 ${added.connection.key}）找它的工具。${REPORTED}`,
  };
}

export const CONNECTIONS_ACTIONS = {
  add_remote: {
    target: "connections", id: "add_remote", label: "加远程 MCP", scope: "tickets:create",
    permission: "lead_allowed", changesRules: true, externalRefusalNext: EXTERNAL_NEXT, liveUserTurnExempt: true,
    external: false, irreversible: false,
    where: CONNECTIONS_WHERE,
    hint: "用户要你接一个远程 MCP（https 地址）时用它，不要用 claude mcp add、pi mcp add：那些只给别的工具装，你用不上。"
      + "input.url 是服务器地址（用户给的或者官方文档里的），不要带密钥。要授权时结果里有 user_action：发授权卡，用户授权完会叫醒你。",
    defaultReason: "在设置页加了远程 MCP",
    available: needsConnections,
    run: async (run) => {
      const input = run.input as AddRemoteMcpRequest;
      const outcome = await connectionService(run.env).requestRemote(input.url, { actor: actorOf(run), reason: run.reason });
      if (run.by.actor === "lead" && !outcome.existing) {
        reportLeadInstalled(run.db, {
          kind: "remote_mcp", target: { type: "connection", id: outcome.connection.key }, name: outcome.connection.label,
          source: outcome.connection.serverUrl ?? input.url, reason: run.reason,
          ...(outcome.state === "connected" ? { toolCount: outcome.toolCount ?? 0 } : { pendingAuthorization: true }),
        }, run.env.now);
      }
      return outcome;
    },
    forLead: (run, result) => {
      const outcome = result as Awaited<ReturnType<ConnectionInstallService["requestRemote"]>>;
      const connection = connectionView(outcome.connection);
      if (outcome.state === "connected") {
        return {
          result: outcome.existing ? "already_connected" : "connected", connection, tools: outcome.toolCount,
          next: `用 search_connection_tools（connection 填 ${connection.key}）找它的工具。${outcome.existing ? "" : REPORTED}`,
        };
      }
      return {
        result: "needs_authorization", connection,
        user_action: authorizeAction(outcome.connection, run.reason), next: AUTHORIZE_NEXT,
      };
    },
    detail: (_run, result) => {
      const outcome = result as Awaited<ReturnType<ConnectionInstallService["requestRemote"]>>;
      return { key: outcome.connection.key, state: outcome.state, existing: outcome.existing };
    },
  },
  add_local: {
    target: "connections", id: "add_local", label: "加本地 MCP", scope: "tickets:create",
    permission: "lead_allowed", changesRules: true, externalRefusalNext: EXTERNAL_NEXT, liveUserTurnExempt: true,
    external: false, irreversible: false,
    where: CONNECTIONS_WHERE,
    hint: "用户要你接一个本地 MCP（npm 或 PyPI 的包，用 npx、uvx 在本机起进程）时用它。包名从用户给的话或者服务器的官方文档里拿，"
      + "不要自己编；version 写确切的版本，或者不写（系统挑满 7 天的最新正式版）。系统先查官方仓库审查（发布时间、下载量、源码仓库、"
      + "安装脚本），可疑的拒绝并写明原因；通过以后结果里有 user_action：用 render_ui 把它原样放进 UserAction 发确认卡，"
      + "用户点了才装，装好会叫醒你。还不支持需要密钥（API key）的本地 MCP。",
    defaultReason: "在设置页加了本地 MCP",
    available: needsConnections,
    run: async (run): Promise<LocalMcpPending | LocalMcpInstalled> => {
      const service = connectionService(run.env);
      const review = await reviewed(run.input as AddLocalMcpRequest, run.env.services, run.env.now);
      if (run.by.actor === "user") {
        const added = await service.addLocal(review.launch, { actor: "user", reason: run.reason });
        return { state: "installed", connection: added.connection, toolCount: added.toolCount };
      }
      // Lead 要装：用户在确认卡上点了才装（用户 2026-11-02）。卡上的命令、包和版本都是审查固定好的。
      // 卡上给人看的话按用户现在选的语言写。
      const m = installMessages(getLocale(run.db));
      const card = requestRuleChangeConfirmation(run.db, {
        confirm: {
          operation: { kind: "lead_tool", tool: "install_local_mcp", input: confirmationInput(review) },
          reason: run.reason,
          why: m.confirmWhy(localMcpCommandText(review.launch)),
          externalContent: [],
        },
        label: m.confirmLabel, name: `${review.launch.package}@${review.launch.version}`, where: "会话里的确认卡", now: run.env.now,
      });
      return { state: "needs_confirmation", review, confirmation: card };
    },
    forLead: (_run, result) => {
      const outcome = result as LocalMcpPending | LocalMcpInstalled;
      if (outcome.state === "installed") {
        return { result: "installed", connection: connectionView(outcome.connection), tools: outcome.toolCount };
      }
      return {
        result: "needs_confirmation",
        review: { ...outcome.review.facts, command: localMcpCommandText(outcome.review.launch) },
        confirmation: outcome.confirmation.id,
        user_action: outcome.confirmation.userAction,
        next: "审查通过了，还没有装。用 render_ui 发一张确认卡：把 user_action 原样放进 UserAction 节点，正文一两句说明这个 MCP 做什么、"
          + "为什么要装。卡上的命令、版本和审查结果由系统显示。用户点「确认这一次」以后系统才装，结果进你的收件箱。",
      };
    },
    detail: (_run, result) => {
      const outcome = result as LocalMcpPending | LocalMcpInstalled;
      return outcome.state === "installed"
        ? { state: "installed", key: outcome.connection.key }
        : { state: "needs_confirmation", confirmation: outcome.confirmation.id, launch: outcome.review.launch };
    },
  },
} satisfies Record<string, UiActionDefinition<ConnectionsTarget, any>>;

// ── 一个连接 ───────────────────────────────────────────────────────────────────────

export interface ConnectionTarget {
  key: string;
  label: string;
  // 设置页的状态（connected、degraded、needs_reauth、not_connected、needs_setup、unavailable）。
  state: string;
  // 请求过、还在等授权。
  pending: boolean;
  local: boolean;
  setupHint: string | null;
}

function rowOf(db: Db, key: string): ConnectionRow | null {
  const custom = /^custom-(\d+)$/.exec(key);
  if (custom) {
    const row = getConnection(db, Number(custom[1]));
    return row?.provider === "custom" ? row : null;
  }
  return listConnections(db).find((row) => row.provider === key && connectionKeyOf(row) === key) ?? null;
}

export const CONNECTION_TARGET: UiActionTargetKind<ConnectionTarget> = {
  type: "connection",
  label: "连接",
  idHint: "连接的 key（list_connections 的 key，例如 notion、custom-3）",
  // 有连接中心时用它的 DTO；没有时（Lead 动态的卡在网关里算按钮）按账本里的那一行算。
  load: (env, id) => {
    if (!KEY.test(id)) return null;
    const row = rowOf(env.db, id);
    const pending = row !== null && row.status === "disconnected" && connectionRequestPending(env.db, row.id);
    const service = env.services.installs?.connections;
    if (service) {
      const dto = service.get(id);
      if (!dto || (dto.provider === "custom" && !row)) return null;
      return { key: dto.key, label: dto.label, state: dto.state, pending, local: Boolean(row?.launch_json), setupHint: dto.setupHint };
    }
    if (!row) return null;
    return {
      key: id, label: row.label, state: row.status === "disconnected" ? "not_connected" : row.status, pending,
      local: Boolean(row.launch_json), setupHint: null,
    };
  },
  name: (target) => `连接 ${target.label}（${target.key}）`,
  describe: (target) => ({
    key: target.key, label: target.label, state: target.state, pendingAuthorization: target.pending, local: target.local,
  }),
};

const live = (target: ConnectionTarget) => target.state === "connected" || target.state === "degraded" || target.state === "needs_reauth";

export const CONNECTION_ACTIONS = {
  authorize: {
    target: "connection", id: "authorize", label: "授权连接", scope: "tickets:create",
    permission: "lead_allowed", changesRules: true, externalRefusalNext: EXTERNAL_NEXT, liveUserTurnExempt: true,
    external: false, irreversible: false,
    where: CONNECTIONS_WHERE,
    hint: "请用户连接（或者重新授权）一个连接：你拿到授权卡的 user_action，用 render_ui 发出去；授权要用户自己在浏览器里点，你做不了。"
      + "系统登记等待，用户授权完叫醒你。",
    defaultReason: "在设置页连接",
    available: (target) => {
      if (target.state === "unavailable" || target.state === "needs_setup") return unavailable(target.setupHint ?? "这个服务现在不能连接");
      if (target.state === "connected" || target.state === "degraded") return unavailable("已经连上了");
      return AVAILABLE;
    },
    run: async (run) => {
      // 用户本人：开始授权流程，页面打开 authorizeUrl。Lead 打不开用户的浏览器：只给授权卡。
      if (run.by.actor === "user") return { flow: await connectionService(run.env).start(run.target.key) };
      return { userAction: authorizeAction(run.target, run.reason) };
    },
    forLead: (run, result) => ({
      result: "needs_authorization", connection: { key: run.target.key, label: run.target.label },
      user_action: (result as { userAction?: unknown }).userAction ?? authorizeAction(run.target, run.reason), next: AUTHORIZE_NEXT,
    }),
  },
  disconnect: {
    target: "connection", id: "disconnect", label: "断开连接", scope: "tickets:create",
    permission: "lead_allowed", changesRules: true, externalRefusalNext: EXTERNAL_NEXT, liveUserTurnExempt: true,
    external: false, irreversible: false,
    where: (target) => (target.local || target.key.startsWith("custom-") ? `${CONNECTIONS_WHERE}，或者 Lead 动态里那张卡上的「撤销」` : CONNECTIONS_WHERE),
    hint: "断开一个连接：吊销令牌、停掉本地 MCP 的进程；请求过还没授权的撤回。自定义的连接（远程、本地 MCP）断开以后不再列出。"
      + "撤销你自己加的连接也用它。用户自己连的账号只在用户要你断开时断开。",
    defaultReason: "在设置页断开连接",
    available: (target) => (live(target) || target.pending ? AVAILABLE : unavailable("这个连接没有连上")),
    run: async (run) => {
      const connection = await connectionService(run.env).disconnect(run.target.key);
      reportLeadInstallRemoved(run.db, { target: { type: "connection", id: run.target.key }, actor: actorOf(run), reason: run.reason }, run.env.now);
      return { connection };
    },
    forLead: (_run, result) => ({ result: "disconnected", connection: connectionView((result as { connection: ConnectionDto }).connection) }),
    detail: (run) => ({ key: run.target.key, wasState: run.target.state, pending: run.target.pending }),
  },
} satisfies Record<string, UiActionDefinition<ConnectionTarget, any>>;

// ── skill ──────────────────────────────────────────────────────────────────────────

export interface SkillsTarget {
  dir: string;
  installed: InstalledSkill[];
}

export const SKILLS_TARGET: UiActionTargetKind<SkillsTarget> = {
  type: "skills",
  label: "PLC 的 skill 目录",
  idHint: "skills",
  load: (env, id) => {
    if (id !== "skills") return null;
    const dir = skillsDirOf(env);
    return { dir, installed: listInstalledSkills(dir) };
  },
  name: () => "PLC 的 skill 目录",
  describe: (target) => ({
    dir: target.dir,
    installed: target.installed.map((skill) => ({ name: skill.name, repo: skill.repo, commit: skill.commit.slice(0, 12), installedBy: skill.installedBy })),
  }),
};

function skillView(skill: InstalledSkill) {
  return {
    name: skill.name, description: skill.description.slice(0, 300), source: `${skill.repo}@${skill.commit}`, path: skill.path || null,
    files: skill.files.length, scripts: skill.scripts, notes: skill.notes, skillFile: `${skill.dir}/SKILL.md`,
  };
}

export const SKILLS_ACTIONS = {
  install: {
    target: "skills", id: "install", label: "装 skill", scope: "tickets:create",
    permission: "lead_allowed", changesRules: true, externalRefusalNext: EXTERNAL_NEXT, liveUserTurnExempt: true,
    external: false, irreversible: false,
    where: SKILL_WHERE,
    hint: "从 GitHub 装一个 skill 到 PLC 自己的 skill 目录（~/.pi-lead-child/skills）。不要往 ~/.agents/skills、~/.claude/skills 里拷："
      + "那是给别的工具用的。input.repo 写 owner/name，ref 写 commit、tag 或分支（系统解析成 commit 并固定），path 写仓库里 skill 的目录。"
      + "装之前系统做安全检查（越界链接、隐藏字符、没法审查的文件），不过的拒绝并写明原因；带的脚本照装并列出来。"
      + "装好以后马上能用 find_skill 找到。",
    defaultReason: "装了 skill",
    available: () => AVAILABLE,
    run: async (run) => {
      const services = run.env.services;
      let skill: InstalledSkill;
      try {
        skill = await installSkill(run.input as InstallSkillRequest, {
          fetch: fetchOf(services), dir: run.target.dir, reservedNames: services.installs?.reservedSkillNames?.() ?? [],
          now: run.env.now, actor: actorOf(run), reason: run.reason,
        });
      } catch (error) {
        if (error instanceof SkillInstallRefused) throw new UiActionError("forbidden", error.message);
        if (error instanceof SkillSourceUnavailable) throw new UiActionError("unavailable", error.message);
        throw error;
      }
      if (run.by.actor === "lead") {
        reportLeadInstalled(run.db, {
          kind: "skill", target: { type: "skill", id: skill.name }, name: skill.name,
          source: `${skill.repo}@${skill.commit.slice(0, 7)}`, reason: run.reason, scripts: skill.scripts,
        }, run.env.now);
      }
      return skill;
    },
    forLead: (run, result) => ({
      result: "installed", skill: skillView(result as InstalledSkill),
      next: `用 find_skill 找得到它；要用时用 read 读 SKILL.md。${run.by.actor === "lead" ? REPORTED : ""}`,
    }),
    detail: (_run, result) => {
      const skill = result as InstalledSkill;
      return { name: skill.name, repo: skill.repo, commit: skill.commit, files: skill.files.length, scripts: skill.scripts };
    },
  },
} satisfies Record<string, UiActionDefinition<SkillsTarget, any>>;

export interface SkillTarget {
  dir: string;
  skill: InstalledSkill;
}

export const SKILL_TARGET: UiActionTargetKind<SkillTarget> = {
  type: "skill",
  label: "PLC 装的 skill",
  idHint: "skill 的名字（skills 目标的 installed 里的 name）",
  load: (env, id) => {
    const dir = skillsDirOf(env);
    const skill = getInstalledSkill(dir, id);
    return skill ? { dir, skill } : null;
  },
  name: (target) => `skill「${target.skill.name}」`,
  describe: (target) => skillView(target.skill),
};

export const SKILL_ACTIONS = {
  uninstall: {
    target: "skill", id: "uninstall", label: "卸载 skill", scope: "tickets:create",
    permission: "lead_allowed", changesRules: true, externalRefusalNext: EXTERNAL_NEXT, liveUserTurnExempt: true,
    external: false, irreversible: false,
    where: SKILL_WHERE,
    hint: "卸载 PLC 装的一个 skill：删掉它的目录，find_skill 马上找不到。撤销你自己装的 skill 也用它。",
    defaultReason: "卸载了 skill",
    available: () => AVAILABLE,
    run: (run) => {
      const removed = uninstallSkill(run.target.dir, run.target.skill.name);
      if (!removed) throw new UiActionError("not_found", `skill「${run.target.skill.name}」已经不在了`);
      reportLeadInstallRemoved(run.db, { target: { type: "skill", id: removed.name }, actor: actorOf(run), reason: run.reason }, run.env.now);
      return { name: removed.name };
    },
    forLead: (_run, result) => ({ result: "uninstalled", name: (result as { name: string }).name }),
    detail: (run) => ({ name: run.target.skill.name, repo: run.target.skill.repo, commit: run.target.skill.commit }),
  },
} satisfies Record<string, UiActionDefinition<SkillTarget, any>>;
