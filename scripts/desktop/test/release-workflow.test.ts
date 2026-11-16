// 发版 workflow 的结构（设计文档 docs/desktop/macos-desktop-design.md 第 8.1 节、P0-5 的验收）：
// 只有一个 arm64 job；冒烟测试在上传之前，失败就不上传；能用 workflow_dispatch 重跑并覆盖附件；
// 不读 secret；第三方 action 固定到 commit SHA；只有这个 workflow 有 contents: write。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");
const SOURCE = readFileSync(join(WORKFLOWS, "release-macos.yml"), "utf8");

interface Step { name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown>; "working-directory"?: string; "continue-on-error"?: unknown }
interface Job { "runs-on": string; strategy?: unknown; permissions?: unknown; steps: Step[]; env: Record<string, string>; "continue-on-error"?: unknown; if?: string }
const workflow = parse(SOURCE) as { on: Record<string, any>; permissions: unknown; concurrency: Record<string, unknown>; jobs: Record<string, Job> };
const job = workflow.jobs.build!;
const stepIndex = (pattern: RegExp) => job.steps.findIndex((step) => pattern.test(step.run ?? ""));

describe("release-macos workflow", () => {
  it("runs when a release is published, and again by hand with a tag", () => {
    expect(workflow.on.release).toEqual({ types: ["published"] });
    expect(workflow.on.workflow_dispatch.inputs.tag).toMatchObject({ required: true, type: "string" });
    expect(Object.keys(workflow.on).sort()).toEqual(["release", "workflow_dispatch"]);
    expect(job.env.TAG).toBe("${{ github.event.release.tag_name || inputs.tag }}");
    expect(workflow.concurrency).toMatchObject({ "cancel-in-progress": false });
  });

  it("has one arm64 job on macos-15 and no build matrix", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["build"]);
    expect(job["runs-on"]).toBe("macos-15");
    expect(job.strategy).toBeUndefined();
    expect(SOURCE).not.toMatch(/matrix|x64|universal|macos-13|intel/i);
  });

  it("smoke-tests the runtime bundle before it builds or uploads anything, and stops on any failure", () => {
    const pack = stepIndex(/scripts\/desktop\/pack-runtime\.ts --arch arm64 /);
    const smoke = stepIndex(/scripts\/desktop\/smoke-runtime\.ts out\/runtime$/);
    const dmg = stepIndex(/npm run dist -- --mac dmg --arm64 --publish never/);
    const addDmg = stepIndex(/scripts\/desktop\/add-dmg\.ts --manifest out\/manifest\.json --dmg "out\/desktop\/bytezard-lead-\$\{VERSION\}-arm64\.dmg"$/);
    const upload = stepIndex(/^gh release upload /);
    expect(pack).toBeGreaterThan(-1);
    expect(smoke).toBeGreaterThan(pack);
    expect(dmg).toBeGreaterThan(smoke);
    // App 的一键更新按 manifest 里的 dmg 下载和校验：先记进 manifest，再上传。
    expect(addDmg).toBeGreaterThan(dmg);
    expect(upload).toBeGreaterThan(addDmg);
    expect(upload).toBe(job.steps.length - 1);
    // GitHub 缺省在一步失败后跳过后面的步骤。if: always()、continue-on-error 都会让失败的冒烟之后照样上传。
    for (const step of job.steps) {
      expect(step.if, step.name).toBeUndefined();
      expect(step["continue-on-error"], step.name).toBeUndefined();
    }
    expect(job["continue-on-error"]).toBeUndefined();
    expect(job.if).toBeUndefined();
  });

  it("uploads the dmg, the runtime archive, the source maps and manifest.json, replacing old copies", () => {
    const upload = job.steps.at(-1)!.run!;
    expect(upload).toContain('"out/desktop/bytezard-lead-${VERSION}-arm64.dmg"');
    expect(upload).toContain('"out/bytezard-lead-runtime-${VERSION}-arm64.tar.gz"');
    // 源码映射不进运行包，单独作为附件（设计第 7.5.7 节）。
    expect(upload).toContain('"out/bytezard-lead-sourcemaps-${VERSION}-arm64.tar.gz"');
    expect(upload).toContain("out/manifest.json");
    expect(upload).toContain("--clobber");
    expect(upload).toContain('--repo "$GITHUB_REPOSITORY"');
    expect(job.steps.at(-1)!.env).toEqual({ GH_TOKEN: "${{ github.token }}" });
  });

  it("gives the App and the runtime bundle the version of the tag", () => {
    const version = job.steps.find((step) => step.run?.startsWith("npm version "))!;
    expect(version.run).toBe('npm version "$VERSION" --no-git-tag-version --allow-same-version');
    expect(version["working-directory"]).toBe("desktop");
    expect(job.steps[stepIndex(/pack-runtime/)]!.run).toContain('--version "$VERSION" --repository "$GITHUB_REPOSITORY"');
    const setupNode = job.steps.find((step) => step.uses?.startsWith("actions/setup-node@"))!;
    expect(setupNode.with).toEqual({ "node-version-file": "desktop/node-version" });
    expect(job.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false");
  });

  // 关于窗口显示「版本 1.1.0 (202611050930)」：构建号是 UTC 的年月日时分，进 CFBundleVersion 和 App 的 buildInfo。
  it("gives the App a UTC build number and the commit", () => {
    expect(job.steps[0]!.run).toContain('echo "BUILD=$(date -u +%Y%m%d%H%M)" >> "$GITHUB_ENV"');
    const record = job.steps.find((step) => step.run?.startsWith("npm pkg set "))!;
    expect(record.run).toBe('npm pkg set "buildInfo.build=$BUILD" "buildInfo.commit=$GITHUB_SHA"');
    expect(record["working-directory"]).toBe("desktop");
    expect(job.steps.indexOf(record)).toBeLessThan(stepIndex(/npm run dist /));
    expect(job.steps[stepIndex(/npm run dist /)]!.run).toContain('"-c.buildVersion=$BUILD"');
  });

  it("reads no secret and pins every action to a commit SHA", () => {
    expect(SOURCE).not.toMatch(/secrets\./);
    const uses = job.steps.flatMap((step) => (step.uses ? [step.uses] : []));
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"))!;
    expect(checkout.with).toEqual({ ref: "refs/tags/${{ env.TAG }}", "persist-credentials": false });
  });

  it("never puts the tag or other event text into a shell script with ${{ }}", () => {
    for (const step of job.steps) expect(step.run ?? "", step.name).not.toContain("${{");
  });

  // The Android release workflow attaches the APK to the release, so it needs the same permission (19380a1).
  it("shares write permission only with the Android release workflow, and both ask only for contents: write", () => {
    expect(workflow.permissions).toEqual({ contents: "write" });
    expect(job.permissions).toBeUndefined();
    for (const file of readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name) && name !== "release-macos.yml")) {
      const other = parse(readFileSync(join(WORKFLOWS, file), "utf8")) as { permissions?: unknown; jobs?: Record<string, { permissions?: unknown }> };
      const jobGrants = Object.values(other.jobs ?? {}).map((entry) => entry.permissions);
      if (file === "release-android.yml") {
        expect(other.permissions, file).toEqual({ contents: "write" });
        for (const grant of jobGrants) expect(grant, file).toBeUndefined();
        continue;
      }
      for (const grant of [other.permissions, ...jobGrants]) {
        // 没写 permissions 时用仓库缺省（只读），写了就不能有 write。
        expect(grant, file).not.toBe("write-all");
        expect(JSON.stringify(grant ?? {}), file).not.toContain("write");
      }
    }
  });
});

describe("release-macos tag check", () => {
  const script = job.steps[0]!.run!;
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function check(tag: string): { ok: boolean; env: string } {
    const dir = mkdtempSync(join(tmpdir(), "release-tag-"));
    dirs.push(dir);
    const envFile = join(dir, "github-env");
    try {
      execFileSync("bash", ["-e", "-c", script], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TAG: tag, GITHUB_ENV: envFile }, stdio: "pipe" });
    } catch {
      return { ok: false, env: "" };
    }
    return { ok: true, env: readFileSync(envFile, "utf8") };
  }

  it("turns a version tag into VERSION without the leading v, and adds a UTC build number", () => {
    expect(check("v1.3.0")).toMatchObject({ ok: true, env: expect.stringMatching(/^VERSION=1\.3\.0\nBUILD=\d{12}\n$/) });
    expect(check("1.3.0-rc.1")).toMatchObject({ ok: true, env: expect.stringMatching(/^VERSION=1\.3\.0-rc\.1\nBUILD=\d{12}\n$/) });
  });

  it("stops on a tag that is not a version, before any other step runs", () => {
    for (const tag of ["", "latest", "v1.3", "v1.3.0;touch x", "v1.3.0\nVERSION=9.9.9", "../v1.3.0"]) {
      expect(check(tag).ok, JSON.stringify(tag)).toBe(false);
    }
    expect(job.steps[0]!.name).toBe("Check the tag");
  });
});
