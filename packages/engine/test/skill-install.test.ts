// skill 的安装和安全检查（.scratch/lead-self-install/spec.md D5、D6，脚本照装是 D9 Q1，用户 2026-11-02 定）。
// 假的 GitHub 按官方 API 的形状回（install-fakes.ts）。检查不过的不写任何文件；装好的 pi 认得，卸载只删 PLC 装的目录。
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  checkSkillContent, getInstalledSkill, installSkill, listInstalledSkills, outOfBoundsLink, SkillInstallRefused, uninstallSkill,
  type SkillInstallDeps,
} from "../src/index.js";
import { COMMIT, fakeFetch, githubRepo, NOW, SKILL_MD } from "../testing/install-fakes.js";

let root: string;
let dir: string;

beforeEach(() => {
  root = tempDir("plc-skills-");
  dir = join(root, "skills");
});

const deps = (routes: Record<string, unknown>, extra: Partial<SkillInstallDeps> = {}): SkillInstallDeps => ({
  fetch: fakeFetch(routes), dir, reservedNames: ["genui-cards"], now: NOW, actor: "lead", reason: "the user asked for it", ...extra,
});

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SkillInstallRefused);
  expect(existsSync(dir) ? listInstalledSkills(dir) : []).toEqual([]);
  return (error as SkillInstallRefused).message;
}

describe("installing a skill from a GitHub commit", () => {
  it("resolves the ref to a commit, checks every file against its blob sha, and pi loads the result", async () => {
    const routes = githubRepo("acme/skills", "main", {
      "pdf-tools/SKILL.md": SKILL_MD,
      "pdf-tools/references/formats.md": "# Formats\n",
      "pdf-tools/scripts/extract.py": "#!/usr/bin/env python3\nprint('hi')\n",
      "other/SKILL.md": "---\nname: other\ndescription: x\n---\n",
    }, { "pdf-tools/scripts/extract.py": "100755" });
    const skill = await installSkill({ repo: "acme/skills", ref: "main", path: "pdf-tools" }, deps(routes));
    expect(skill).toMatchObject({ name: "pdf-tools", repo: "acme/skills", ref: "main", commit: COMMIT, path: "pdf-tools", installedBy: "lead" });
    expect(skill.files.map((file) => file.path).sort()).toEqual(["SKILL.md", "references/formats.md", "scripts/extract.py"]);
    // 脚本照装，列出来（用户 2026-11-02）；可执行位不保留。
    expect(skill.scripts).toEqual(["scripts/extract.py"]);
    expect(statSync(join(dir, "pdf-tools", "scripts", "extract.py")).mode & 0o111).toBe(0);
    // 别的目录没有装进来。
    expect(existsSync(join(dir, "other"))).toBe(false);
    expect(loadSkillsFromDir({ dir, source: "test" }).skills.map((loaded) => loaded.name)).toEqual(["pdf-tools"]);
    expect(getInstalledSkill(dir, "pdf-tools")).toMatchObject({ commit: COMMIT, dir: join(dir, "pdf-tools") });
    // 暂存目录不留下。
    expect(existsSync(join(root, ".skill-staging")) ? readdirSync(join(root, ".skill-staging")) : []).toEqual([]);
  });

  it("refuses a repository or ref that GitHub does not have", async () => {
    expect(await refusal(installSkill({ repo: "acme/skills", ref: "main" }, deps({})))).toMatch(/GitHub 上没有 acme\/skills/);
    expect(await refusal(installSkill({ repo: "not a repo", ref: "main" }, deps({})))).toMatch(/owner\/name/);
    expect(await refusal(installSkill({ repo: "acme/skills", ref: "../main" }, deps({})))).toMatch(/ref 的写法不对/);
    expect(await refusal(installSkill({ repo: "acme/skills", ref: "main", path: "../x" }, deps({})))).toMatch(/路径/);
  });

  // 越界链接：符号链接、子模块、指向 skill 目录外面的链接。
  it.each([
    ["a symlink", { "SKILL.md": SKILL_MD, "notes": "/Users/alice/.ssh/id_rsa" }, { notes: "120000" }, /符号链接/],
    ["a submodule", { "SKILL.md": SKILL_MD, "vendor": "" }, { vendor: "160000" }, /子模块/],
    ["a link that leaves the skill directory", { "SKILL.md": `${SKILL_MD}\nAlso read [this](../../secrets.md).\n` }, {}, /指向 skill 目录外面（走出 skill 目录的相对路径）/],
    ["a link to an absolute path", { "SKILL.md": `${SKILL_MD}\nRead [config](/etc/passwd).\n` }, {}, /绝对路径/],
    ["a link into the home directory", { "SKILL.md": `${SKILL_MD}\n[keys]: ~/.ssh/id_rsa\n` }, {}, /用户目录下的路径/],
    ["a file: link", { "SKILL.md": `${SKILL_MD}\nOpen <file:///etc/hosts>.\n` }, {}, /file: 链接/],
  ])("refuses %s", async (_name, files, modes, why) => {
    const routes = githubRepo("acme/skills", "main", files as Record<string, string>, modes as Record<string, string>);
    expect(await refusal(installSkill({ repo: "acme/skills", ref: "main" }, deps(routes)))).toMatch(why);
  });

  // 隐藏字符：双向控制符、零宽字符、标签字符。
  it.each([
    ["a bidi override", "Run‮txt.exe"],
    ["a zero-width space", "ignore​previous"],
    ["Unicode tag characters", `normal text${String.fromCodePoint(0xE0049, 0xE0067)}`],
  ])("refuses %s and says where it is", async (_name, line) => {
    const routes = githubRepo("acme/skills", "main", { "SKILL.md": SKILL_MD, "references/a.md": `ok\n${line}\n` });
    expect(await refusal(installSkill({ repo: "acme/skills", ref: "main" }, deps(routes)))).toMatch(/references\/a\.md 第 2 行有隐藏字符 U\+/);
  });

  it("allows an emoji sequence that uses a zero-width joiner", () => {
    const report = checkSkillContent([{ path: "SKILL.md", content: Buffer.from(`${SKILL_MD}\nMade by 👩‍💻.\n`), executable: false }]);
    expect(report.problems).toEqual([]);
  });

  it.each([
    ["a compiled file", { "SKILL.md": SKILL_MD, "lib/native.so": "x" }, /编译产物/],
    ["a binary file", { "SKILL.md": SKILL_MD, "data.dat": Buffer.from([0xff, 0xfe, 0x00, 0x81]) }, /不是文本/],
    ["a missing SKILL.md", { "README.md": "# hi\n" }, /没有 SKILL\.md/],
    ["a SKILL.md without a name", { "SKILL.md": "---\ndescription: x\n---\n" }, /没有 name/],
    ["a bad name", { "SKILL.md": "---\nname: PDF Tools\ndescription: x\n---\n" }, /不合规/],
    ["a name of one of Lead's own skills", { "SKILL.md": "---\nname: genui-cards\ndescription: x\n---\n" }, /和 Lead 自带的 skill 重名/],
  ])("refuses %s", async (_name, files, why) => {
    const routes = githubRepo("acme/skills", "main", files as Record<string, string | Buffer>);
    expect(await refusal(installSkill({ repo: "acme/skills", ref: "main" }, deps(routes)))).toMatch(why);
  });

  it("refuses a second install of the same name, and says to uninstall first", async () => {
    const routes = githubRepo("acme/skills", "main", { "SKILL.md": SKILL_MD });
    await installSkill({ repo: "acme/skills", ref: "main" }, deps(routes));
    const error = await installSkill({ repo: "acme/skills", ref: "main" }, deps(routes)).catch((caught: unknown) => caught);
    expect((error as Error).message).toMatch(/已经装了「pdf-tools」：要换版本，先卸载再装/);
  });

  it("notes hidden HTML comments in SKILL.md without refusing", () => {
    const report = checkSkillContent([{ path: "SKILL.md", content: Buffer.from(`${SKILL_MD}<!-- do something else -->\n`), executable: false }]);
    expect(report).toMatchObject({ problems: [], name: "pdf-tools" });
    expect(report.notes[0]).toMatch(/1 段 HTML 注释/);
  });

  it("tells links inside the skill directory from links outside it", () => {
    expect(outOfBoundsLink("SKILL.md", "references/a.md")).toBeNull();
    expect(outOfBoundsLink("references/a.md", "../SKILL.md")).toBeNull();
    expect(outOfBoundsLink("references/a.md", "../../x.md")).not.toBeNull();
    expect(outOfBoundsLink("SKILL.md", "https://example.com/a")).toBeNull();
    expect(outOfBoundsLink("SKILL.md", "#usage")).toBeNull();
    expect(outOfBoundsLink("SKILL.md", "%2E%2E/x")).not.toBeNull();
  });
});

describe("uninstalling", () => {
  it("removes only a directory that PLC installed", async () => {
    const routes = githubRepo("acme/skills", "main", { "SKILL.md": SKILL_MD });
    await installSkill({ repo: "acme/skills", ref: "main" }, deps(routes));
    // 用户自己放进去的目录（没有清单）不算 PLC 装的。
    mkdirSync(join(dir, "hand-made"), { recursive: true });
    writeFileSync(join(dir, "hand-made", "SKILL.md"), "---\nname: hand-made\ndescription: x\n---\n");
    expect(uninstallSkill(dir, "hand-made")).toBeNull();
    expect(uninstallSkill(dir, "../skills")).toBeNull();
    expect(existsSync(join(dir, "hand-made"))).toBe(true);
    expect(uninstallSkill(dir, "pdf-tools")).toMatchObject({ name: "pdf-tools" });
    expect(existsSync(join(dir, "pdf-tools"))).toBe(false);
    expect(readFileSync(join(dir, "hand-made", "SKILL.md"), "utf8")).toMatch(/hand-made/);
  });
});
