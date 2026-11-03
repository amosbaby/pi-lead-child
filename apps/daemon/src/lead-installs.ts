// Lead 自己装 MCP 和 skill（2026-11-02，.scratch/lead-self-install/spec.md）：daemon 交给操作层的服务。
// 连接中心（ConnectionHub）的错误在这里换成操作层的错误，engine 不 import packages/connections。
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ConnectionError, findLocalExecutable, type ConnectionErrorCode, type ConnectionHub } from "@pi-lead-child/connections";
import { UiActionError, type ConnectionInstallService, type InstallServices } from "@pi-lead-child/engine";
import { LEAD_SKILLS_DIR } from "@pi-lead-child/lead";

const ERROR_CODES: Partial<Record<ConnectionErrorCode, ConstructorParameters<typeof UiActionError>[0]>> = {
  not_found: "not_found",
  invalid_request: "invalid_input",
  forbidden: "forbidden",
};

function uiError(error: unknown): unknown {
  if (!(error instanceof ConnectionError)) return error;
  return new UiActionError(ERROR_CODES[error.code] ?? "unavailable", error.message);
}

async function mapped<T>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw uiError(error);
  }
}

export function connectionInstallService(hub: ConnectionHub): ConnectionInstallService {
  return {
    get: (key) => {
      try {
        return hub.get(key);
      } catch (error) {
        if (error instanceof ConnectionError && (error.code === "not_found" || error.code === "not_connected")) return null;
        throw error;
      }
    },
    requestRemote: (url, meta) => mapped(() => hub.requestCustom(url, meta)),
    start: (key) => mapped(() => hub.start(key)),
    disconnect: (key) => mapped(() => hub.disconnect(key)),
    addLocal: (launch, meta) => mapped(() => hub.addLocal(launch, meta)),
  };
}

/** PLC 自己的 skill 目录：<数据目录>/skills（缺省 ~/.pi-lead-child/skills）。 */
export function installedSkillsDir(dataDir: string): string {
  return join(dataDir, "skills");
}

// Lead 自带的 skill 的名字（LEAD_SKILLS_DIR 下的目录）：装的 skill 不能和它们重名。
function leadOwnSkillNames(): string[] {
  try {
    return readdirSync(LEAD_SKILLS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function leadInstallServices(options: { hub: ConnectionHub; dataDir: string; fetch?: InstallServices["fetch"] }): InstallServices {
  return {
    connections: connectionInstallService(options.hub),
    skillsDir: installedSkillsDir(options.dataDir),
    reservedSkillNames: leadOwnSkillNames,
    hasExecutable: (name) => findLocalExecutable(name) !== null,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };
}
