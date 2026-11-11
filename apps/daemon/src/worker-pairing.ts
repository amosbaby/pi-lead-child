// plc worker pair：给外部工人（Claude Code、Codex）签一张只带 worker 权限的凭证（spec P1-5）。
// token 由这里写进数据目录里的 worker-tokens/<名字>.token（目录 0700，文件 0600），不经过 plc 的输出，也不进日志和 plc.sock 的回答：
// 工人用环境变量引用它（PLC_WORKER_TOKEN=$(cat <文件>)），MCP 配置里不写明文。
// worker-tokens 在执行器沙箱的禁读和禁写清单里（core 的 sandbox-policy.ts），Lead 的凭证防护也按 .token 拦住它：
// child 读到它就能冒充工人领单。
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORKER_TOKEN_DIR, WORKER_TOKEN_EXTENSION, type WorkerPairResponse } from "@pi-lead-child/protocol";
import { createWorkerBinding, revokeBinding, type Db } from "@pi-lead-child/store";

export function workerTokenPath(dataDir: string, name: string): string {
  return join(dataDir, WORKER_TOKEN_DIR, `${name}${WORKER_TOKEN_EXTENSION}`);
}

// 先写临时文件再改名：写到一半中断时，不会留下一个读不全的 token 文件。
function writeTokenFile(path: string, dir: string, token: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * 签凭证、写文件。同名的工人在撤销前不再签（WorkerNameTakenError，原来的 token 文件不动）。
 * 文件写不进去时撤销刚签的凭证：不留一张没有人拿得到 token 的活凭证。name 要先过 protocol 的 WORKER_NAME_PATTERN。
 */
export function pairWorker(db: Db, dataDir: string, name: string): WorkerPairResponse {
  const { binding, accessToken } = createWorkerBinding(db, { name });
  const path = workerTokenPath(dataDir, name);
  try {
    writeTokenFile(path, join(dataDir, WORKER_TOKEN_DIR), accessToken);
  } catch (error) {
    revokeBinding(db, binding.id);
    throw error;
  }
  return { bindingId: binding.id, name, path };
}
