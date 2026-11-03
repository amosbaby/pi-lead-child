// 本地 MCP 的审查（.scratch/lead-self-install/spec.md D4，门槛是用户 2026-11-02 定的 D9 Q2）。
// 本地 MCP 在用户的电脑上、沙箱外起一个进程，所以装之前查官方仓库（npm、PyPI），不信 Lead 给的说法：
//   - 包要存在（Lead 不能自己编包名），版本固定成确切的一个，不跟着 latest 走；
//   - 防仿冒和投毒：版本发布满 7 天、包第一次发布满 30 天、上周下载量至少 1,000、有源码仓库的链接；
//   - 装的时候不跑代码：npm 版本不能有安装脚本，PyPI 版本要有 wheel（只有 sdist 时 pip 会跑 setup.py）；
//   - 弃用、撤回的版本不装。
// 通过时给出固定好的启动参数（protocol 的 LocalMcpLaunch）和给人看的审查摘要；不通过时抛 LocalMcpReviewRefused，写明每一条原因。
// 查不到（网络、仓库出错）时抛 LocalMcpReviewUnavailable：不能当作通过。
import { redactSecretText, type AddLocalMcpRequest, type LocalMcpLaunch, type LocalMcpRegistry } from "@pi-lead-child/protocol";
import type { InstallFetch } from "../ui-actions/types.js";

export const LOCAL_MCP_REVIEW_RULES = {
  minVersionAgeDays: 7,
  minPackageAgeDays: 30,
  minWeeklyDownloads: 1_000,
} as const;

const DAY = 24 * 3_600_000;
const REQUEST_TIMEOUT_MS = 15_000;

export class LocalMcpReviewRefused extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`审查没有通过：${problems.join("；")}`);
    this.name = "LocalMcpReviewRefused";
  }
}

export class LocalMcpReviewUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalMcpReviewUnavailable";
  }
}

// 给人看的审查摘要：确认卡和 Lead 的结果都用它。都是官方仓库的结构化数据，不放包的说明（任意文字）。
export interface LocalMcpReviewFacts {
  registry: LocalMcpRegistry;
  package: string;
  version: string;
  // 这个版本发布的时间、包第一次发布的时间（ISO）。
  publishedAt: string;
  firstPublishedAt: string;
  weeklyDownloads: number;
  maintainers: string[];
  repository: string;
  // 审查没法核对、但要告诉用户的事（例如 PyPI 的命令名没法从仓库读到）。
  notes: string[];
}

export interface LocalMcpReview {
  launch: LocalMcpLaunch;
  facts: LocalMcpReviewFacts;
}

export interface LocalMcpReviewDeps {
  fetch: InstallFetch;
  now: Date;
  hasExecutable?: (name: "npx" | "uvx") => boolean;
}

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const NPM_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PYPI_VERSION = /^\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?$/i;
const BIN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const ageDays = (iso: string, now: Date) => (now.getTime() - Date.parse(iso)) / DAY;
const day = (iso: string) => iso.slice(0, 10);
const clip = (text: string, max = 60) => {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

async function getJson(deps: LocalMcpReviewDeps, url: string, what: string): Promise<unknown | null> {
  let response: Response;
  try {
    response = await deps.fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new LocalMcpReviewUnavailable(`暂时查不到${what}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new LocalMcpReviewUnavailable(`暂时查不到${what}：HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new LocalMcpReviewUnavailable(`${what}的回复不是 JSON`);
  }
}

/** 检查输入的写法（不联网）。不对时抛 LocalMcpReviewRefused。 */
function checkInput(request: AddLocalMcpRequest): void {
  const problems: string[] = [];
  const npm = request.registry === "npm";
  if (!(npm ? NPM_NAME : PYPI_NAME).test(request.package)) problems.push(`包名「${clip(request.package)}」的写法不对`);
  if (request.version !== undefined && !(npm ? NPM_VERSION : PYPI_VERSION).test(request.version)) {
    problems.push(`版本要写确切的一个（例如 ${npm ? "1.2.3" : "1.2.3 或 0.4.0rc1"}），不能写范围或 latest：${clip(request.version)}`);
  }
  if (request.bin !== undefined && !BIN.test(request.bin)) problems.push(`命令名「${clip(request.bin)}」的写法不对`);
  for (const arg of request.args ?? []) {
    if (/[\u0000-\u001f\u007f]/u.test(arg)) problems.push("参数里不能有换行和控制字符");
    else if (redactSecretText(arg) !== arg) problems.push("参数里有像密钥或令牌的文字：本地 MCP 的密钥还不支持传进去");
  }
  if (problems.length) throw new LocalMcpReviewRefused([...new Set(problems)]);
}

/** 审查一个本地 MCP 的包。通过时返回固定好的启动参数和摘要。 */
export async function reviewLocalMcp(request: AddLocalMcpRequest, deps: LocalMcpReviewDeps): Promise<LocalMcpReview> {
  checkInput(request);
  return request.registry === "npm" ? reviewNpm(request, deps) : reviewPypi(request, deps);
}

// ── npm ───────────────────────────────────────────────────────────────────────────

interface NpmVersion {
  deprecated?: unknown;
  scripts?: Record<string, unknown>;
  hasInstallScript?: unknown;
  bin?: unknown;
  repository?: unknown;
}

interface NpmPackument {
  name?: unknown;
  "dist-tags"?: Record<string, unknown>;
  versions?: Record<string, NpmVersion>;
  time?: Record<string, unknown>;
  maintainers?: Array<{ name?: unknown }>;
  repository?: unknown;
}

function repositoryUrl(value: unknown): string | null {
  const url = typeof value === "string" ? value : value && typeof value === "object" ? (value as { url?: unknown }).url : null;
  if (typeof url !== "string" || !url.trim()) return null;
  return url.trim().replace(/^git\+/u, "").replace(/\.git$/u, "");
}

function npmBins(name: string, bin: unknown): string[] {
  if (typeof bin === "string" && bin.trim()) return [name.replace(/^@[^/]+\//u, "")];
  if (bin && typeof bin === "object") return Object.keys(bin).filter((key) => BIN.test(key));
  return [];
}

async function reviewNpm(request: AddLocalMcpRequest, deps: LocalMcpReviewDeps): Promise<LocalMcpReview> {
  const encoded = request.package.replace("/", "%2f");
  const doc = await getJson(deps, `https://registry.npmjs.org/${encoded}`, "npm 上的包信息") as NpmPackument | null;
  if (!doc || !doc.versions) {
    throw new LocalMcpReviewRefused([`npm 上没有「${request.package}」这个包。不要自己编包名：从用户给的话或者这个服务器的官方文档里拿`]);
  }
  const time = doc.time ?? {};
  const published = (version: string) => (typeof time[version] === "string" ? time[version] as string : null);
  const problems: string[] = [];
  let version = request.version ?? null;
  if (version !== null && !doc.versions[version]) {
    throw new LocalMcpReviewRefused([`npm 上的「${request.package}」没有 ${version} 这个版本`]);
  }
  if (version === null) {
    // 满 7 天的最新正式版（刚发布的版本最容易是被投毒的那一个）。
    const candidates = Object.keys(doc.versions)
      .filter((candidate) => NPM_VERSION.test(candidate) && !candidate.includes("-") && published(candidate) !== null)
      .filter((candidate) => ageDays(published(candidate)!, deps.now) >= LOCAL_MCP_REVIEW_RULES.minVersionAgeDays)
      .sort((a, b) => Date.parse(published(b)!) - Date.parse(published(a)!));
    version = candidates[0] ?? null;
    if (version === null) throw new LocalMcpReviewRefused([`「${request.package}」没有发布满 ${LOCAL_MCP_REVIEW_RULES.minVersionAgeDays} 天的正式版`]);
  }
  const meta = doc.versions[version]!;
  const publishedAt = published(version);
  if (!publishedAt) problems.push(`查不到 ${version} 的发布时间`);
  else if (ageDays(publishedAt, deps.now) < LOCAL_MCP_REVIEW_RULES.minVersionAgeDays) {
    problems.push(`${version} 发布不满 ${LOCAL_MCP_REVIEW_RULES.minVersionAgeDays} 天（${day(publishedAt)}）：换一个更早的版本`);
  }
  const created = typeof time.created === "string" ? time.created : null;
  if (!created) problems.push("查不到这个包第一次发布的时间");
  else if (ageDays(created, deps.now) < LOCAL_MCP_REVIEW_RULES.minPackageAgeDays) {
    problems.push(`这个包第一次发布不满 ${LOCAL_MCP_REVIEW_RULES.minPackageAgeDays} 天（${day(created)}）`);
  }
  if (meta.deprecated) problems.push(`${version} 已经弃用`);
  const scripts = meta.scripts ?? {};
  const installScripts = ["preinstall", "install", "postinstall"].filter((name) => typeof scripts[name] === "string");
  if (installScripts.length || meta.hasInstallScript === true) {
    problems.push(`${version} 装的时候会跑脚本（${installScripts.join("、") || "install"}）`);
  }
  const repository = repositoryUrl(meta.repository) ?? repositoryUrl(doc.repository);
  if (!repository) problems.push("没有源码仓库的链接");
  const bins = npmBins(request.package, meta.bin);
  let bin = request.bin ?? null;
  if (!bins.length) problems.push(`${version} 没有可执行的命令（package.json 的 bin），不是 stdio MCP 服务器`);
  else if (bin !== null && !bins.includes(bin)) problems.push(`${version} 没有「${bin}」这个命令，有的是：${bins.join("、")}`);
  else if (bin === null) {
    const unscoped = request.package.replace(/^@[^/]+\//u, "");
    bin = bins.length === 1 ? bins[0]! : bins.includes(unscoped) ? unscoped : null;
    if (bin === null) problems.push(`有几个命令：${bins.join("、")}。用 bin 选一个`);
  }
  const downloads = await getJson(
    deps, `https://api.npmjs.org/downloads/point/last-week/${request.package}`, "npm 的下载量",
  ) as { downloads?: unknown } | null;
  const weeklyDownloads = typeof downloads?.downloads === "number" ? downloads.downloads : 0;
  if (weeklyDownloads < LOCAL_MCP_REVIEW_RULES.minWeeklyDownloads) {
    problems.push(`上周下载量 ${weeklyDownloads}，少于 ${LOCAL_MCP_REVIEW_RULES.minWeeklyDownloads}`);
  }
  if (deps.hasExecutable && !deps.hasExecutable("npx")) problems.push("这台电脑上找不到 npx");
  if (problems.length) throw new LocalMcpReviewRefused(problems);
  const maintainers = (doc.maintainers ?? []).map((entry) => (typeof entry.name === "string" ? clip(entry.name, 40) : "")).filter(Boolean);
  return {
    launch: { registry: "npm", package: request.package, version, bin: bin!, args: [...(request.args ?? [])] },
    facts: {
      registry: "npm", package: request.package, version, publishedAt: publishedAt!, firstPublishedAt: created!, weeklyDownloads,
      maintainers: maintainers.slice(0, 5), repository: clip(repository!, 200), notes: [],
    },
  };
}

// ── PyPI ──────────────────────────────────────────────────────────────────────────

interface PypiFile {
  packagetype?: unknown;
  upload_time_iso_8601?: unknown;
  yanked?: unknown;
}

interface PypiProject {
  info?: { name?: unknown; author?: unknown; maintainer?: unknown; project_urls?: Record<string, unknown> | null; home_page?: unknown };
  releases?: Record<string, PypiFile[]>;
}

const CODE_HOST = /^https:\/\/(?:github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)\//u;

function pypiRepository(info: NonNullable<PypiProject["info"]>): string | null {
  const urls = Object.entries(info.project_urls ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  const named = urls.find(([name]) => /^(source|source code|repository|code|github|gitlab)$/iu.test(name.trim()));
  if (named) return named[1].trim();
  const hosted = [...urls.map(([, url]) => url), typeof info.home_page === "string" ? info.home_page : ""].find((url) => CODE_HOST.test(url));
  return hosted?.trim() ?? null;
}

function firstUpload(files: PypiFile[]): string | null {
  const times = files.map((file) => file.upload_time_iso_8601).filter((value): value is string => typeof value === "string").sort();
  return times[0] ?? null;
}

async function reviewPypi(request: AddLocalMcpRequest, deps: LocalMcpReviewDeps): Promise<LocalMcpReview> {
  const doc = await getJson(deps, `https://pypi.org/pypi/${encodeURIComponent(request.package)}/json`, "PyPI 上的包信息") as PypiProject | null;
  if (!doc?.info || !doc.releases) {
    throw new LocalMcpReviewRefused([`PyPI 上没有「${request.package}」这个包。不要自己编包名：从用户给的话或者这个服务器的官方文档里拿`]);
  }
  const releases = doc.releases;
  const uploaded = (version: string) => firstUpload(releases[version] ?? []);
  const problems: string[] = [];
  let version = request.version ?? null;
  if (version !== null && !(releases[version]?.length)) throw new LocalMcpReviewRefused([`PyPI 上的「${request.package}」没有 ${version} 这个版本`]);
  if (version === null) {
    const candidates = Object.keys(releases)
      .filter((candidate) => PYPI_VERSION.test(candidate) && !/[a-z]/iu.test(candidate) && uploaded(candidate) !== null)
      .filter((candidate) => !releases[candidate]!.every((file) => file.yanked === true))
      .filter((candidate) => ageDays(uploaded(candidate)!, deps.now) >= LOCAL_MCP_REVIEW_RULES.minVersionAgeDays)
      .sort((a, b) => Date.parse(uploaded(b)!) - Date.parse(uploaded(a)!));
    version = candidates[0] ?? null;
    if (version === null) throw new LocalMcpReviewRefused([`「${request.package}」没有发布满 ${LOCAL_MCP_REVIEW_RULES.minVersionAgeDays} 天的正式版`]);
  }
  const files = releases[version]!;
  const publishedAt = uploaded(version);
  if (!publishedAt) problems.push(`查不到 ${version} 的发布时间`);
  else if (ageDays(publishedAt, deps.now) < LOCAL_MCP_REVIEW_RULES.minVersionAgeDays) {
    problems.push(`${version} 发布不满 ${LOCAL_MCP_REVIEW_RULES.minVersionAgeDays} 天（${day(publishedAt)}）：换一个更早的版本`);
  }
  const created = Object.values(releases).map(firstUpload).filter((value): value is string => value !== null).sort()[0] ?? null;
  if (!created) problems.push("查不到这个包第一次发布的时间");
  else if (ageDays(created, deps.now) < LOCAL_MCP_REVIEW_RULES.minPackageAgeDays) {
    problems.push(`这个包第一次发布不满 ${LOCAL_MCP_REVIEW_RULES.minPackageAgeDays} 天（${day(created)}）`);
  }
  if (files.length && files.every((file) => file.yanked === true)) problems.push(`${version} 已经撤回（yanked）`);
  if (!files.some((file) => file.packagetype === "bdist_wheel" && file.yanked !== true)) {
    problems.push(`${version} 没有 wheel，只有源码包：装的时候会跑 setup.py`);
  }
  const repository = pypiRepository(doc.info);
  if (!repository) problems.push("没有源码仓库的链接");
  const stats = await getJson(
    deps, `https://pypistats.org/api/packages/${encodeURIComponent(request.package.toLowerCase())}/recent`, "PyPI 的下载量",
  ) as { data?: { last_week?: unknown } } | null;
  const weeklyDownloads = typeof stats?.data?.last_week === "number" ? stats.data.last_week : 0;
  if (weeklyDownloads < LOCAL_MCP_REVIEW_RULES.minWeeklyDownloads) {
    problems.push(`上周下载量 ${weeklyDownloads}，少于 ${LOCAL_MCP_REVIEW_RULES.minWeeklyDownloads}`);
  }
  if (deps.hasExecutable && !deps.hasExecutable("uvx")) problems.push("这台电脑上找不到 uvx（先装 uv）");
  if (problems.length) throw new LocalMcpReviewRefused(problems);
  const people = [doc.info.author, doc.info.maintainer].filter((value): value is string => typeof value === "string" && value.trim() !== "");
  const bin = request.bin ?? request.package.toLowerCase().replace(/_/gu, "-");
  return {
    launch: { registry: "pypi", package: request.package, version, bin, args: [...(request.args ?? [])] },
    facts: {
      registry: "pypi", package: request.package, version, publishedAt: publishedAt!, firstPublishedAt: created!, weeklyDownloads,
      maintainers: [...new Set(people.map((person) => clip(person, 60)))].slice(0, 5), repository: clip(repository!, 200),
      notes: request.bin ? [] : [`PyPI 读不到包里的命令名，按包名用「${bin}」；起不来时安装会失败，换 bin 再试`],
    },
  };
}
