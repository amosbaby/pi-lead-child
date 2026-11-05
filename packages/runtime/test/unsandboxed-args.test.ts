// 「沙箱外执行」授权（工单 #62）在三种 runtime 上生成的参数：授权打开时执行者不进沙箱（claude 的 sandbox.enabled=false，
// codex 的 danger-full-access，pi 不给 bash 套沙箱），核查员总在沙箱里；授权关着时一切照旧。只核对参数，不起进程。
import { describe, expect, it } from "vitest";
import { PLC_UNSANDBOXED_ENV } from "@pi-lead-child/core";
import { ClaudeRuntime } from "../src/claude.js";
import { codexExecArgs } from "../src/codex.js";
import { piSandboxEnv } from "../src/pi.js";
import type { RuntimeStartRequest } from "../src/types.js";

function request(overrides: Partial<RuntimeStartRequest> = {}): RuntimeStartRequest {
  return {
    itemId: 1, runId: 2, role: "executor", purpose: "execution", prompt: "do it",
    workdir: "/repo.plc-workspaces/item-1", env: {}, ...overrides,
  };
}

function claudeSettings(overrides: Partial<RuntimeStartRequest>): { sandbox: Record<string, unknown>; permissions?: { deny: string[] } } {
  const runtime = new ClaudeRuntime({ bin: "claude", childSkillsRoot: null });
  const args = (runtime as unknown as { buildArgs(r: RuntimeStartRequest, mcp: string | null): string[] }).buildArgs(request(overrides), null);
  return JSON.parse(args[args.indexOf("--settings") + 1]!);
}

const sandboxFlag = (args: string[]) => args[args.indexOf("--sandbox") + 1];

describe("claude", () => {
  it("turns the sandbox off for the executor when the ticket allows it, and keeps the floor as deny rules", () => {
    const settings = claudeSettings({ unsandboxed: true });
    expect(settings.sandbox).toEqual({ enabled: false });
    expect(settings.permissions!.deny.some((rule) => rule.startsWith("Read(") && rule.includes("/.ssh/id_*"))).toBe(true);
    expect(settings.permissions!.deny.some((rule) => rule.startsWith("Edit(") && rule.endsWith("/plc.db)"))).toBe(true);
    expect(settings.permissions!.deny.some((rule) => rule.startsWith("Edit(") && rule.endsWith("/config.json)"))).toBe(true);
  });

  it("keeps the sandbox for the executor without the permission", () => {
    expect(claudeSettings({}).sandbox).toMatchObject({ enabled: true, allowUnsandboxedCommands: false });
  });

  it("keeps the reviewer in the sandbox even when the request says unsandboxed", () => {
    expect(claudeSettings({ role: "reviewer", purpose: "review", unsandboxed: true }).sandbox)
      .toMatchObject({ enabled: true, allowUnsandboxedCommands: false });
  });
});

describe("codex", () => {
  it("uses danger-full-access for the executor only when the ticket allows it", () => {
    expect(sandboxFlag(codexExecArgs(request({ unsandboxed: true }), []))).toBe("danger-full-access");
    expect(sandboxFlag(codexExecArgs(request(), []))).toBe("workspace-write");
  });

  it("keeps the reviewer read-only", () => {
    expect(sandboxFlag(codexExecArgs(request({ role: "reviewer", purpose: "review", unsandboxed: true }), []))).toBe("read-only");
  });
});

describe("pi", () => {
  it("tells the sandbox extension to leave the executor's bash unsandboxed only when the ticket allows it", () => {
    expect(piSandboxEnv({ role: "executor", unsandboxed: true })).toEqual({ PLC_SANDBOX_ROLE: "executor", [PLC_UNSANDBOXED_ENV]: "1" });
    expect(piSandboxEnv({ role: "executor" })).toEqual({ PLC_SANDBOX_ROLE: "executor" });
  });

  it("keeps the reviewer in the sandbox", () => {
    expect(piSandboxEnv({ role: "reviewer", unsandboxed: true })).toEqual({ PLC_SANDBOX_ROLE: "reviewer" });
  });
});
