// 「沙箱外执行」授权（工单 #62）：
//   - 只有用户本人能开关（user_direct）：页面入口做成，Lead 的 ticket_action 得到结构化拒绝，账本上什么都没写。
//   - 打开、关闭都记活动和事件（ticket.sandbox_changed）。
//   - 外部通道派出的工单（agent_task，purpose=lookup）、Lead 在外部消息叫醒的一轮里建的工单、它们的子工单，不能打开。
//   - 派发时只有执行者的执行 Run 在沙箱外跑；核查员、合并都照旧。Run 第一次启动时定下，记在 metadata 和活动里；
//     之后开关授权，已经建好的 Run 不变，下一个 Run 才生效。runItem 把它交给 runtime（RuntimeStartRequest.unsandboxed）。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { ReplayRuntime } from "@pi-lead-child/runtime/testing";
import type { RuntimeHandle, RuntimeStartRequest } from "@pi-lead-child/runtime";
import { addActivity, createItem, createRun, getItem, getRun, listEvents, openDb, transition, type Db } from "@pi-lead-child/store";
import { runItem } from "../src/children/manager.js";
import {
  decideRunSandbox, EXTERNAL_ORIGIN_DECISION, runsUnsandboxed, listLeadTicketActions, listTicketActions, runTicketAction, TicketActionError,
  type TicketActionCaller,
} from "../src/ticket-actions/index.js";

const USER: TicketActionCaller = { kind: "user" };
const LEAD: TicketActionCaller = { kind: "lead", turnId: null };

function fixture(prefix: string) {
  const dir = tempDir(prefix);
  const dbPath = join(dir, "plc.db");
  return { dir, dbPath, db: openDb(dbPath) };
}

const toggle = (db: Db, itemId: number, enabled: boolean, caller: TicketActionCaller = USER) =>
  runTicketAction(db, { itemId, action: "set_unsandboxed", input: { enabled }, caller, ...(caller.kind === "lead" ? { reason: "用户说放开" } : {}) });

const decisions = (db: Db, itemId: number, name: string) => db.prepare(
  `SELECT actor, payload FROM activities WHERE item_id=? AND kind='decision' AND json_extract(payload, '$.decision')=? ORDER BY id`,
).all(itemId, name) as Array<{ actor: string; payload: string }>;

describe("the run-outside-the-sandbox permission", () => {
  it("is turned on and off by the user, with an activity and an event each time", async () => {
    const { db } = fixture("plc-unsandboxed-toggle-");
    const itemId = createItem(db, { title: "改构建脚本", brief: "b", createdBy: "user" });
    expect(getItem(db, itemId)!.unsandboxed_execution).toBe(0);

    expect(await toggle(db, itemId, true)).toMatchObject({ authority: "user", result: { enabled: true, changed: true } });
    expect(getItem(db, itemId)!.unsandboxed_execution).toBe(1);
    // 同一个值再点一次：什么都不写。
    expect(await toggle(db, itemId, true)).toMatchObject({ result: { enabled: true, changed: false } });
    expect(await toggle(db, itemId, false)).toMatchObject({ result: { enabled: false, changed: true } });
    expect(getItem(db, itemId)!.unsandboxed_execution).toBe(0);

    expect(decisions(db, itemId, "unsandboxed_execution").map((row) => [row.actor, JSON.parse(row.payload).enabled]))
      .toEqual([["user", true], ["user", false]]);
    expect(listEvents(db, { kind: "ticket.sandbox_changed", entityKey: `ticket:${itemId}` }).map((event) => event.payload))
      .toEqual([
        expect.objectContaining({ itemId, unsandboxed: true, actor: "user" }),
        expect.objectContaining({ itemId, unsandboxed: false, actor: "user" }),
      ]);
  });

  it("refuses Lead with a structured user_direct refusal and writes nothing", async () => {
    const { db } = fixture("plc-unsandboxed-lead-");
    const itemId = createItem(db, { title: "改构建脚本", brief: "b", createdBy: "user" });
    const refused = toggle(db, itemId, true, LEAD);
    await expect(refused).rejects.toBeInstanceOf(TicketActionError);
    await expect(refused).rejects.toMatchObject({ code: "user_direct", message: expect.stringContaining("plc sandbox") });
    expect(getItem(db, itemId)!.unsandboxed_execution).toBe(0);
    expect(decisions(db, itemId, "unsandboxed_execution")).toEqual([]);
    expect(listEvents(db, { kind: "ticket.sandbox_changed" })).toEqual([]);
    expect((await listLeadTicketActions(db, itemId, { turnId: null })).find((action) => action.id === "set_unsandboxed"))
      .toMatchObject({ permission: "user_direct", lead: "user_direct", leadReady: false });
  });

  it("cannot be turned on for a ticket from an external channel, and says why", async () => {
    const { db } = fixture("plc-unsandboxed-external-");
    // 通道派的子 agent 工单（agent_task）。
    const agentTask = createItem(db, { title: "Slack 代码 review：Nina 的请求", brief: "b", createdBy: "system", purpose: "lookup" });
    // Lead 在外部消息叫醒的一轮里建的工单，和它下面的子工单。
    const fromSlack = createItem(db, { title: "按 Ethan 在 Slack 里说的修", brief: "b", createdBy: "lead" });
    addActivity(db, { itemId: fromSlack, actor: "lead", kind: "decision", payload: { decision: EXTERNAL_ORIGIN_DECISION } });
    const child = createItem(db, { title: "子工单", brief: "b", createdBy: "child", parentItemId: fromSlack, rootItemId: fromSlack });
    for (const itemId of [agentTask, fromSlack, child]) {
      const listed = (await listTicketActions(db, itemId)).find((action) => action.id === "set_unsandboxed")!;
      expect(listed).toMatchObject({ available: false, reason: expect.stringContaining("外部通道") });
      await expect(toggle(db, itemId, true)).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("外部通道") });
      expect(getItem(db, itemId)!.unsandboxed_execution).toBe(0);
    }
    // 就算列被直接写成了 1，派发也不让外部通道的工单出沙箱。
    db.prepare("UPDATE items SET unsandboxed_execution=1 WHERE id=?").run(fromSlack);
    const runId = createRun(db, { itemId: fromSlack, role: "executor", purpose: "execution" });
    expect(decideRunSandbox(db, runId, { role: "executor", purpose: "execution" })).toBe(false);
  });

  it("applies only to executor runs, from the next run, and marks the run", () => {
    const { db } = fixture("plc-unsandboxed-runs-");
    const itemId = createItem(db, { title: "改构建脚本", brief: "b", createdBy: "user" });
    const before = createRun(db, { itemId, role: "executor", purpose: "execution" });
    expect(decideRunSandbox(db, before, { role: "executor", purpose: "execution" })).toBe(false);

    db.prepare("UPDATE items SET unsandboxed_execution=1 WHERE id=?").run(itemId);
    // 授权打开以前就开始的 Run 不受影响（再启动时读回记下的值）。
    expect(decideRunSandbox(db, before, { role: "executor", purpose: "execution" })).toBe(false);
    const executor = createRun(db, { itemId, role: "executor", purpose: "execution" });
    // 核查 Run 要工单在等验收。
    transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
    transition(db, { itemId, to: "review", actor: "system", reason: "delivered" });
    const reviewer = createRun(db, { itemId, role: "reviewer", purpose: "review" });
    expect(decideRunSandbox(db, executor, { role: "executor", purpose: "execution" })).toBe(true);
    expect(decideRunSandbox(db, reviewer, { role: "reviewer", purpose: "review" })).toBe(false);
    // 合并、工单对话这些别的用途也照旧进沙箱（建这类 Run 要别的前提，这里直接问判断）。
    const item = getItem(db, itemId)!;
    for (const purpose of ["integration", "conversation", "learning", "outcome_repair", "lookup"] as const) {
      expect(runsUnsandboxed(db, item, { role: "executor", purpose })).toBe(false);
    }
    expect(runsUnsandboxed(db, item, { role: "executor", purpose: "execution" })).toBe(true);
    expect(JSON.parse(getRun(db, executor)!.metadata)).toMatchObject({ unsandboxed: true });
    expect(JSON.parse(getRun(db, reviewer)!.metadata)).toMatchObject({ unsandboxed: false });
    expect(decisions(db, itemId, "run_unsandboxed").map((row) => JSON.parse(row.payload))).toEqual([
      expect.objectContaining({ role: "executor", purpose: "execution" }),
    ]);

    // 关掉以后：已经在沙箱外跑的 Run 不变，新的 Run 回到沙箱里。
    db.prepare("UPDATE items SET unsandboxed_execution=0 WHERE id=?").run(itemId);
    expect(decideRunSandbox(db, executor, { role: "executor", purpose: "execution" })).toBe(true);
    transition(db, { itemId, to: "active", actor: "user", reason: "rework" });
    const next = createRun(db, { itemId, role: "executor", purpose: "execution" });
    expect(decideRunSandbox(db, next, { role: "executor", purpose: "execution" })).toBe(false);
  });

  it("hands the decision to the runtime when the executor starts", async () => {
    const { dir, dbPath, db } = fixture("plc-unsandboxed-runitem-");
    const requests: RuntimeStartRequest[] = [];
    class Capture extends ReplayRuntime {
      override async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
        requests.push(request);
        return super.start(request);
      }
    }
    const run = async (itemId: number, role: "executor" | "reviewer") => {
      const runtime = new Capture({ runtime: "claude", events: [
        { type: "run.started", runtime: "claude", model: null },
        { type: "run.completed", exitCode: 0 },
      ] });
      await runItem(db, itemId, {
        dbPath, dataDir: dir, sessionDir: join(dir, "sessions", `item-${itemId}`), prompt: "go", role, lingerMs: 0, runtime,
      });
      return requests.at(-1)!;
    };
    const allowed = createItem(db, { title: "改构建脚本", brief: "b", createdBy: "user" });
    await toggle(db, allowed, true);
    expect((await run(allowed, "executor")).unsandboxed).toBe(true);
    const plain = createItem(db, { title: "普通工单", brief: "b", createdBy: "user" });
    expect((await run(plain, "executor")).unsandboxed).toBeUndefined();
    const attempt = db.prepare(
      "SELECT payload FROM activities WHERE item_id=? AND kind='attempt_start' ORDER BY id DESC LIMIT 1",
    ).get(allowed) as { payload: string };
    expect(JSON.parse(attempt.payload)).toMatchObject({ unsandboxed: true });
  });
});
