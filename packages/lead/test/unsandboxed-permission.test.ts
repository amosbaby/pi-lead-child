// 「沙箱外执行」授权（工单 #62）在 Lead 这一侧：
//   - Lead 的 ticket_action(set_unsandboxed) 总是得到结构化拒绝（user_direct），写明用户去哪里开。
//   - Lead 在外部消息叫醒的一轮里建的工单记下来源（ticket_external_origin），用户也不能给它打开；平常建的工单用户能开。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { runTicketAction } from "@pi-lead-child/engine";
import { getItem, openDb, type Db } from "@pi-lead-child/store";
import { createLeadTools, type LeadDeps } from "../src/tools.js";

let db: Db;
let dir: string;

function tool(name: string, extra: Partial<LeadDeps> = {}): any {
  return createLeadTools({ db, dbPath: join(dir, "plc.db"), dataDir: dir, ...extra } as LeadDeps)
    .find((candidate: any) => candidate.name === name);
}

const createdId = (text: string) => Number(/created task #(\d+)/.exec(text)![1]);
const userToggle = (itemId: number) =>
  runTicketAction(db, { itemId, action: "set_unsandboxed", input: { enabled: true }, caller: { kind: "user" } });

beforeEach(() => {
  dir = tempDir("plc-lead-unsandboxed-");
  db = openDb(join(dir, "plc.db"));
});

describe("the run-outside-the-sandbox permission from Lead's side", () => {
  it("refuses Lead's ticket_action with a structured refusal that names where the user turns it on", async () => {
    const id = createdId((await tool("create_task").execute("t", { title: "改构建脚本", brief: "b" })).content[0].text);
    const result = await tool("ticket_action").execute("t", {
      ticket_id: id, action: "set_unsandboxed", input: { enabled: true }, reason: "用户说放开沙箱",
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      action: "set_unsandboxed", refused: true, refusal: { permission: "user_direct", where: expect.stringContaining("plc sandbox") },
    });
    expect(getItem(db, id)!.unsandboxed_execution).toBe(0);
  });

  it("marks a ticket created in a turn an external message woke, so the user cannot turn it on", async () => {
    const external = { currentTurnId: () => null, turnOrigin: () => ({ external: true, timer: null }) } as Partial<LeadDeps>;
    const fromSlack = createdId((await tool("create_task", external).execute("t", { title: "按 Nina 在 Slack 里说的改", brief: "b" })).content[0].text);
    await expect(userToggle(fromSlack)).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("外部通道") });
    expect(getItem(db, fromSlack)!.unsandboxed_execution).toBe(0);

    const own = createdId((await tool("create_task").execute("t", { title: "改构建脚本", brief: "b" })).content[0].text);
    await userToggle(own);
    expect(getItem(db, own)!.unsandboxed_execution).toBe(1);
  });
});
