// 用户停用 Claude Code 以后，daemon 整个周期里都不执行 claude：不跑 --version、--help、auth status。
// 以前停用只挡派发，预检、模型发现和 plc recheck 照旧起 claude 的进程。
// 做法：PLC_CLAUDE_BIN 指向一个会把每次调用记进日志的假二进制，跑一个完整的 daemon 周期，日志必须是空的。
// 控制组：同一个假二进制不停用时，预检会把调用记进日志。没有它，这条测试的空日志说明不了什么。
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectRoot } from "@pi-lead-child/core";
import { tempDir } from "@pi-lead-child/core/testing";
import { createRuntimePreflight, refreshModelCatalog, setModelCatalogForTesting } from "@pi-lead-child/engine";
import { createDefaultRuntimeRegistry, defaultRuntimeProfile } from "@pi-lead-child/runtime";
import { typedFailure } from "@pi-lead-child/runtime";
import { createItem, createRun, openDb, recordRuntimeHealthFailure, updateRun, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { plcAdminClient } from "./plc-client.js";

let dir: string;
let dbPath: string;
let db: Db;
let callLog: string;

beforeEach(() => {
  dir = tempDir("plc-no-claude-exec-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  callLog = join(dir, "claude-calls.log");
  const fakeClaude = join(dir, "claude");
  writeFileSync(fakeClaude, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${callLog}'\nexit 0\n`);
  chmodSync(fakeClaude, 0o755);
  vi.stubEnv("PLC_DATA_DIR", dir);
  vi.stubEnv("PLC_CLAUDE_BIN", fakeClaude);
  // 另外两个 runtime 指向不存在的文件：它们的探测失败得很快，也不会去起本机装的 CLI。
  vi.stubEnv("PLC_CODEX_BIN", join(dir, "no-codex"));
  vi.stubEnv("PLC_PI_BIN", join(dir, "no-pi"));
  vi.stubEnv("PLC_RUNTIME_RECOVERY_MS", "50");
  vi.stubEnv("PLC_ORCHESTRATOR_MS", "50");
  setModelCatalogForTesting(null);
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  setModelCatalogForTesting(null);
});

const claudeCalls = (): string[] => existsSync(callLog)
  ? readFileSync(callLog, "utf8").split("\n").filter(Boolean)
  : [];

const sessionFactory = async () => ({
  modelName: "stub/model",
  session: {
    sessionId: "stub-session",
    subscribe() { return () => {}; },
    async prompt() {},
    async steer() {},
    async followUp() {},
    dispose() {},
  },
});

// 一次开着的 claude 故障，和一个排队等它的请求：recheck 和自动探针都会碰它。
function openClaudeIncident(): number {
  const itemId = createItem(db, { title: "claude ticket", brief: "b", createdBy: "user" });
  const runId = createRun(db, { itemId, runtime: "claude", model: "claude-sonnet" });
  updateRun(db, runId, { state: "failed", endedAt: true, errorCode: "replayed", errorMessage: "auth_required" });
  const opened = recordRuntimeHealthFailure(db, {
    profile: defaultRuntimeProfile("claude"), model: "claude-sonnet",
    failure: typedFailure("auth_required", { errorCode: "replayed", message: "auth_required" }), itemId, runId,
  });
  db.prepare("UPDATE runtime_incidents SET next_probe_at=?").run(new Date(Date.now() - 1_000).toISOString());
  return opened!.incident.id;
}

describe("a disabled Claude Code", () => {
  it("is never executed in a full daemon cycle: preflight, model discovery, recheck and scheduling", async () => {
    vi.stubEnv("PLC_DISABLED_RUNTIMES", "claude");
    openClaudeIncident();
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: sessionFactory as never, modelDiscovery: true, log: () => {},
    });
    try {
      const admin = await plcAdminClient(daemon);
      // 自动探针和预检各跑了好几轮（50 毫秒一轮），再手动重检一次。
      await new Promise((resolve) => setTimeout(resolve, 600));
      const results = await admin.recheckRuntimes("claude");
      await refreshModelCatalog({ db, cwd: projectRoot() });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(claudeCalls()).toEqual([]);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ runtime: "claude", outcome: "disabled" });
    } finally {
      await daemon.close();
    }
  }, 30_000);

  it("is executed when it is not disabled (control: the log catches a call)", async () => {
    const preflight = createRuntimePreflight(db, { runtime: (id) => createDefaultRuntimeRegistry().get(id) });
    await preflight.refresh();
    preflight.stop();
    expect(claudeCalls()).toContainEqual("--version");
  }, 30_000);
});
