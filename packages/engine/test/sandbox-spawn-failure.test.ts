// 工单 #270：沙箱里起不了进程时，bash 报真实原因（EAGAIN、EMFILE、超时），不再报「Shell 'bash' not found in PATH」，
// 并记一条故障，get_runtime_health 读得到（health.ts）。
// sandbox-runtime 换成假的：wrapWithSandboxArgv 按测试的设定抛错，或者把命令交给 /bin/sh。spawnSync（探测用的
// /usr/bin/true）换成假的，按测试的设定返回起进程失败。spawn 是真的，正常情况下命令真的跑。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { sandboxPolicy } from "@pi-lead-child/core";
import { tempDir } from "@pi-lead-child/core/testing";

const fake = vi.hoisted(() => ({
  // 下一次 wrapWithSandboxArgv 要抛的错；null 时正常包装。
  wrapError: null as (Error & { code?: string }) | null,
  // 探测 /usr/bin/true 时 spawnSync 的 errno；null 时探测通过。
  probeErrno: null as string | null,
  shells: [] as Array<string | undefined>,
  probes: 0,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn((command: string, args: string[], options: object) => {
      if (command !== "/usr/bin/true") return actual.spawnSync(command, args, options as never);
      fake.probes += 1;
      if (!fake.probeErrno) return { status: 0, signal: null, pid: 1, output: [], stdout: null, stderr: null };
      const error = Object.assign(new Error(`spawnSync /usr/bin/true ${fake.probeErrno}`), { code: fake.probeErrno });
      return { status: null, signal: null, pid: 0, output: [], stdout: null, stderr: null, error };
    }),
  };
});

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    isSupportedPlatform: () => true,
    initialize: async () => undefined,
    reset: async () => undefined,
    wrapWithSandboxArgv: async (command: string, binShell?: string) => {
      fake.shells.push(binShell);
      if (fake.wrapError) throw fake.wrapError;
      return { argv: ["/bin/sh", "-c", command] };
    },
  },
}));

const { resetSandboxForTests, sandboxedBashOperations, SANDBOX_SHELL } = await import("../src/sandbox/bash.js");
const { resetSandboxHealthForTests, sandboxHealth } = await import("../src/sandbox/health.js");

const supported = process.platform === "darwin" || process.platform === "linux";

describe.runIf(supported)("sandboxed bash when the host cannot start processes", () => {
  const cwd = tempDir("plc-sbx-spawn-");
  const ops = sandboxedBashOperations(() => sandboxPolicy({ role: "lead", writable: [cwd], env: {}, home: cwd, dataDir: join(cwd, ".plc") }));

  async function run(command: string) {
    let output = "";
    const result = await ops.exec(command, cwd, { onData: (data) => { output += data.toString(); }, timeout: 30 });
    return { exitCode: result.exitCode, output: output.trim() };
  }

  beforeEach(async () => {
    fake.wrapError = null;
    fake.probeErrno = null;
    fake.shells = [];
    fake.probes = 0;
    resetSandboxHealthForTests();
    await resetSandboxForTests();
  });

  afterEach(() => resetSandboxHealthForTests());

  // 没打补丁的 sandbox-runtime：`which` 起不来时报「not found in PATH」。
  const notFound = () => new Error("Shell '/bin/bash' not found in PATH");

  it.each([
    ["EAGAIN", /EAGAIN/],
    ["EMFILE", /EMFILE/],
    ["ETIMEDOUT", /超时/],
  ])("reports %s instead of 'not found in PATH' and records a health fault", async (errno, reason) => {
    fake.wrapError = notFound();
    fake.probeErrno = errno;
    const error = await run("echo hi").then(() => null, (failure: Error) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toMatch(reason);
    expect(error!.message).toContain(errno);
    expect(error!.message).toMatch(/不是找不到 bash/);
    expect((error as NodeJS.ErrnoException).code).toBe(errno);
    expect(fake.probes).toBe(1);
    expect(sandboxHealth()).toMatchObject({
      status: "unavailable",
      fault: { code: "sandbox_spawn_failed", errno, failures: 1, recoveredAt: null, evidence: expect.stringContaining("not found in PATH") },
    });
  });

  // 打了补丁的 sandbox-runtime：`which` 超时时报「Could not look up shell」带 errno。探测此刻已经能起进程，用报错里的 errno。
  it("uses the errno that the patched lookup reports when the probe passes again", async () => {
    fake.wrapError = Object.assign(new Error("Could not look up shell 'bash': ETIMEDOUT (spawnSync which ETIMEDOUT)"), { code: "ETIMEDOUT" });
    const error = await run("echo hi").then(() => null, (failure: Error) => failure);
    expect(error!.message).toMatch(/超时/);
    expect(sandboxHealth()).toMatchObject({ status: "unavailable", fault: { errno: "ETIMEDOUT" } });
  });

  it("counts repeated failures in one fault and closes it when a command runs again", async () => {
    fake.wrapError = notFound();
    fake.probeErrno = "EAGAIN";
    await run("echo hi").catch(() => undefined);
    await run("echo hi").catch(() => undefined);
    expect(sandboxHealth().fault).toMatchObject({ errno: "EAGAIN", failures: 2, recoveredAt: null });

    fake.wrapError = null;
    fake.probeErrno = null;
    const result = await run("echo back");
    expect(result).toEqual({ exitCode: 0, output: "back" });
    expect(sandboxHealth()).toMatchObject({ status: "healthy", fault: { errno: "EAGAIN", failures: 2, recoveredAt: expect.any(String) } });
  });

  // 真的没找到 shell：探测能起进程，报错也没有起进程失败的 errno。原样报出，不记故障。
  it("keeps a real 'not found' error and records no fault", async () => {
    fake.wrapError = notFound();
    await expect(run("echo hi")).rejects.toThrow("Shell '/bin/bash' not found in PATH");
    expect(sandboxHealth()).toEqual({ status: "healthy", fault: null });
  });

  // 别的包装错误（例如写范围不对）不探测，也不记故障。
  it("does not probe for unrelated wrap errors", async () => {
    fake.wrapError = new Error("filesystem config is invalid");
    await expect(run("echo hi")).rejects.toThrow("filesystem config is invalid");
    expect(fake.probes).toBe(0);
    expect(sandboxHealth().fault).toBeNull();
  });

  it("runs commands as before when processes start, with /bin/bash as the shell", async () => {
    const result = await run("echo ok && exit 3");
    expect(result).toEqual({ exitCode: 3, output: "ok" });
    expect(fake.shells).toEqual([SANDBOX_SHELL]);
    expect(SANDBOX_SHELL).toBe("/bin/bash");
    expect(fake.probes).toBe(0);
    expect(sandboxHealth()).toEqual({ status: "healthy", fault: null });
  });
});

// 补丁（patches/@anthropic-ai+sandbox-runtime+0.0.81.patch，postinstall 用 patch-package 打上）。
// 没打上时这一组失败：npm install 没有跑 postinstall。
describe("patched sandbox-runtime which", () => {
  const require = createRequire(import.meta.url);
  const root = join(require.resolve("@anthropic-ai/sandbox-runtime/package.json"), "..");

  async function which() {
    return await import(join(root, "dist", "utils", "which.js")) as {
      whichSyncDetailed: (bin: string, spawn?: (...args: unknown[]) => unknown) => { path: string | null; failure: { errno: string } | null };
    };
  }

  it("returns an executable absolute path without starting `which`", async () => {
    const { whichSyncDetailed } = await which();
    const spawn = vi.fn();
    expect(whichSyncDetailed("/bin/sh", spawn)).toEqual({ path: "/bin/sh", failure: null });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["EAGAIN", "EMFILE", "ETIMEDOUT"])("tells %s apart from 'not found'", async (errno) => {
    const { whichSyncDetailed } = await which();
    const spawn = () => ({ status: null, signal: null, stdout: null, error: Object.assign(new Error(`spawnSync which ${errno}`), { code: errno }) });
    expect(whichSyncDetailed("bash", spawn)).toEqual({ path: null, failure: { errno, message: `spawnSync which ${errno}` } });
    const missing = () => ({ status: 1, signal: null, stdout: "" });
    expect(whichSyncDetailed("no-such-shell", missing)).toEqual({ path: null, failure: null });
  });

  it("makes the macOS wrapper report a failed lookup instead of 'not found in PATH'", () => {
    const source = readFileSync(join(root, "dist", "sandbox", "macos-sandbox-utils.js"), "utf8");
    expect(source).toContain("whichSyncDetailed(shellName)");
    expect(source).toContain("Could not look up shell");
  });
});
