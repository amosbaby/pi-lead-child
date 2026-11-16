// 运行时按路径加载的文件（工单 #260）：桌面版 1.1.1、1.1.2 的运行包里没有 packages/，pi 执行器按源码路径找扩展，
// 报 "Pi extension path does not exist"。运行包里要改用 dist/assets/ 下的副本，源码 checkout 里照旧用源码。
import { describe, expect, it } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../testing/index.js";
import {
  distDir, isReleaseRuntime, packageSource, projectRoot, RUNTIME_ASSETS, runtimeAsset, runtimeAssetPaths, type RuntimeAssetName,
} from "../src/config.js";

const names = Object.keys(RUNTIME_ASSETS) as RuntimeAssetName[];

describe("runtime assets", () => {
  it("covers the pi extensions, the child skills, the Lead skills and the Hindsight download script", () => {
    expect(names.sort()).toEqual([
      "child-skills", "hindsight-download", "lead-skills", "multi-pass-lead", "sandbox", "sol-pi-executor", "sol-pi-lead", "ticket-tools",
      "web-tools",
    ]);
  });

  it("uses the source in a checkout, which has no release.json", () => {
    expect(isReleaseRuntime()).toBe(false);
    expect(runtimeAsset("ticket-tools")).toBe(packageSource("engine", "extension", "ticket-tools.ts"));
    expect(runtimeAsset("child-skills")).toBe(packageSource("engine", "child-skills"));
    expect(runtimeAsset("lead-skills")).toBe(packageSource("lead", "skills"));
    for (const { path } of runtimeAssetPaths()) expect(existsSync(path), path).toBe(true);
  });

  it("uses the copies under dist/assets/ in a runtime bundle, never a source path", () => {
    for (const { name, path } of runtimeAssetPaths(true)) {
      expect(path).toBe(join(distDir(), ...RUNTIME_ASSETS[name].dist));
      expect(path.startsWith(join(distDir(), "assets") + "/"), path).toBe(true);
    }
    expect(runtimeAsset("sandbox", true)).toBe(join(distDir(), "assets", "extensions", "sandbox.js"));
  });

  it("detects a runtime bundle by the release.json in its root", () => {
    const root = tempDir("plc-runtime-assets-");
    expect(isReleaseRuntime(root)).toBe(false);
    writeFileSync(join(root, "release.json"), "{}");
    expect(isReleaseRuntime(root)).toBe(true);
    expect(isReleaseRuntime(projectRoot())).toBe(false);
  });
});
