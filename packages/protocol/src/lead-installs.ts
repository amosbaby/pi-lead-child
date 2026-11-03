// Lead 自己安装 MCP 和 skill（用户 2026-11-02，.scratch/lead-self-install/spec.md）。
//
// 三种能力，都是操作层的操作（ui-actions.ts），页面和 Lead 调同一个函数：
//   - 远程 MCP：connections / connections / add_remote（input: {url}）。要授权时先建一行，结果里带授权卡。
//   - 本地 MCP：connections / connections / add_local（npm 或 PyPI 的包）。先查官方仓库审查，Lead 调用时再要用户在确认卡上点。
//   - skill：skills / skills / install（GitHub 仓库的一个 commit）。装进 PLC 自己的 skill 目录，find_skill 马上找得到。
// 撤销：connection / <key> / disconnect，skill / <名字> / uninstall。
// 都算改规则（会改变 Lead 的行为）：外部消息叫醒的一轮、读过外部内容的一轮只拒绝，用户本人正在说话的一轮除外。
//
// Lead 装了东西、或者 Lead 装的东西被撤销时，写一条 lead_install.changed（digest 级）：「Lead 动态」里出现一张卡，
// Lead 装的那一条带「撤销」按钮（engine 的 ui-actions/card-actions.ts）。用户自己在页面上装的不写。
//
// 这个文件只依赖 typebox 和同包的 events.ts，companion 也读它。
import { Type, type Static, type TProperties } from "typebox";
import { registerEventKind, type EventKindDefinition } from "./events.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const LEAD_INSTALL_LIMITS = {
  url: 2_000,
  package: 214,
  version: 64,
  bin: 100,
  args: 20,
  arg: 500,
  repo: 140,
  ref: 255,
  path: 400,
} as const;

// ── 操作的输入 ─────────────────────────────────────────────────────────────────────

// 远程 MCP：服务器地址（https）。
export const AddRemoteMcpRequestSchema = StrictObject({
  url: Type.String({ minLength: 8, maxLength: LEAD_INSTALL_LIMITS.url }),
});
export type AddRemoteMcpRequest = Static<typeof AddRemoteMcpRequestSchema>;

export const LOCAL_MCP_REGISTRIES = ["npm", "pypi"] as const;
export type LocalMcpRegistry = typeof LOCAL_MCP_REGISTRIES[number];

// 本地 MCP：哪个仓库的哪个包。version 要写确切的版本（1.2.3）；不写时审查挑满 7 天的最新正式版。
// bin 是包里的哪个命令（npm 的 bin、PyPI 的 console script）；不写时按包名。args 原样传给它，不经过 shell。
export const AddLocalMcpRequestSchema = StrictObject({
  registry: Type.Union([Type.Literal("npm"), Type.Literal("pypi")]),
  package: Type.String({ minLength: 1, maxLength: LEAD_INSTALL_LIMITS.package }),
  version: Type.Optional(Type.String({ minLength: 1, maxLength: LEAD_INSTALL_LIMITS.version })),
  bin: Type.Optional(Type.String({ minLength: 1, maxLength: LEAD_INSTALL_LIMITS.bin })),
  args: Type.Optional(Type.Array(Type.String({ maxLength: LEAD_INSTALL_LIMITS.arg }), { maxItems: LEAD_INSTALL_LIMITS.args })),
});
export type AddLocalMcpRequest = Static<typeof AddLocalMcpRequestSchema>;

// skill：GitHub 仓库（owner/name）、ref（commit、tag 或分支，装的时候解析成 commit 并记下）、仓库里 skill 的目录（缺省是根目录）。
export const InstallSkillRequestSchema = StrictObject({
  repo: Type.String({ minLength: 3, maxLength: LEAD_INSTALL_LIMITS.repo }),
  ref: Type.String({ minLength: 1, maxLength: LEAD_INSTALL_LIMITS.ref }),
  path: Type.Optional(Type.String({ maxLength: LEAD_INSTALL_LIMITS.path })),
});
export type InstallSkillRequest = Static<typeof InstallSkillRequestSchema>;

// ── 事件：Lead 动态 ────────────────────────────────────────────────────────────────

export const LEAD_INSTALL_CHANGED_KIND = "lead_install.changed";

export const LEAD_INSTALL_KINDS = ["remote_mcp", "local_mcp", "skill"] as const;
export type LeadInstallKind = typeof LEAD_INSTALL_KINDS[number];

/** 一个装上的能力的对象键：连接是 connection:<key>，skill 是 skill:<名字>。 */
export function leadInstallEntityKey(target: { type: "connection" | "skill"; id: string }): string {
  return `${target.type}:${target.id}`;
}

export const LeadInstallChangedPayloadSchema = Type.Object({
  kind: Type.Union([Type.Literal("remote_mcp"), Type.Literal("local_mcp"), Type.Literal("skill")]),
  // installed 装上了（远程 MCP 要授权时是「加上了，等授权」），removed 撤销了。
  action: Type.Union([Type.Literal("installed"), Type.Literal("removed")]),
  actor: Type.Union([Type.Literal("user"), Type.Literal("lead")]),
  // 撤销它的操作的目标（操作层的 connection / <key>、skill / <名字>）。
  target: Type.Object({ type: Type.Union([Type.Literal("connection"), Type.Literal("skill")]), id: Type.String({ minLength: 1 }) }),
  // 给人看的名字：连接的名字、skill 的名字。
  name: Type.String(),
  // 从哪里来：服务器地址、npm:<包>@<版本>、owner/repo@<commit>。
  source: Type.String(),
  reason: Type.String(),
  // 对用户说的那句话（按写入时用户选的语言），例如「Fairy 装了 skill「pdf-tools」（acme/skills@1a2b3c4）……」。
  summary: Type.String(),
  // 远程 MCP 加上了、还在等用户授权。
  pendingAuthorization: Type.Optional(Type.Boolean()),
});
export type LeadInstallChangedPayload = Static<typeof LeadInstallChangedPayloadSchema>;

export const LEAD_INSTALL_EVENT_KINDS: readonly EventKindDefinition[] = [
  {
    // Lead 装了一个远程 MCP、本地 MCP 或 skill，或者 Lead 装的被撤销了（用户 2026-11-02）。digest 级，在「Lead 动态」里告诉用户，
    // Lead 装的那一条带「撤销」。Lead 装的来源是 lead；用户撤销时来源是 system（来源 user 只给用户发给 Lead 的消息）。
    // entity_key 是 connection:<key> 或 skill:<名字>。
    kind: LEAD_INSTALL_CHANGED_KIND,
    sources: ["lead", "system"],
    payload: LeadInstallChangedPayloadSchema,
    description: "Lead 装了一个能力（远程 MCP、本地 MCP、skill），或者 Lead 装的能力被撤销了。",
  },
];

for (const definition of LEAD_INSTALL_EVENT_KINDS) registerEventKind(definition);

// 审查结果里给人看的一行（确认卡、Lead 的结果）。
export const LocalMcpReviewFactSchema = StrictObject({ name: Type.String(), value: Type.String() });
export type LocalMcpReviewFact = Static<typeof LocalMcpReviewFactSchema>;

export const LocalMcpLaunchSchema = StrictObject({
  registry: Type.Union([Type.Literal("npm"), Type.Literal("pypi")]),
  package: Type.String({ minLength: 1 }),
  version: Type.String({ minLength: 1 }),
  bin: Type.String({ minLength: 1 }),
  args: Type.Array(Type.String()),
});
/** 一个本地 MCP 的启动参数：存在连接那一行的 launch_json 里，审查时固定。可执行文件（npx、uvx）在起进程时再找。 */
export type LocalMcpLaunch = Static<typeof LocalMcpLaunchSchema>;

/** 起进程用的可执行文件的名字和参数（不经过 shell）。版本固定成确切的那一个。 */
export function localMcpCommand(launch: LocalMcpLaunch): { executable: "npx" | "uvx"; args: string[] } {
  return launch.registry === "npm"
    ? { executable: "npx", args: ["-y", `--package=${launch.package}@${launch.version}`, "--", launch.bin, ...launch.args] }
    : { executable: "uvx", args: ["--from", `${launch.package}==${launch.version}`, launch.bin, ...launch.args] };
}

/** 本地 MCP 给人看的命令：npx -y --package=pkg@1.2.3 -- pkg --flag。 */
export function localMcpCommandText(launch: LocalMcpLaunch): string {
  const { executable, args } = localMcpCommand(launch);
  const quote = (part: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`);
  return [executable, ...args].map(quote).join(" ");
}
