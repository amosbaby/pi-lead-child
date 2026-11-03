// PLC 自己的 skill 目录（缺省 ~/.pi-lead-child/skills，用户 2026-11-02 定的，不装到共用的 ~/.agents/skills）里装、卸 skill
// （.scratch/lead-self-install/spec.md D5）。
//   - 来源是 GitHub 仓库的一个 commit：ref（commit、tag、分支）先解析成 40 位的 commit，之后只用它，记进清单。
//     不 vendor 进仓库，也不跟着分支走：要换版本就卸载再装。
//   - 先按文件树检查，再下载；每个文件按 tree 给的 blob sha 核对；再按内容检查（skill-scan.ts）。都不执行 skill 里的东西。
//   - 写的时候先写进旁边的暂存目录，用 pi 的 loadSkillsFromDir 核对它认得这个 skill，再改名放进 skill 目录。
//     暂存目录不在 skill 目录里：find_skill 现扫 skill 目录时不会扫到写了一半的。
//   - 文件一律写成 0644：不保留可执行位，脚本要用 bash、python 去跑（在 Lead 的沙箱里）。
//   - 每个装好的 skill 目录里有一份清单 .plc-skill.json。卸载只删有清单的、在 skill 目录下的、名字合规的目录。
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { dataDir } from "@pi-lead-child/core";
import type { InstallSkillRequest } from "@pi-lead-child/protocol";
import type { InstallFetch } from "../ui-actions/types.js";
import { checkSkillContent, checkSkillTree, SKILL_NAME, type SkillTreeEntry } from "./skill-scan.js";

export const SKILL_MANIFEST = ".plc-skill.json";
const REQUEST_TIMEOUT_MS = 20_000;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const REF = /^[A-Za-z0-9._/-]{1,255}$/;
const COMMIT = /^[0-9a-f]{40}$/;

/** PLC 自己的 skill 目录。 */
export function defaultSkillsDir(): string {
  return join(dataDir(), "skills");
}

export class SkillInstallRefused extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`没有装：${problems.join("；")}`);
    this.name = "SkillInstallRefused";
  }
}

export class SkillSourceUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillSourceUnavailable";
  }
}

export interface SkillManifest {
  name: string;
  description: string;
  repo: string;
  ref: string;
  commit: string;
  path: string;
  files: Array<{ path: string; sha: string; size: number }>;
  scripts: string[];
  notes: string[];
  installedBy: "user" | "lead";
  reason: string;
  installedAt: string;
}

export interface InstalledSkill extends SkillManifest {
  dir: string;
}

// ── GitHub ────────────────────────────────────────────────────────────────────────

async function github(fetch: InstallFetch, url: string, accept: string, what: string): Promise<Response | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept, "user-agent": "pi-lead-child", "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new SkillSourceUnavailable(`暂时连不上 GitHub（${what}）：${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 404 || response.status === 422) return null;
  if (response.status === 403 || response.status === 429) throw new SkillSourceUnavailable(`GitHub 限流了（${what}），稍后再试`);
  if (!response.ok) throw new SkillSourceUnavailable(`GitHub 回了 HTTP ${response.status}（${what}）`);
  return response;
}

function normalizedPath(raw: string | undefined): string {
  const path = (raw ?? "").trim().replace(/^\/+|\/+$/gu, "");
  if (!path) return "";
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new SkillInstallRefused([`仓库里的路径「${path.slice(0, 80)}」不对`]);
  }
  return path;
}

function blobSha(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

export interface SkillInstallDeps {
  fetch: InstallFetch;
  dir: string;
  reservedNames: readonly string[];
  now: Date;
  actor: "user" | "lead";
  reason: string;
}

/**
 * 从 GitHub 装一个 skill。检查不过时抛 SkillInstallRefused（写明每一条），GitHub 连不上时抛 SkillSourceUnavailable。
 * 装好以后 find_skill 马上找得到（它每次现扫 skill 目录）。
 */
export async function installSkill(request: InstallSkillRequest, deps: SkillInstallDeps): Promise<InstalledSkill> {
  const repo = request.repo.trim().replace(/^https:\/\/github\.com\//u, "").replace(/\.git$/u, "");
  const ref = request.ref.trim();
  if (!REPO.test(repo)) throw new SkillInstallRefused([`仓库要写成 owner/name：${request.repo.slice(0, 120)}`]);
  if (!REF.test(ref) || ref.split("/").includes("..")) throw new SkillInstallRefused([`ref 的写法不对：${request.ref.slice(0, 120)}`]);
  const path = normalizedPath(request.path);

  // ref → commit。只认 GitHub 解析出的 40 位 commit，之后都用它。
  const resolved = await github(deps.fetch, `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`,
    "application/vnd.github.sha", "解析 ref");
  if (!resolved) throw new SkillInstallRefused([`GitHub 上没有 ${repo}，或者它没有 ${ref}`]);
  const commit = (await resolved.text()).trim();
  if (!COMMIT.test(commit)) throw new SkillSourceUnavailable("GitHub 没有回一个 commit");

  const treeResponse = await github(deps.fetch, `https://api.github.com/repos/${repo}/git/trees/${commit}?recursive=1`,
    "application/vnd.github+json", "读文件树");
  if (!treeResponse) throw new SkillInstallRefused([`读不到 ${repo}@${commit.slice(0, 7)} 的文件树`]);
  const tree = await treeResponse.json() as { tree?: Array<Record<string, unknown>>; truncated?: unknown };
  if (tree.truncated === true) throw new SkillInstallRefused(["仓库太大，GitHub 只回了一部分文件树：用 path 指到 skill 的目录"]);
  const prefix = path ? `${path}/` : "";
  const entries: SkillTreeEntry[] = (tree.tree ?? [])
    .filter((entry) => typeof entry.path === "string" && (entry.path as string).startsWith(prefix))
    .map((entry) => ({
      path: (entry.path as string).slice(prefix.length), mode: String(entry.mode ?? ""), type: String(entry.type ?? ""),
      size: typeof entry.size === "number" ? entry.size : 0, sha: String(entry.sha ?? ""),
    }));
  if (!entries.length) throw new SkillInstallRefused([`${repo}@${commit.slice(0, 7)} 里没有 ${path || "根目录"}`]);
  const treeProblems = checkSkillTree(entries);
  if (treeProblems.length) throw new SkillInstallRefused(treeProblems);

  // 下载，按 blob sha 核对。
  const blobs = entries.filter((entry) => entry.type === "blob");
  const files: Array<{ path: string; content: Buffer; executable: boolean; sha: string }> = [];
  for (const entry of blobs) {
    const encoded = `${prefix}${entry.path}`.split("/").map(encodeURIComponent).join("/");
    const response = await github(deps.fetch, `https://raw.githubusercontent.com/${repo}/${commit}/${encoded}`, "*/*", `下载 ${entry.path}`);
    if (!response) throw new SkillSourceUnavailable(`下载不到 ${entry.path}`);
    const content = Buffer.from(await response.arrayBuffer());
    if (blobSha(content) !== entry.sha) throw new SkillInstallRefused([`${entry.path} 下载到的内容和 commit 里的不一样`]);
    files.push({ path: entry.path, content, executable: entry.mode === "100755", sha: entry.sha });
  }
  const report = checkSkillContent(files);
  if (report.problems.length) throw new SkillInstallRefused(report.problems);
  const name = report.name!;
  if (deps.reservedNames.includes(name)) throw new SkillInstallRefused([`「${name}」和 Lead 自带的 skill 重名`]);
  const target = join(deps.dir, name);
  if (existsSync(target)) throw new SkillInstallRefused([`已经装了「${name}」：要换版本，先卸载再装`]);

  // 写进暂存目录，核对 pi 认得它，再改名放进 skill 目录。
  mkdirSync(deps.dir, { recursive: true, mode: 0o700 });
  const staging = join(dirname(deps.dir), ".skill-staging", `${name}-${randomBytes(4).toString("hex")}`);
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    for (const file of files) {
      const destination = join(staging, ...file.path.split("/"));
      mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
      writeFileSync(destination, file.content, { mode: 0o644 });
    }
    const manifest: SkillManifest = {
      name, description: report.description!, repo, ref, commit, path,
      files: files.map((file) => ({ path: file.path, sha: file.sha, size: file.content.length })),
      scripts: report.scripts, notes: report.notes, installedBy: deps.actor, reason: deps.reason.slice(0, 500),
      installedAt: deps.now.toISOString(),
    };
    writeFileSync(join(staging, SKILL_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    const loaded = loadSkillsFromDir({ dir: staging, source: "plc" }).skills;
    if (!loaded.some((skill) => skill.name === name)) throw new SkillInstallRefused([`pi 认不出这个 skill（SKILL.md 的 frontmatter 不对）`]);
    renameSync(staging, target);
    return { ...manifest, dir: target };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// ── 装好的 skill ───────────────────────────────────────────────────────────────────

/** 装好的一个 skill（有清单、是真目录）。没有时为 null。 */
export function getInstalledSkill(dir: string, name: string): InstalledSkill | null {
  if (!SKILL_NAME.test(name)) return null;
  const skillDir = join(dir, name);
  try {
    if (!lstatSync(skillDir).isDirectory()) return null;
    const manifest = JSON.parse(readFileSync(join(skillDir, SKILL_MANIFEST), "utf8")) as SkillManifest;
    return manifest.name === name ? { ...manifest, dir: skillDir } : null;
  } catch {
    return null;
  }
}

/** skill 目录里 PLC 装的全部 skill，按名字。 */
export function listInstalledSkills(dir: string): InstalledSkill[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.sort().map((name) => getInstalledSkill(dir, name)).filter((skill): skill is InstalledSkill => skill !== null);
}

/** 卸载：删掉这个 skill 的目录。只删 PLC 装的（getInstalledSkill 认得的）。没有时返回 null。 */
export function uninstallSkill(dir: string, name: string): InstalledSkill | null {
  const skill = getInstalledSkill(dir, name);
  if (!skill || basename(skill.dir) !== name || dirname(skill.dir) !== join(dir)) return null;
  rmSync(skill.dir, { recursive: true, force: true });
  return skill;
}
