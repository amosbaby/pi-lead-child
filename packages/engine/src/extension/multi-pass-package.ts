// pi-multi-pass 的安装和更新（模型配置方案 C 的 S2，.scratch/model-config-c/spec.md D1），和 SoL-Pi 一样交给 pi 自己的
// 包管理器（sol-pi-package.ts）：装进 Lead 的 pi agentDir，固定在 MULTI_PASS_SOURCE 的 commit 上，不写进 settings.json。
// 装好以后设置 PLC_MULTI_PASS_ENTRY，Lead 的会话经 multi-pass-lead.ts 加载它。只在 daemon 进程里用；执行器不加载它。
//
// pi-multi-pass 管一种订阅的多个账号：第 n 个账号注册成 provider <base>-<n>，配置在 pi 的 agentDir 的 multi-pass.json，
// 凭据在 auth.json。它有 npm 依赖（proper-lockfile、qrcode-terminal）：pi 的包管理器在 checkout 里跑 npm install，
// 和 SoL-Pi 的安全评审 L1 一样，所以来源只能是固定到完整 commit 的 git 仓库。
import { execFileSync } from "node:child_process";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

// 升级：换成上游新的 commit，跑 multi-pass 的测试，重启 daemon。pi 的包管理器会把已有的 checkout 对齐到新的 ref。
export const MULTI_PASS_SOURCE = "git:github.com/hjanuschka/pi-multi-pass@66f06a2bb7192cef5e9fb97fb3189faedff4de36";
export const MULTI_PASS_ENTRY_ENV = "PLC_MULTI_PASS_ENTRY";
// off：不安装、不加载（只剩每种订阅的第一个账号）。
export const MULTI_PASS_SWITCH_ENV = "PLC_MULTI_PASS";

const SOURCE = /^git:([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)@([0-9a-f]{40})$/;

// PLC_MULTI_PASS_SOURCE 覆盖固定的来源（同样必须固定到完整 commit）。
export function multiPassSource(env: Record<string, string | undefined> = process.env): string {
  const override = env.PLC_MULTI_PASS_SOURCE?.trim();
  if (!override) return MULTI_PASS_SOURCE;
  if (!SOURCE.test(override) || override.split(/[/@]/).includes("..")) {
    throw new Error(`PLC_MULTI_PASS_SOURCE=${override}: expected git:<host>/<owner>/<repo>@<40-hex commit>`);
  }
  return override;
}

export function multiPassPinnedCommit(source: string): string {
  const commit = SOURCE.exec(source)?.[2];
  if (!commit) throw new Error(`${source} is not pinned to a full commit`);
  return commit;
}

function gitHead(dir: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export interface MultiPassPackageOptions {
  // pi-lead-child 的 pi agentDir（Lead 的隔离 agentDir）。包装在它的 git/ 下。
  agentDir: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  // 测试注入。缺省用 pi 的 DefaultPackageManager。
  packageManager?: Pick<DefaultPackageManager, "install" | "getInstalledPath" | "resolveExtensionSources">;
  // 测试注入。缺省用 git rev-parse HEAD。
  headOf?: (dir: string) => string | null;
}

export interface MultiPassPackage {
  // 不联网：已经装好、停在固定的 commit 上时设置 PLC_MULTI_PASS_ENTRY，返回 true。daemon 在建 Lead 会话之前调它。
  activate(): Promise<boolean>;
  // 后台任务：没装时安装，装好后设置入口；已经装好时让 pi 对齐到固定的 ref。失败只记一行日志。
  // 这一次才加载上时返回 true：daemon 据此重新加载 Lead 的扩展。
  sync(): Promise<boolean>;
}

// daemon 启动时：先 activate()，再起 daemon，最后在后台 sync()。PLC_MULTI_PASS_ENTRY 已经设置（例如指向本地 checkout）时，
// 两步都不安装、不改它。
export function multiPassPackage(opts: MultiPassPackageOptions): MultiPassPackage {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.error(line));
  const preset = Boolean(env[MULTI_PASS_ENTRY_ENV]?.trim());
  const off = env[MULTI_PASS_SWITCH_ENV]?.trim().toLowerCase() === "off";
  let source: string | null = null;
  try {
    if (!off) source = multiPassSource(env);
  } catch (error) {
    if (!preset) log(`[multi-pass] ${error instanceof Error ? error.message : String(error)}; pi-multi-pass is off`);
  }
  let manager: MultiPassPackageOptions["packageManager"] | null = null;
  const packageManager = () => (manager ??= opts.packageManager ?? new DefaultPackageManager({
    cwd: opts.cwd, agentDir: opts.agentDir, settingsManager: SettingsManager.create(opts.cwd, opts.agentDir),
  }));
  // 和 SoL-Pi 一样（安全评审 M1）：checkout 不在固定的 commit 上时不加载，等 sync() 对齐。
  const activate = async (): Promise<boolean> => {
    if (preset) return true;
    if (!source) return false;
    const manager = packageManager();
    const dir = manager.getInstalledPath(source, "user");
    if (!dir) return false;
    const pinned = multiPassPinnedCommit(source);
    const head = (opts.headOf ?? gitHead)(dir);
    if (head !== pinned) {
      log(`[multi-pass] ${dir} is at ${head ?? "an unknown commit"}, not the pinned ${pinned}; not loading it until sync aligns it`);
      return false;
    }
    try {
      const { extensions } = await manager.resolveExtensionSources([source]);
      const entry = extensions.find((extension) => extension.enabled)?.path;
      if (!entry) throw new Error(`${source} declares no extension`);
      env[MULTI_PASS_ENTRY_ENV] = entry;
      log(`[multi-pass] active at ${pinned.slice(0, 7)}`);
      return true;
    } catch (error) {
      log(`[multi-pass] ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  return {
    activate,
    async sync() {
      if (preset || !source) return false;
      const installed = Boolean(env[MULTI_PASS_ENTRY_ENV]);
      try {
        await packageManager().install(source);
        if (!installed && await activate()) {
          log(`[multi-pass] installed ${source}`);
          return true;
        }
      } catch (error) {
        log(`[multi-pass] could not ${installed ? "update" : "install"} ${source}: `
          + `${error instanceof Error ? error.message : String(error)}`
          + `${installed ? "; keeping the installed copy" : "; extra subscription accounts are off"}`);
      }
      return false;
    },
  };
}

/** pi-multi-pass 装好了、Lead 的会话会加载它（PLC_MULTI_PASS_ENTRY 设置了）。 */
export function multiPassActive(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env[MULTI_PASS_ENTRY_ENV]?.trim());
}
