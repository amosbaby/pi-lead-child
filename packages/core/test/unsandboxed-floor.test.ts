// 不进沙箱时的底线（工单 #62）：用户给工单打开「沙箱外执行」以后，执行者不进沙箱，但读私钥和 plc 的配置、密钥，
// 直接写 plc.db 和 config.json，各个 runtime 能挡的照样挡；挡不住的照实写在 UNSANDBOXED_FLOOR_GAPS 里。
import { describe, expect, it } from "vitest";
import {
  claudeSandboxSettings, claudeUnsandboxedSettings, sandboxPolicy, sandboxReadBlocker, UNSANDBOXED_FLOOR_GAPS,
} from "../src/sandbox-policy.js";

const home = "/Users/alice";
const dataDir = `${home}/.pi-lead-child`;
const policy = () => sandboxPolicy({ role: "executor", writable: ["/repo.plc-workspaces/item-1"], home, dataDir, env: {} });

describe("the floor without the sandbox", () => {
  it("turns Claude Code's sandbox off and denies its file tools the private keys and plc's secrets", () => {
    const settings = claudeUnsandboxedSettings(policy()) as { sandbox: { enabled: boolean }; permissions: { deny: string[] } };
    expect(settings.sandbox).toEqual({ enabled: false });
    const deny = settings.permissions.deny;
    // 读：私钥、钥匙串、plc 的配置和密钥。绝对路径写成 //开头。
    expect(deny).toEqual(expect.arrayContaining([
      `Read(/${home}/.ssh/id_*)`, `Read(/${home}/.gnupg)`, `Read(/${home}/.gnupg/**)`, `Read(/${home}/Library/Keychains/**)`,
      `Read(/${dataDir}/config.json)`, `Read(/${dataDir}/cli-credential.json)`, `Read(/${dataDir}/connections.key)`,
      `Read(/${dataDir}/agent/auth.json)`,
    ]));
    // 写：plc 的账本、配置和密钥，以及沙箱里也不能写的 shell 启动文件。
    expect(deny).toEqual(expect.arrayContaining([
      `Edit(/${dataDir}/plc.db)`, `Edit(/${dataDir}/plc.db-wal)`, `Edit(/${dataDir}/config.json)`, `Edit(/${dataDir}/backups/**)`,
      `Edit(/${home}/.zshrc)`, `Edit(/${home}/.ssh/id_*)`,
    ]));
    // 账本本身能读（Lead 排查问题要用），和沙箱里一样。
    expect(deny).not.toContain(`Read(/${dataDir}/plc.db)`);
  });

  it("keeps the sandboxed settings unchanged for a normal run", () => {
    const settings = claudeSandboxSettings(policy()) as { sandbox: { enabled: boolean; allowUnsandboxedCommands: boolean } };
    expect(settings.sandbox).toMatchObject({ enabled: true, allowUnsandboxedCommands: false });
  });

  it("blocks reading private keys and plc's secrets with a file tool, and lets other files through", () => {
    const current = policy();
    expect(sandboxReadBlocker(current, `${home}/.ssh/id_ed25519`)).toContain(".ssh/id_*");
    expect(sandboxReadBlocker(current, `${home}/.gnupg/private-keys-v1.d/x.key`)).toContain(".gnupg");
    expect(sandboxReadBlocker(current, `${dataDir}/config.json`)).toContain("config.json");
    expect(sandboxReadBlocker(current, `${dataDir}/plc.db`)).toBeNull();
    expect(sandboxReadBlocker(current, `${home}/.ssh/config`)).toBeNull();
    expect(sandboxReadBlocker(current, "/repo.plc-workspaces/item-1/src/index.ts")).toBeNull();
  });

  it("names what each runtime cannot block, instead of claiming it", () => {
    for (const runtime of ["claude", "codex", "pi"] as const) {
      expect(UNSANDBOXED_FLOOR_GAPS[runtime].length).toBeGreaterThan(0);
    }
    expect(UNSANDBOXED_FLOOR_GAPS.claude.join("")).toContain("Bash");
    expect(UNSANDBOXED_FLOOR_GAPS.codex.join("")).toContain("danger-full-access");
    expect(UNSANDBOXED_FLOOR_GAPS.pi.join("")).toContain("bash");
  });
});
