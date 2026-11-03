// 本地 MCP 的审查（.scratch/lead-self-install/spec.md D4，门槛 D9 Q2，用户 2026-11-02 定）：查官方仓库，可疑的拒绝并写明原因，
// 通过时版本固定成确切的一个。假的 npm、PyPI 按官方 API 的形状回（install-fakes.ts）。
import { describe, expect, it } from "vitest";
import {
  LOCAL_MCP_REVIEW_RULES, LocalMcpReviewRefused, LocalMcpReviewUnavailable, reviewLocalMcp, type LocalMcpReviewDeps,
} from "../src/index.js";
import { fakeFetch, NOW, npmPackage, pypiPackage } from "../testing/install-fakes.js";

const deps = (routes: Record<string, unknown>, extra: Partial<LocalMcpReviewDeps> = {}): LocalMcpReviewDeps => ({
  fetch: fakeFetch(routes), now: NOW, hasExecutable: () => true, ...extra,
});

async function refusal(promise: Promise<unknown>): Promise<string[]> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(LocalMcpReviewRefused);
  return [...(error as LocalMcpReviewRefused).problems];
}

describe("npm", () => {
  it("passes a normal package and pins the newest release that is at least 7 days old", async () => {
    const routes = npmPackage("@acme/fake-mcp", {
      versions: { "1.2.2": { publishedDaysAgo: 40 }, "1.2.3": { publishedDaysAgo: 20 }, "1.3.0": { publishedDaysAgo: 2 }, "2.0.0-beta.1": { publishedDaysAgo: 10 } },
    });
    const review = await reviewLocalMcp({ registry: "npm", package: "@acme/fake-mcp", args: ["--read-only"] }, deps(routes));
    expect(review.launch).toEqual({ registry: "npm", package: "@acme/fake-mcp", version: "1.2.3", bin: "fake-mcp", args: ["--read-only"] });
    expect(review.facts).toMatchObject({ weeklyDownloads: 25_000, maintainers: ["alice"], repository: "https://github.com/acme/fake-mcp" });
  });

  it("refuses a package that does not exist, and tells Lead not to make up names", async () => {
    const problems = await refusal(reviewLocalMcp({ registry: "npm", package: "@acme/made-up-mcp" }, deps({})));
    expect(problems[0]).toMatch(/没有「@acme\/made-up-mcp」这个包.*不要自己编包名/);
  });

  it("refuses a version range, a dist-tag and a version that does not exist", async () => {
    const routes = npmPackage();
    for (const version of ["^1.2.3", "latest", "1.2"]) {
      expect((await refusal(reviewLocalMcp({ registry: "npm", package: "@acme/fake-mcp", version }, deps(routes))))[0]).toMatch(/确切的一个/);
    }
    expect((await refusal(reviewLocalMcp({ registry: "npm", package: "@acme/fake-mcp", version: "9.9.9" }, deps(routes))))[0]).toMatch(/没有 9\.9\.9/);
  });

  // 每一条门槛单独拒绝，并写明是哪一条。
  it.each([
    ["a version newer than 7 days", npmPackage("@acme/fake-mcp", { versions: { "1.2.3": { publishedDaysAgo: 3 } } }), "1.2.3", /发布不满 7 天/],
    ["a package newer than 30 days", npmPackage("@acme/fake-mcp", { createdDaysAgo: 12 }), "1.2.3", /第一次发布不满 30 天/],
    ["few downloads", npmPackage("@acme/fake-mcp", { downloads: 40 }), "1.2.3", /上周下载量 40，少于 1000/],
    ["no source repository", npmPackage("@acme/fake-mcp", { repository: null }), "1.2.3", /没有源码仓库的链接/],
    ["an install script", npmPackage("@acme/fake-mcp", { versions: { "1.2.3": { publishedDaysAgo: 20, meta: { scripts: { postinstall: "node steal.js" } } } } }), "1.2.3", /会跑脚本（postinstall）/],
    ["a deprecated version", npmPackage("@acme/fake-mcp", { versions: { "1.2.3": { publishedDaysAgo: 20, meta: { deprecated: "use v2" } } } }), "1.2.3", /已经弃用/],
    ["no executable", npmPackage("@acme/fake-mcp", { versions: { "1.2.3": { publishedDaysAgo: 20, meta: { bin: undefined } } } }), "1.2.3", /没有可执行的命令/],
  ])("refuses %s", async (_name, routes, version, why) => {
    const problems = await refusal(reviewLocalMcp({ registry: "npm", package: "@acme/fake-mcp", version }, deps(routes)));
    expect(problems.join("；")).toMatch(why);
  });

  it("uses the rules the user chose", () => {
    expect(LOCAL_MCP_REVIEW_RULES).toEqual({ minVersionAgeDays: 7, minPackageAgeDays: 30, minWeeklyDownloads: 1_000 });
  });

  it("makes Lead pick a command when the package has several, and refuses one it does not have", async () => {
    const routes = npmPackage("@acme/fake-mcp", { versions: { "1.2.3": { publishedDaysAgo: 20, meta: { bin: { "acme-a": "a.js", "acme-b": "b.js" } } } } });
    expect((await refusal(reviewLocalMcp({ registry: "npm", package: "@acme/fake-mcp" }, deps(routes))))[0]).toMatch(/有几个命令：acme-a、acme-b/);
    expect((await refusal(reviewLocalMcp({ registry: "npm", package: "@acme/fake-mcp", bin: "acme-c" }, deps(routes))))[0]).toMatch(/没有「acme-c」/);
    const picked = await reviewLocalMcp({ registry: "npm", package: "@acme/fake-mcp", bin: "acme-b" }, deps(routes));
    expect(picked.launch.bin).toBe("acme-b");
  });

  it("refuses arguments with newlines or something that looks like a key, before asking the registry", async () => {
    const fetch = fakeFetch(npmPackage());
    await refusal(reviewLocalMcp({ registry: "npm", package: "@acme/fake-mcp", args: ["a\nb"] }, { fetch, now: NOW }));
    const problems = await refusal(reviewLocalMcp({ registry: "npm", package: "@acme/fake-mcp", args: [`--token=ghp_${"x".repeat(36)}`] }, { fetch, now: NOW }));
    expect(problems[0]).toMatch(/像密钥/);
    expect(fetch.calls).toEqual([]);
  });

  it("does not pass a package when the registry cannot be reached", async () => {
    const fetch = async () => { throw new Error("getaddrinfo ENOTFOUND"); };
    await expect(reviewLocalMcp({ registry: "npm", package: "@acme/fake-mcp" }, { fetch, now: NOW })).rejects.toBeInstanceOf(LocalMcpReviewUnavailable);
  });
});

describe("PyPI", () => {
  it("passes a normal package with a wheel and pins the newest release that is at least 7 days old", async () => {
    const review = await reviewLocalMcp({ registry: "pypi", package: "fake-mcp-server" }, deps(pypiPackage()));
    expect(review.launch).toEqual({ registry: "pypi", package: "fake-mcp-server", version: "1.0.0", bin: "fake-mcp-server", args: [] });
    expect(review.facts).toMatchObject({ weeklyDownloads: 4_000, repository: "https://github.com/acme/fake-mcp-server", maintainers: ["Nina"] });
    expect(review.facts.notes[0]).toMatch(/读不到包里的命令名/);
  });

  it.each([
    ["a version with only a source package", pypiPackage("fake-mcp-server", { releases: { "1.0.0": [{ packagetype: "sdist", daysAgo: 60 }] } }), /没有 wheel/],
    ["a yanked version", pypiPackage("fake-mcp-server", { releases: { "1.0.0": [{ packagetype: "bdist_wheel", daysAgo: 60, yanked: true }] } }), /撤回/],
    ["few downloads", pypiPackage("fake-mcp-server", { downloads: 12 }), /上周下载量 12/],
    ["no source repository", pypiPackage("fake-mcp-server", { projectUrls: { Documentation: "https://docs.example.com" } }), /没有源码仓库的链接/],
    ["a package newer than 30 days", pypiPackage("fake-mcp-server", { releases: { "1.0.0": [{ packagetype: "bdist_wheel", daysAgo: 10 }] } }), /第一次发布不满 30 天/],
  ])("refuses %s", async (_name, routes, why) => {
    const problems = await refusal(reviewLocalMcp({ registry: "pypi", package: "fake-mcp-server", version: "1.0.0" }, deps(routes)));
    expect(problems.join("；")).toMatch(why);
  });

  it("refuses when this computer has no uvx", async () => {
    const problems = await refusal(reviewLocalMcp({ registry: "pypi", package: "fake-mcp-server" }, deps(pypiPackage(), { hasExecutable: (name) => name !== "uvx" })));
    expect(problems.join("；")).toMatch(/找不到 uvx/);
  });
});
