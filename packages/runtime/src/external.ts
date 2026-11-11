// 外部工人的 runtime（.scratch/external-worker-hub/spec.md P1-1、P1-2）。执行模式是 external 时，工单不由 daemon 起执行者，
// 交给外部工人（Claude Code，以后 Codex）领走：领取就是建一个 runtime 为 external 的 Run。daemon 不为它起任何进程。
// 它不是执行器：不在 registry 的 allRuntimeAdapters() 里，所以选 runtime、fallback、核查员、设置页、探测、预检、
// 模型发现和健康账本都碰不到它（registry.ts）。findRuntimeAdapter 认得它：旧 Run 的展示和失败分类要用。
// probe、preflight、discoverModels 都没有：它什么都不执行（ruling R1）。
import type { AgentRuntime, RuntimeAdapter, RuntimeCapabilities, RuntimeExit, RuntimeHandle } from "./types.js";
import { matchProviderFailure, residualFailureCode, typedFailure } from "./typed-failure.js";
import { runtimeEnvironment } from "./environment.js";
import type { RuntimeProfile } from "./profile.js";

// 和 protocol 的 EXTERNAL_RUNTIME_ID 是同一个值（runtime 包不依赖 protocol）。
export const EXTERNAL_RUNTIME_ID = "external" as const;

const CAPABILITIES: RuntimeCapabilities = {
  streaming: false, steering: false, resume: false, interrupt: false, approvals: false, mcp: false,
  executableReadOnlyReview: false,
};

// 万一内核把一个 external 的 Run 交给了 runItem：不起进程，马上结束，并写明原因，不假装做完了。
const NO_PROCESS_EXIT: RuntimeExit = {
  ok: false, exitCode: null, signal: null, externalSessionId: null,
  errorCode: "external_runtime_no_process",
  errorMessage: "this run is worked by an external worker; the daemon starts no process for it",
};

function externalProfile(): RuntimeProfile {
  return {
    runtime: EXTERNAL_RUNTIME_ID, executable: EXTERNAL_RUNTIME_ID, configDir: null, interpreter: null, extensions: [],
    models: { defaultModel: null, providers: [] }, environment: runtimeEnvironment({}), allowedTools: [],
  };
}

class ExternalRuntime implements AgentRuntime {
  readonly id = EXTERNAL_RUNTIME_ID;
  readonly capabilities = CAPABILITIES;
  readonly profile = externalProfile();

  async start(): Promise<RuntimeHandle> {
    return {
      pid: null,
      events: (async function* () { /* 没有进程，也就没有事件 */ })(),
      interrupt: async () => {},
      wait: async () => NO_PROCESS_EXIT,
    };
  }
}

export const externalAdapter: RuntimeAdapter = {
  id: EXTERNAL_RUNTIME_ID,
  displayName: "External worker",
  capabilities: CAPABILITIES,
  models: {
    defaultModel: () => undefined,
    // 模型由外部工人自己定，daemon 不解析。
    resolve: (model) => model,
  },
  reportsCost: false,
  classifyFailure: (evidence) => typedFailure(matchProviderFailure(evidence.message) ?? residualFailureCode(evidence), evidence),
  locateExecutable: () => null,
  create: () => new ExternalRuntime(),
};
