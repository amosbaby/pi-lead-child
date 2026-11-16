// Lead 的两个通用操作工具（AGENTS.md「UI Actions」，plan.md P01）：list_actions、perform_action 和页面调同一个操作层；
// 只有用户本人能做的操作（user_direct）总是返回结构化的拒绝，拒绝里写明用户去哪里点。
import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLoopbackBinding, createTurn, getBinding, openDb, type Db } from "@pi-lead-child/store";
import { UI_ACTIONS } from "@pi-lead-child/engine";
import { UI_ACTION_TARGET_TYPES } from "@pi-lead-child/protocol";
import { createLeadTools } from "../src/tools.js";
import { createUiActionTools } from "../src/ui-action-tools.js";
import { LEAD_SYSTEM_PROMPT } from "../src/prompt.js";

let db: Db;

beforeEach(() => {
  const dir = tempDir("plc-ui-action-tools-");
  db = openDb(join(dir, "plc.db"));
});

const tools = (turnId: string | null = null) => createUiActionTools({ db, currentTurnId: () => turnId }) as any[];
const tool = (name: string, turnId: string | null = null) => tools(turnId).find((candidate) => candidate.name === name);

describe("list_actions and perform_action", () => {
  it("are Lead's tools, with the description generated from the definitions", () => {
    const dir = tempDir("plc-ui-action-tools-");
    const names = createLeadTools({ db, dbPath: join(dir, "plc.db"), dataDir: dir }).map((candidate: any) => candidate.name);
    expect(names).toEqual(expect.arrayContaining(["list_actions", "perform_action"]));
    expect(names).not.toContain("set_runtime_enabled");
    expect(LEAD_SYSTEM_PROMPT).toContain("perform_action(target_type='runtime', action='disable')");
  });

  // 2026-11-16 精简 Lead 的模型输入：整个操作目录（约 1.8 万 token）每一步都随 perform_action 的说明发给模型。
  // 现在说明里只有一份索引（每种目标、它的编号写法、全部操作名），细节用 list_actions 按目标种类查。
  it("lists every target type and every action in a short index, without the full catalog", () => {
    const description: string = tool("perform_action").description;
    expect(description.length).toBeLessThan(6_000);
    expect(description).not.toContain("revoke（作废设备凭证）：只有用户本人能做");
    for (const type of UI_ACTION_TARGET_TYPES) {
      const line = description.split("\n").find((candidate) => candidate.startsWith(`- ${type}（`));
      expect(line, type).toBeDefined();
      for (const id of Object.keys(UI_ACTIONS[type])) expect(line, `${type}.${id}`).toMatch(new RegExp(`[：、]${id}(、|$)`));
    }
    expect(description).toContain("list_actions");
  });

  it("gives the full catalog of a target type, with each action's input, when list_actions has no target_id", async () => {
    const listed = (await tool("list_actions").execute("t", { target_type: "device" })).content[0].text as string;
    expect(listed).toContain("revoke（作废设备凭证）：只有用户本人能做");
    for (const type of UI_ACTION_TARGET_TYPES) {
      const section = (await tool("list_actions").execute("t", { target_type: type })).content[0].text as string;
      for (const id of Object.keys(UI_ACTIONS[type])) expect(section, `${type}.${id}`).toMatch(new RegExp(`- ${id}（[^\n]*input：`));
    }
  });

  it("returns a structured refusal for a user_direct action, even in the user's own turn", async () => {
    const { binding } = createLoopbackBinding(db, { name: "iPhone" });
    createTurn(db, { id: "turn-user", originBindingId: binding.id, originKind: "paired:companion", userText: "把 iPhone 踢掉", state: "streaming" });
    const result = await tool("perform_action", "turn-user").execute("t", {
      target_type: "device", target_id: String(binding.id), action: "revoke", reason: "用户说把 iPhone 踢掉",
    });
    expect(JSON.parse(result.content[0].text)).toEqual({
      refused: true,
      // 底线（lead-tools-and-routing spec D11）：不绕开，告诉用户去哪里点。
      kind: "floor",
      refusal: {
        code: "user_direct", target: { type: "device", id: String(binding.id) }, action: "revoke", label: "作废设备凭证",
        permission: "user_direct", where: "设置 → 设备 → 已配对设备", message: expect.stringContaining("请用户在 设置 → 设备 → 已配对设备 里自己点"),
      },
    });
    expect(result.details.refusal.where).toBe("设置 → 设备 → 已配对设备");
    expect(getBinding(db, binding.id)?.status).toBe("active");

    const listed = JSON.parse((await tool("list_actions").execute("t", { target_type: "device", target_id: String(binding.id) })).content[0].text);
    expect(listed.actions).toMatchObject([{ id: "revoke", lead: "user_direct", leadReady: false, where: "设置 → 设备 → 已配对设备" }]);
  });

  it("throws the other errors as they are", async () => {
    await expect(tool("perform_action").execute("t", {
      target_type: "device", target_id: "999", action: "revoke", reason: "用户说的",
    })).rejects.toThrow(/不存在/);
    await expect(tool("perform_action").execute("t", {
      target_type: "runtime", target_id: "codex", action: "disable", reason: "账号被停用",
    })).rejects.toThrow(/执行器设置还没有启动/);
  });
});
