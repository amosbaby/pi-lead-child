// 用户停用的 runtime 不进 registry 的列表：选 runtime、探测、发现模型都从这些列表走，停用的就不会被碰到。
// 查已有数据（旧 Run 的 runtime、展示名）仍然认得它：allRuntimeAdapters 和 findRuntimeAdapter 不过滤。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allRuntimeAdapters, createDefaultRuntimeRegistry, RuntimeRegistry, disabledRuntimes, findRuntimeAdapter, isRuntimeId, runtimeAdapter, runtimeAdapters, runtimeIds,
} from "../src/registry.js";

afterEach(() => vi.unstubAllEnvs());

describe("a disabled runtime in the registry lists", () => {
  it("does not list a disabled runtime", () => {
    expect(runtimeIds({ PLC_DISABLED_RUNTIMES: "claude" })).not.toContain("claude");
    expect(runtimeAdapters({ PLC_DISABLED_RUNTIMES: "claude" }).map((adapter) => adapter.id)).toEqual(["codex", "pi"]);
  });

  it("lists every runtime when none is disabled, in the same order as before", () => {
    expect(runtimeIds({})).toEqual(["codex", "claude", "pi"]);
    expect(runtimeAdapters({}).map((adapter) => adapter.id)).toEqual(["codex", "claude", "pi"]);
  });

  it("reads the process environment when no env is given", () => {
    vi.stubEnv("PLC_DISABLED_RUNTIMES", "claude,codex");
    expect(runtimeIds()).toEqual(["pi"]);
  });

  it("still knows a disabled runtime by id, so stored runs and settings keep working", () => {
    const env = { PLC_DISABLED_RUNTIMES: "claude" };
    expect(allRuntimeAdapters().map((adapter) => adapter.id)).toContain("claude");
    expect(findRuntimeAdapter("claude")?.displayName).toBeTruthy();
    expect(runtimeAdapter("claude").id).toBe("claude");
    expect(isRuntimeId("claude")).toBe(true);
    expect(disabledRuntimes(env)).toEqual(["claude"]);
  });
});

describe("the live runtime registry", () => {
  it("does not hand out a disabled runtime, and hands it out again once it is enabled, without a rebuild", () => {
    const registry = createDefaultRuntimeRegistry();
    vi.stubEnv("PLC_DISABLED_RUNTIMES", "claude");
    expect(registry.list().map((runtime) => runtime.id)).toEqual(["codex", "pi"]);
    expect(registry.find("claude")).toBeUndefined();
    expect(() => registry.get("claude")).toThrow(/Claude Code/);
    expect(registry.get("codex").id).toBe("codex");

    vi.stubEnv("PLC_DISABLED_RUNTIMES", "");
    expect(registry.list().map((runtime) => runtime.id)).toEqual(["codex", "claude", "pi"]);
    expect(registry.get("claude").id).toBe("claude");
  });

  it("applies to any runtime put in it, and still says an unknown id is not configured", () => {
    const registry = new RuntimeRegistry([createDefaultRuntimeRegistry().get("pi")]);
    vi.stubEnv("PLC_DISABLED_RUNTIMES", "pi");
    expect(registry.list()).toEqual([]);
    expect(() => registry.get("pi")).toThrow(/Pi|pi/);
    vi.stubEnv("PLC_DISABLED_RUNTIMES", "");
    expect(() => registry.get("claude")).toThrow(/not configured/);
  });
});
