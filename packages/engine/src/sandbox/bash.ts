// 在沙箱里跑 bash（lead-tools-and-routing spec D2）。pi 的 bash 工具换成这里的执行函数：命令经
// @anthropic-ai/sandbox-runtime 包一层（macOS 是 sandbox-exec，Linux 是 bubblewrap，网络走它在本进程里起的代理），
// 写的范围、不能读的路径、先放行的域名和打码的密钥都按 core 的 sandboxPolicy。Lead（daemon 进程里）和 pi 子进程
// （engine 的 extension/sandbox.ts）都用它。
// 网络全开（2026-10-28 用户）：不在先放行清单里的域名，ask 回调一律放行。仍然走沙箱的代理：打码的密钥要在代理里
// 换成真值（sandbox-runtime 的 credentials.envVars），回环和云的元数据地址照旧被代理拦下。
//
// 沙箱起不来时不退回到没有沙箱的 bash：命令直接失败，结果写明原因（spec D11：这是能力缺口，Lead 换一条路）。
// 2026-10-28 在本机核实：按调用传入的 filesystem 覆盖初始化时的写范围；代理的设置写在包装后的命令里，
// 所以环境变量可以自己过滤；子进程必须异步起（同步起会卡住同一个进程里的代理）。
//
// 起不了进程时（工单 #270）：sandbox-runtime 0.0.81 找 shell 时起 `which`，起不来（EAGAIN、EMFILE）或者超时都报成
// 「Shell 'bash' not found in PATH」。现在 shell 显式传 /bin/bash；仓库的 patches/ 让它遇到能执行的绝对路径时不起
// `which`，`which` 起不来时报真实的 errno。这里再兜一层：报错像是找不到 shell、或者带着起进程失败的 errno 时，
// 起一次 /usr/bin/true 探真实原因，写进报错，并记一条故障（health.ts），get_runtime_health 读得到。
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { sandboxEnv, sandboxRuntimeConfig, type SandboxPolicy } from "@pi-lead-child/core";
import { isSpawnFailureErrno, markSandboxSpawnHealthy, recordSandboxSpawnFailure } from "./health.js";

type SandboxManagerModule = typeof import("@anthropic-ai/sandbox-runtime");

let manager: SandboxManagerModule["SandboxManager"] | null = null;
// 一个进程只初始化一次（SandboxManager 是单例，网络代理也只起一次）。结果是 null（可以用）或者不能用的原因。
let ready: Promise<string | null> | null = null;

// 不在先放行清单里的域名：放行（见文件头）。
const allowEveryHost = async (): Promise<boolean> => true;

/** 初始化沙箱。网络、打码的密钥在这里定，每次调用的写范围另传。返回 null 表示可以用，否则是不能用的原因。 */
export function initSandbox(policy: SandboxPolicy): Promise<string | null> {
  if (ready) return ready;
  ready = (async () => {
    try {
      const module = await import("@anthropic-ai/sandbox-runtime") as SandboxManagerModule;
      const candidate = module.SandboxManager;
      if (!candidate.isSupportedPlatform()) return `这个系统（${process.platform}）不支持沙箱`;
      await candidate.initialize(sandboxRuntimeConfig(policy) as Parameters<typeof candidate.initialize>[0], allowEveryHost);
      manager = candidate;
      return null;
    } catch (error) {
      return `沙箱起不来：${error instanceof Error ? error.message : String(error)}`;
    }
  })();
  return ready;
}

/** 测试用：关掉沙箱（代理、临时 CA），下一条命令按新的 policy 重新初始化。 */
export async function resetSandboxForTests(): Promise<void> {
  const current = manager;
  ready = null;
  manager = null;
  await current?.reset();
}

// 沙箱里跑命令用的 shell。绝对路径：不靠 PATH，也不用起 `which` 去找。
export const SANDBOX_SHELL = "/bin/bash";

function errnoOf(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : null;
}

/** 起一次 /usr/bin/true，看这台机器此刻能不能起进程。能起时返回 null，否则返回 errno（超时是 ETIMEDOUT）。 */
export function probeSpawn(): string | null {
  const result = spawnSync("/usr/bin/true", [], { stdio: "ignore", timeout: 1_000 });
  if (result.error) return errnoOf(result.error) ?? "UNKNOWN";
  return null;
}

// sandbox-runtime 找 shell 失败的报错：没打补丁时是「not found in PATH」，打了补丁、`which` 起不来时是「Could not look up shell」。
const SHELL_LOOKUP_FAILURE = /not found in PATH|Could not look up shell/;

/**
 * 包装命令或者起进程失败时，判断是不是这台机器起不了进程。是的话记一条故障，返回写明真实原因的报错；
 * 不是的话返回 null，调用方照原样抛出原来的报错。
 */
export function explainSpawnFailure(error: unknown, probe: () => string | null = probeSpawn): Error | null {
  const message = error instanceof Error ? error.message : String(error);
  const reported = errnoOf(error);
  const looksLikeLookup = SHELL_LOOKUP_FAILURE.test(message);
  if (!looksLikeLookup && !isSpawnFailureErrno(reported)) return null;
  // 先看此刻的探测：它最能说明机器的状态。探测能起进程时，再看报错自己带的 errno（例如 `which` 超时）。
  const probed = probe();
  const errno = isSpawnFailureErrno(probed) ? probed : isSpawnFailureErrno(reported) ? reported : probed;
  if (!errno) return null;
  const fault = recordSandboxSpawnFailure({ errno, evidence: message });
  return Object.assign(new Error(
    `沙箱起不来：${fault.reason}。命令没有运行。原始报错：${message}。`
    + "这是机器的问题，不是命令的问题，也不是找不到 bash。过一会儿再试；一直这样时告诉用户："
    + "检查进程数和打开的文件数（ulimit -u、ulimit -n）或者重启 daemon。",
  ), { code: errno });
}

function kill(pid: number | undefined, child: { kill: (signal: NodeJS.Signals) => boolean }): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * pi bash 工具的执行函数：每条命令按 policy() 当时给出的范围包进沙箱。policy 每次调用重新取：Lead 能写的 worktree
 * 会变。沙箱不能用时命令失败，错误里写明原因。
 */
// policy 可以是异步的：要用的 git 目录和根证书先在子进程里查好（core 的 sandboxPolicyAsync）。
export function sandboxedBashOperations(policy: () => SandboxPolicy | Promise<SandboxPolicy>): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) throw new Error(`工作目录不存在：${cwd}`);
      const current = await policy();
      const problem = await initSandbox(current);
      if (problem || !manager) {
        throw new Error(`${problem ?? "沙箱不能用"}。命令没有运行（没有沙箱时不跑命令）。换一条路：派子 agent，或者告诉用户。`);
      }
      const config = sandboxRuntimeConfig(current);
      let wrapped: Awaited<ReturnType<NonNullable<typeof manager>["wrapWithSandboxArgv"]>>;
      try {
        wrapped = await manager.wrapWithSandboxArgv(
          command, SANDBOX_SHELL, { filesystem: config.filesystem } as never, signal, cwd,
        );
      } catch (error) {
        throw explainSpawnFailure(error) ?? error;
      }
      return await new Promise((resolve, reject) => {
        const child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
          cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: sandboxEnv({ ...process.env, ...env }),
        });
        let timedOut = false;
        const timer = timeout && timeout > 0
          ? setTimeout(() => {
            timedOut = true;
            kill(child.pid, child);
          }, timeout * 1000)
          : undefined;
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        const onAbort = () => kill(child.pid, child);
        signal?.addEventListener("abort", onAbort, { once: true });
        child.on("spawn", () => markSandboxSpawnHealthy());
        child.on("error", (error) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(explainSpawnFailure(error) ?? error);
        });
        child.on("close", (code, killedBy) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${timeout}`));
          else resolve({ exitCode: code ?? (killedBy ? 128 : null) });
        });
      });
    },
  };
}
