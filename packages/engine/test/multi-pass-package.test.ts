// pi-multi-pass 由 pi 的包管理器安装（模型配置方案 C 的 D1，src/extension/multi-pass-package.ts），和 SoL-Pi 一样固定在完整的 commit 上。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MULTI_PASS_SOURCE, multiPassActive, multiPassPackage, multiPassPinnedCommit, multiPassSource,
} from "../src/extension/multi-pass-package.js";

const PINNED = multiPassPinnedCommit(MULTI_PASS_SOURCE);
const PKG = "/agent/git/github.com/hjanuschka/pi-multi-pass";

// 和 pi 的 DefaultPackageManager 同样的三个方法：没装时 getInstalledPath 给 undefined，入口按包的 manifest（pi.extensions）解析。
function fakeManager(installed: boolean, install: () => Promise<void> = async () => {}) {
  const calls: string[] = [];
  let dir = installed ? PKG : undefined;
  return {
    calls,
    manager: {
      getInstalledPath: (source: string) => { calls.push(`path ${source}`); return dir; },
      install: async (source: string) => { calls.push(`install ${source}`); await install(); dir = PKG; },
      resolveExtensionSources: async (sources: string[]) => {
        calls.push(`resolve ${sources.join(",")}`);
        return {
          extensions: [{ path: join(dir!, "extensions", "multi-sub.ts"), enabled: true, metadata: { source: sources[0]!, scope: "user" as const, origin: "package" as const } }],
          skills: [], prompts: [], themes: [],
        };
      },
    },
  };
}

describe("pi-multi-pass package managed by pi's package manager", () => {
  it("is pinned to the reviewed full commit and refuses a moving override", () => {
    expect(MULTI_PASS_SOURCE).toBe("git:github.com/hjanuschka/pi-multi-pass@66f06a2bb7192cef5e9fb97fb3189faedff4de36");
    expect(multiPassSource({})).toBe(MULTI_PASS_SOURCE);
    expect(() => multiPassSource({ PLC_MULTI_PASS_SOURCE: "git:github.com/hjanuschka/pi-multi-pass@main" })).toThrow(/40-hex/);
    expect(() => multiPassSource({ PLC_MULTI_PASS_SOURCE: "npm:pi-multi-pass" })).toThrow();
  });

  it("activates an installed copy at the pinned commit without the network", async () => {
    const env: Record<string, string | undefined> = {};
    const { manager, calls } = fakeManager(true);
    const lines: string[] = [];
    const multiPass = multiPassPackage({ agentDir: "/agent", cwd: "/cwd", env, packageManager: manager, headOf: () => PINNED, log: (l) => lines.push(l) });
    expect(await multiPass.activate()).toBe(true);
    expect(env.PLC_MULTI_PASS_ENTRY).toBe(join(PKG, "extensions", "multi-sub.ts"));
    expect(multiPassActive(env)).toBe(true);
    expect(calls.some((call) => call.startsWith("install"))).toBe(false);
    expect(lines).toEqual([`[multi-pass] active at ${PINNED.slice(0, 7)}`]);
    // 已经加载的不算新装好：daemon 不用重新加载 Lead 的扩展。
    expect(await multiPass.sync()).toBe(false);
  });

  it("does not load a checkout away from the pinned commit, and installs then loads it in sync", async () => {
    const env: Record<string, string | undefined> = {};
    let head = "0".repeat(40);
    const { manager } = fakeManager(true, async () => { head = PINNED; });
    const multiPass = multiPassPackage({ agentDir: "/agent", cwd: "/cwd", env, packageManager: manager, headOf: () => head, log: () => {} });
    expect(await multiPass.activate()).toBe(false);
    expect(env.PLC_MULTI_PASS_ENTRY).toBeUndefined();
    expect(await multiPass.sync()).toBe(true);
    expect(env.PLC_MULTI_PASS_ENTRY).toBe(join(PKG, "extensions", "multi-sub.ts"));
  });

  it("installs on the first sync and keeps the daemon up when the network is down", async () => {
    const env: Record<string, string | undefined> = {};
    const lines: string[] = [];
    const offline = fakeManager(false, async () => { throw new Error("could not resolve host github.com"); });
    const failing = multiPassPackage({ agentDir: "/agent", cwd: "/cwd", env, packageManager: offline.manager, headOf: () => PINNED, log: (l) => lines.push(l) });
    expect(await failing.activate()).toBe(false);
    expect(await failing.sync()).toBe(false);
    expect(lines.at(-1)).toMatch(/could not install .*extra subscription accounts are off/);

    const online = fakeManager(false);
    const working = multiPassPackage({ agentDir: "/agent", cwd: "/cwd", env, packageManager: online.manager, headOf: () => PINNED, log: () => {} });
    expect(await working.sync()).toBe(true);
    expect(online.calls).toContain(`install ${MULTI_PASS_SOURCE}`);
  });

  it("does nothing when it is switched off or the entry is set by hand", async () => {
    const { manager, calls } = fakeManager(true);
    const off = multiPassPackage({ agentDir: "/agent", cwd: "/cwd", env: { PLC_MULTI_PASS: "off" }, packageManager: manager, headOf: () => PINNED });
    expect(await off.activate()).toBe(false);
    expect(await off.sync()).toBe(false);
    const preset = multiPassPackage({
      agentDir: "/agent", cwd: "/cwd", env: { PLC_MULTI_PASS_ENTRY: "/checkout/extensions/multi-sub.ts" }, packageManager: manager, headOf: () => PINNED,
    });
    expect(await preset.activate()).toBe(true);
    expect(await preset.sync()).toBe(false);
    expect(calls).toEqual([]);
  });
});
