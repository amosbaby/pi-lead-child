// 沙箱 bash 起不了进程的故障记录（工单 #270）。
// 2026-11-06 一台机器的 daemon 每条 bash 都报「Shell 'bash' not found in PATH」：sandbox-runtime 找 shell 时起 `which`，
// 起不来（EAGAIN、EMFILE）或者超时都当成「没找到」。get_runtime_health 还显示一切正常，Lead 看不出是机器的问题。
// 这里记下真实原因。字段照健康账本的故障（store 的 runtime-health.ts）：code、证据、开启时间、失败次数。
// 记录只在本进程的内存里：起不了进程是机器此刻的状态，daemon 重启后要重新看。
// Lead 的 bash 跑在 daemon 进程里，get_runtime_health 读的就是这一份；执行者（pi 子进程）的故障只写进它自己的报错。

/** 起进程失败的 errno 和写给 Lead 的原因。 */
export const SPAWN_FAILURE_REASONS: Readonly<Record<string, string>> = {
  EAGAIN: "系统起不了新进程（EAGAIN：进程数到了上限，或者资源暂时不够）",
  EMFILE: "daemon 打开的文件太多（EMFILE：文件描述符用完了）",
  ENFILE: "整个系统打开的文件太多（ENFILE）",
  ENOMEM: "内存不够，起不了新进程（ENOMEM）",
  ETIMEDOUT: "起进程超时（ETIMEDOUT：1 秒内没有返回，机器负载可能太高）",
};

export function isSpawnFailureErrno(errno: unknown): errno is string {
  return typeof errno === "string" && Object.hasOwn(SPAWN_FAILURE_REASONS, errno);
}

export interface SandboxFault {
  code: "sandbox_spawn_failed";
  errno: string;
  reason: string;
  // 原始报错的第一行，最长 300 个字符。
  evidence: string;
  openedAt: string;
  lastSeenAt: string;
  failures: number;
  // 之后有一条命令起来了：这次故障结束的时间。还没结束时为 null。
  recoveredAt: string | null;
}

export interface SandboxHealth {
  status: "healthy" | "unavailable";
  // 最近一次故障。恢复以后还留着（recoveredAt 不为空），Lead 能看到之前出过什么事。
  fault: SandboxFault | null;
}

let fault: SandboxFault | null = null;

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

/** 记一次起不了进程的失败。故障还没结束时并进去，计数加一。 */
export function recordSandboxSpawnFailure(args: { errno: string; evidence: string; at?: Date }): SandboxFault {
  const at = (args.at ?? new Date()).toISOString();
  const reason = SPAWN_FAILURE_REASONS[args.errno] ?? `起不了新进程（${args.errno}）`;
  if (fault && fault.recoveredAt === null) {
    fault = { ...fault, errno: args.errno, reason, evidence: firstLine(args.evidence), lastSeenAt: at, failures: fault.failures + 1 };
  } else {
    fault = {
      code: "sandbox_spawn_failed", errno: args.errno, reason, evidence: firstLine(args.evidence),
      openedAt: at, lastSeenAt: at, failures: 1, recoveredAt: null,
    };
  }
  return fault;
}

/** 一条命令起来了：没结束的故障记为结束。 */
export function markSandboxSpawnHealthy(at: Date = new Date()): void {
  if (fault && fault.recoveredAt === null) fault = { ...fault, recoveredAt: at.toISOString() };
}

export function sandboxHealth(): SandboxHealth {
  return { status: fault && fault.recoveredAt === null ? "unavailable" : "healthy", fault };
}

/** 测试用：清掉故障记录。 */
export function resetSandboxHealthForTests(): void {
  fault = null;
}
