// Lead 自己装 MCP 和 skill 的测试替身（.scratch/lead-self-install）：假的 npm、PyPI、GitHub（按官方 API 的形状回），
// 和一个照连接中心写账本的假连接服务（建行、记 requested、连上、断开），这样 Lead 动态的卡按账本算按钮时看得到它。
import { createHash } from "node:crypto";
import type { ConnectionDto, LocalMcpLaunch } from "@pi-lead-child/protocol";
import {
  addConnectionEvent, CONNECTION_REMOVED_EVENT, CONNECTION_REQUESTED_EVENT, connectionKeyOf, connectionRequestPending, getConnection,
  getConnectionByServer, insertConnection, updateConnection, type Db,
} from "@pi-lead-child/store";
import type { ConnectionInstallService, InstallFetch } from "../src/index.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** 按 URL 回预先放好的回复；没放的回 404。calls 记下每一次请求的 URL。 */
export function fakeFetch(routes: Record<string, unknown | (() => Response)>): InstallFetch & { calls: string[] } {
  const calls: string[] = [];
  const handler = async (input: string) => {
    calls.push(input);
    const route = routes[input];
    if (route === undefined) return new Response("not found", { status: 404 });
    return typeof route === "function" ? (route as () => Response)() : route instanceof Response ? route : json(route);
  };
  return Object.assign(handler, { calls });
}

export const NOW = new Date("2026-11-02T08:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

/** 一个看起来正常的 npm 包（满足审查的门槛）。overrides 改版本的元数据或整份文档。 */
export function npmPackage(name = "@acme/fake-mcp", options: {
  versions?: Record<string, { publishedDaysAgo: number; meta?: Record<string, unknown> }>;
  createdDaysAgo?: number; downloads?: number; repository?: unknown;
} = {}): Record<string, unknown> {
  const versions = options.versions ?? { "1.2.3": { publishedDaysAgo: 20 } };
  const doc = {
    name,
    "dist-tags": { latest: Object.keys(versions).at(-1) },
    versions: Object.fromEntries(Object.entries(versions).map(([version, entry]) => [version, {
      name, version, bin: { "fake-mcp": "dist/index.js" }, ...entry.meta,
    }])),
    time: {
      created: daysAgo(options.createdDaysAgo ?? 200), modified: daysAgo(1),
      ...Object.fromEntries(Object.entries(versions).map(([version, entry]) => [version, daysAgo(entry.publishedDaysAgo)])),
    },
    maintainers: [{ name: "alice", email: "alice@example.com" }],
    repository: options.repository === undefined ? { type: "git", url: "git+https://github.com/acme/fake-mcp.git" } : options.repository,
  };
  return {
    [`https://registry.npmjs.org/${name.replace("/", "%2f")}`]: doc,
    [`https://api.npmjs.org/downloads/point/last-week/${name}`]: { downloads: options.downloads ?? 25_000, package: name },
  };
}

/** 一个看起来正常的 PyPI 包。 */
export function pypiPackage(name = "fake-mcp-server", options: {
  releases?: Record<string, Array<{ packagetype: string; daysAgo: number; yanked?: boolean }>>;
  downloads?: number; projectUrls?: Record<string, string> | null;
} = {}): Record<string, unknown> {
  const releases = options.releases ?? {
    "0.9.0": [{ packagetype: "bdist_wheel", daysAgo: 120 }],
    "1.0.0": [{ packagetype: "sdist", daysAgo: 30 }, { packagetype: "bdist_wheel", daysAgo: 30 }],
  };
  return {
    [`https://pypi.org/pypi/${name}/json`]: {
      info: {
        name, version: Object.keys(releases).at(-1), author: "Nina", maintainer: null,
        project_urls: options.projectUrls === undefined ? { Source: "https://github.com/acme/fake-mcp-server" } : options.projectUrls,
      },
      releases: Object.fromEntries(Object.entries(releases).map(([version, files]) => [version, files.map((file) => ({
        packagetype: file.packagetype, upload_time_iso_8601: daysAgo(file.daysAgo), yanked: file.yanked ?? false,
      }))])),
    },
    [`https://pypistats.org/api/packages/${name.toLowerCase()}/recent`]: { data: { last_day: 300, last_week: options.downloads ?? 4_000, last_month: 20_000 } },
  };
}

export const COMMIT = "1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d";

const blobSha = (content: Buffer) => createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");

/** 假的 GitHub：repo 在 ref 上是 files（路径 → 内容）。mode 给出符号链接、可执行位。 */
export function githubRepo(repo: string, ref: string, files: Record<string, string | Buffer>, modes: Record<string, string> = {}): Record<string, unknown> {
  const entries = Object.entries(files).map(([path, content]) => {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    return { path, buffer, mode: modes[path] ?? "100644" };
  });
  const dirs = [...new Set(entries.flatMap((entry) => entry.path.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"))))];
  const routes: Record<string, unknown> = {
    [`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`]: () => new Response(COMMIT, { status: 200 }),
    [`https://api.github.com/repos/${repo}/git/trees/${COMMIT}?recursive=1`]: {
      sha: COMMIT, truncated: false,
      tree: [
        ...dirs.map((path) => ({ path, mode: "040000", type: "tree", sha: "0".repeat(40) })),
        ...entries.map((entry) => ({
          path: entry.path, mode: entry.mode, type: entry.mode === "160000" ? "commit" : "blob", sha: blobSha(entry.buffer), size: entry.buffer.length,
        })),
      ],
    },
  };
  for (const entry of entries) {
    const url = `https://raw.githubusercontent.com/${repo}/${COMMIT}/${entry.path.split("/").map(encodeURIComponent).join("/")}`;
    routes[url] = () => new Response(new Uint8Array(entry.buffer), { status: 200 });
  }
  return routes;
}

export const SKILL_MD = `---
name: pdf-tools
description: Extract text and tables from PDF files. Use when reading PDFs.
---

# PDF tools

Read [the formats](references/formats.md) first. See https://example.com/docs for more.
`;

function dto(db: Db, id: number): ConnectionDto {
  const row = getConnection(db, id)!;
  const live = row.status !== "disconnected";
  return {
    key: connectionKeyOf(row), provider: "custom", label: row.label, capability: "", serverUrl: row.server_url,
    state: live ? row.status as ConnectionDto["state"] : "not_connected",
    account: null, tokenSource: live ? "oauth" : null, connectedAt: row.connected_at, lastUsedAt: null, lastRefreshAt: null,
    accessExpiresAt: null, grantExpiresAt: null, problem: null, tools: live ? { total: 2, readOnly: 2, write: 0 } : null,
    roles: ["lead", "executor", "reviewer"], writePolicy: "direct", setupHint: null,
  };
}

/** 照连接中心写账本的假连接服务。remoteNeedsAuth：远程 MCP 要不要授权。 */
export function fakeConnections(db: Db, options: { remoteNeedsAuth?: boolean } = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const now = () => new Date().toISOString();
  const service: ConnectionInstallService = {
    get: (key) => {
      const match = /^custom-(\d+)$/.exec(key);
      return match && getConnection(db, Number(match[1])) ? dto(db, Number(match[1])) : null;
    },
    async requestRemote(url, meta) {
      calls.push({ method: "requestRemote", args: [url, meta] });
      const existing = getConnectionByServer(db, url);
      if (existing && existing.status !== "disconnected") return { state: "connected", connection: dto(db, existing.id), toolCount: 2, existing: true };
      const row = existing ?? insertConnection(db, { provider: "custom", label: new URL(url).host, serverUrl: url, tokenSource: "oauth" });
      addConnectionEvent(db, row.id, CONNECTION_REQUESTED_EVENT, JSON.stringify(meta), now());
      if (options.remoteNeedsAuth === false) {
        updateConnection(db, row.id, { status: "connected", connected_at: now() });
        return { state: "connected", connection: dto(db, row.id), toolCount: 2, existing: false };
      }
      return { state: "needs_authorization", connection: dto(db, row.id), toolCount: null, existing: false };
    },
    async start(key) {
      calls.push({ method: "start", args: [key] });
      return { flow: "browser", flowId: "flow_abcdefgh1234", authorizeUrl: "https://auth.example.com/authorize?x=1", expiresAt: now() };
    },
    async disconnect(key) {
      calls.push({ method: "disconnect", args: [key] });
      const id = Number(key.slice("custom-".length));
      const row = getConnection(db, id)!;
      if (row.status === "disconnected" && connectionRequestPending(db, id)) addConnectionEvent(db, id, CONNECTION_REMOVED_EVENT, null, now());
      else {
        updateConnection(db, id, { status: "disconnected" });
        addConnectionEvent(db, id, "disconnected", null, now());
      }
      return dto(db, id);
    },
    async addLocal(launch: LocalMcpLaunch, meta) {
      calls.push({ method: "addLocal", args: [launch, meta] });
      const row = insertConnection(db, {
        provider: "custom", label: launch.package, serverUrl: `stdio:${launch.registry}:${launch.package}@${launch.version}`,
        tokenSource: "oauth", launchJson: JSON.stringify(launch),
      });
      updateConnection(db, row.id, { status: "connected", connected_at: now() });
      return { connection: dto(db, row.id), toolCount: 2 };
    },
  };
  return { service, calls };
}
