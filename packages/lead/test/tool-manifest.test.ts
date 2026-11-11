// 工具清单（tool-manifest.ts，.scratch/tool-occupancy/spec.md L2）：Lead 和子 agent 会话里能注册的每个工具都要声明
// 改不改东西、要跑多久。中止兜底（tool-abort-guard.ts）按声明决定中止时停下还是转后台。没声明的按 write + long 处理，
// 这里让它在 CI 里先失败，提醒加工具的人想清楚。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb } from "@pi-lead-child/store";
import { createChannelCardTools } from "../src/channel-tools.js";
import { createConnectionTools } from "../src/connection-tools.js";
import { LEAD_ALL_BUILTIN_TOOLS, leadSolPiSettings } from "../src/session.js";
import { createLeadToolset, type LeadDeps } from "../src/tools.js";
import { LEAD_TOOL_MANIFEST, toolDeclaration, toolDuration, toolEffect, UNDECLARED_TOOL } from "../src/tool-manifest.js";

let deps: LeadDeps;
beforeEach(() => {
  const dir = tempDir("plc-tool-manifest-");
  deps = { db: openDb(join(dir, "plc.db")), dbPath: join(dir, "plc.db"), dataDir: dir };
});

// 源码里 defineTool({ name: "…" }) 的全部名字：按条件注册的工具（交接、子 agent 的工具、通道）也算进来。
function definedToolNames(): string[] {
  const root = join(import.meta.dirname, "../src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts")) files.push(path);
    }
  };
  walk(root);
  const names = new Set<string>();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/defineTool\(\{\s*name:\s*"([a-z_]+)"/gu)) names.add(match[1]!);
  }
  return [...names];
}

describe("the tool manifest", () => {
  it("declares every tool Lead and its sub-agent sessions can register", () => {
    const names = new Set([
      ...createLeadToolset(deps).map((tool) => tool.name),
      ...createChannelCardTools({
        read: () => null, dispatch: async () => ({}), findConversations: async () => [], readConversation: async () => ({}),
        recentConversations: () => [],
      } as never).map((tool) => tool.name),
      ...createConnectionTools({} as never).map((tool) => tool.name),
      ...LEAD_ALL_BUILTIN_TOOLS,
      ...leadSolPiSettings({}).tools,
      ...definedToolNames(),
    ]);
    expect(names.size).toBeGreaterThan(100);
    expect([...names].filter((name) => !toolDeclaration(name))).toEqual([]);
  });

  it("declares no tool that no longer exists", () => {
    const names = new Set([...definedToolNames(), ...LEAD_ALL_BUILTIN_TOOLS, ...leadSolPiSettings({}).tools, "obs_recall", "update_plan"]);
    expect([...LEAD_TOOL_MANIFEST.keys()].filter((name) => !names.has(name))).toEqual([]);
  });

  // long 的工具可能跑很久：它要接收中止信号，用户 /stop 时停得下来（2026-11-10 的 run_on_host 不接收）。名单变了这条失败：
  // 新的 long 工具要先有一条测它停得下来的测试，再加进名单。现有的：bash 和 codemode 是 pi 的（收到 signal 停下），
  // run_on_host 在 apps/daemon/test/host-bypass-daemon.test.ts「stops the process group when the user stops the step」，
  // call_connection_tool 把 signal 交给连接的 MCP 客户端。
  it("lists the long tools, each with a test that it stops on the abort signal", () => {
    expect([...LEAD_TOOL_MANIFEST].filter(([, declaration]) => declaration.duration === "long").map(([name]) => name).sort())
      .toEqual(["bash", "call_connection_tool", "codemode", "run_on_host"]);
  });

  it("reads bash's read_only flag, and treats a tool nobody declared as a long write", () => {
    expect(toolEffect("bash", { command: "grep -r x .", read_only: true })).toBe("read");
    expect(toolEffect("bash", { command: "git push" })).toBe("write");
    expect(toolDuration("bash")).toBe("long");
    expect(toolEffect("run_on_host", {})).toBe("write");
    expect(toolDuration("codemode")).toBe("long");
    expect(toolEffect("get_ticket", {})).toBe("read");
    expect(toolDuration("get_ticket")).toBe("instant");
    expect(toolEffect("a_tool_added_later", {})).toBe(UNDECLARED_TOOL.effect);
    expect(toolDuration("a_tool_added_later")).toBe("long");
  });
});
