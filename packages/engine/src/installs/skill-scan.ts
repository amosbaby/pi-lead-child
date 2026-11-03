// skill 装之前的安全检查（.scratch/lead-self-install/spec.md D6，脚本照装是用户 2026-11-02 定的 D9 Q1）。
// 两步，都不执行 skill 里的任何东西：
//   1. 按 GitHub 的文件树检查（下载以前）：符号链接和子模块、路径、数量和大小、编译产物。
//   2. 按内容检查（下载以后、写进 skill 目录以前）：隐藏字符、指向 skill 目录外面的链接、不是文本也不是常见图片的文件。
// 拒绝的写明文件（和行）；脚本不拒绝，列出来（只在 Lead 的沙箱里跑）；SKILL.md 里渲染时看不到的 HTML 注释写进说明。
import { posix } from "node:path";

export const SKILL_LIMITS = { files: 200, totalBytes: 5 * 1024 * 1024, fileBytes: 1024 * 1024 } as const;

// Agent Skills 规范的名字：小写字母、数字、连字符，最长 64。
export const SKILL_NAME = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/;

export interface SkillTreeEntry {
  // 相对 skill 目录的路径（posix）。
  path: string;
  // git 的模式：100644 普通文件，100755 可执行，120000 符号链接，160000 子模块。
  mode: string;
  type: string;
  size: number;
  sha: string;
}

const COMPILED = /\.(?:so|dylib|dll|exe|bin|o|a|class|jar|pyc|pyo|wasm|node)$/iu;
const IMAGE = /\.(?:png|jpe?g|gif|webp|ico)$/iu;
const SCRIPT = /\.(?:sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|php|ps1|bat|cmd|lua)$/iu;

/** 下载以前：按文件树检查。返回问题（空的表示可以下载）。 */
export function checkSkillTree(entries: readonly SkillTreeEntry[]): string[] {
  const problems: string[] = [];
  let total = 0;
  let files = 0;
  for (const entry of entries) {
    if (entry.mode === "120000") {
      problems.push(`${entry.path} 是符号链接：可能指向 skill 目录外面（越界链接）`);
      continue;
    }
    if (entry.mode === "160000" || entry.type === "commit") {
      problems.push(`${entry.path} 是子模块：内容不在这个仓库里，没法检查`);
      continue;
    }
    if (entry.type !== "blob") continue;
    const segments = entry.path.split("/");
    if (entry.path.startsWith("/") || segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
      problems.push(`${entry.path} 的路径不对`);
      continue;
    }
    if (COMPILED.test(entry.path)) problems.push(`${entry.path} 是编译产物，没法审查`);
    if (entry.size > SKILL_LIMITS.fileBytes) problems.push(`${entry.path} 超过 ${SKILL_LIMITS.fileBytes / 1024 / 1024} MB`);
    files += 1;
    total += entry.size;
  }
  if (!entries.some((entry) => entry.path === "SKILL.md" && entry.type === "blob")) problems.push("目录里没有 SKILL.md");
  if (files > SKILL_LIMITS.files) problems.push(`文件太多：${files} 个，最多 ${SKILL_LIMITS.files} 个`);
  if (total > SKILL_LIMITS.totalBytes) problems.push(`一共 ${Math.round(total / 1024)} KB，最多 ${SKILL_LIMITS.totalBytes / 1024 / 1024} MB`);
  return problems;
}

// 隐藏字符：双向控制符、零宽字符、标签字符、补充变体选择符、除 \t \n \r 以外的控制字符。U+FEFF 只在文件开头允许（BOM）。
// 零宽连接符（U+200D）跟在 emoji 后面时是 emoji 序列的一部分（👩‍💻），不算。
const HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F؜᠎​‌‎‏‪-‮⁠-⁤⁦-⁩﻿\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]|(?<!\p{Extended_Pictographic}️?)‍/u;

function hiddenCharacters(path: string, text: string): string[] {
  const problems: string[] = [];
  const body = text.startsWith("﻿") ? ` ${text.slice(1)}` : text;
  const lines = body.split("\n");
  for (let index = 0; index < lines.length && problems.length < 3; index += 1) {
    const match = HIDDEN.exec(lines[index]!);
    if (!match) continue;
    const code = match[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
    problems.push(`${path} 第 ${index + 1} 行有隐藏字符 U+${code}`);
  }
  return problems;
}

// 文本里的链接：Markdown 的 [文字](目标)、<目标>、引用式 [x]: 目标。
const LINK_TARGETS = [/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/gu, /^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gmu, /<((?:file:|\/|~\/|\.\.\/)[^>\s]*)>/gu];

/** 一个链接的目标指向 skill 目录外面时，返回原因；在里面、是网址、是锚点时返回 null。 */
export function outOfBoundsLink(fromFile: string, target: string): string | null {
  const value = target.trim();
  if (!value || value.startsWith("#")) return null;
  if (/^(?:https?|mailto):/iu.test(value)) return null;
  if (/^file:/iu.test(value)) return "file: 链接";
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return null;
  if (value.startsWith("/")) return "绝对路径";
  if (value.startsWith("~")) return "用户目录下的路径";
  let decoded = value.split(/[?#]/u)[0]!;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // 解不开的照原样算。
  }
  const resolved = posix.normalize(posix.join(posix.dirname(fromFile), decoded));
  if (resolved === ".." || resolved.startsWith("../") || posix.isAbsolute(resolved)) return "走出 skill 目录的相对路径";
  return null;
}

function links(path: string, text: string): string[] {
  const problems: string[] = [];
  for (const pattern of LINK_TARGETS) {
    for (const match of text.matchAll(pattern)) {
      const why = outOfBoundsLink(path, match[1]!);
      if (why) problems.push(`${path} 里的链接 ${match[1]!.slice(0, 80)} 指向 skill 目录外面（${why}）`);
      if (problems.length >= 3) return problems;
    }
  }
  return problems;
}

export interface SkillContentReport {
  problems: string[];
  // 带的脚本（扩展名、可执行位或者 #! 开头），只列出来，不拒绝。
  scripts: string[];
  // 要告诉用户、但不拒绝的事。
  notes: string[];
  // SKILL.md 的 frontmatter 里的名字和说明。没有时为 null。
  name: string | null;
  description: string | null;
}

/** 从 SKILL.md 开头的 frontmatter 里读一个键（单行的值，去掉引号）。没有时为 null。 */
export function frontmatterValue(text: string, key: string): string | null {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?(?:\n|$)/u.exec(text);
  if (!match) return null;
  const line = new RegExp(`^${key}:[ \\t]*(.*)$`, "mu").exec(match[1]!);
  if (!line) return null;
  const value = line[1]!.trim().replace(/^(['"])(.*)\1$/u, "$2").trim();
  // 折叠写法（> 或 |）：值在下面几行。
  if (value === ">" || value === "|" || value === ">-" || value === "|-") {
    const after = match[1]!.slice(match[1]!.indexOf(line[0]) + line[0].length).split(/\r?\n/u).slice(1);
    const body = after.filter((entry, index) => /^\s+\S/u.test(entry) || (index === 0 && entry.trim() === "")).map((entry) => entry.trim());
    const joined = body.join(" ").trim();
    return joined || null;
  }
  return value || null;
}

/** 下载以后：按内容检查。files 是相对 skill 目录的路径和内容；executable 是 tree 里有可执行位的文件。 */
export function checkSkillContent(files: ReadonlyArray<{ path: string; content: Buffer; executable: boolean }>): SkillContentReport {
  const problems: string[] = [];
  const scripts: string[] = [];
  const notes: string[] = [];
  let name: string | null = null;
  let description: string | null = null;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const file of files) {
    if (IMAGE.test(file.path)) continue;
    let text: string;
    try {
      text = decoder.decode(file.content);
    } catch {
      problems.push(`${file.path} 不是文本，也不是常见的图片，没法审查`);
      continue;
    }
    problems.push(...hiddenCharacters(file.path, text), ...links(file.path, text));
    if (file.executable || SCRIPT.test(file.path) || text.startsWith("#!")) scripts.push(file.path);
    if (file.path === "SKILL.md") {
      name = frontmatterValue(text, "name");
      description = frontmatterValue(text, "description");
      const comments = text.match(/<!--[\s\S]*?-->/gu) ?? [];
      if (comments.length) notes.push(`SKILL.md 里有 ${comments.length} 段 HTML 注释（渲染时看不到，Lead 读得到）`);
    }
  }
  if (files.some((file) => file.path === "SKILL.md")) {
    if (!name) problems.push("SKILL.md 的 frontmatter 里没有 name");
    else if (!SKILL_NAME.test(name)) problems.push(`skill 的名字「${name.slice(0, 80)}」不合规：只能用小写字母、数字和连字符，最长 64`);
    if (!description) problems.push("SKILL.md 的 frontmatter 里没有 description");
  }
  return { problems, scripts: scripts.sort(), notes, name, description };
}
