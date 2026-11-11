// 执行模式 external、paused 下，所有会建 Run 的入口都只入队，不起进程（.scratch/external-worker-hub/spec.md P1-1）。
// 每个入口都按 daemon 里的接法调用真的函数（Lead 的 spawnItemChild、派发器、触发器、后台检查、孤儿回收、恢复控制、
// 工单操作 start、工单对话），runtime 是一个记下启动次数的回放 runtime。期望：
//   - 没有建 runtime 不是 external 的 Run，回放 runtime 一次也没启动；
//   - 工单的 stage 不被闸门改动（从 ready 开始的入口留在 ready）；
//   - 工单上有一条 execution_deferred。
// 对照组：同样的入口在 self 模式下真的建 Run、启动 runtime。没有它，上面的「0 次」说明不了什么。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { EXTERNAL_RUNTIME_ID } from "@pi-lead-child/protocol";
import {
  createDispatcher, createOrchestrator, createScheduler, deferIfExternal, EXECUTION_DEFERRED_DECISION, ExecutionDeferredError,
  setExecutionMode, startItem,
} from "@pi-lead-child/engine";
import { createUserActionService } from "@pi-lead-child/gateway";
import {
  createWatchLightTask, resumeItemChild, routeTicketMessageToAgentRun, runningChildren, spawnClaimedItem, spawnItemChild,
  type LeadDeps,
} from "@pi-lead-child/lead";
import { RuntimeRegistry } from "@pi-lead-child/runtime";
import { ReplayRuntime } from "@pi-lead-child/runtime/testing";
import {
  createItem, createOnceTrigger, createRun, getItem, getRun, listActivities, listRuns, openDb, transition, updateRun, type Db,
} from "@pi-lead-child/store";
import { recoverOrphans } from "../src/server.js";

let dir: string;
let db: Db;
let deps: LeadDeps;
let starts: Mock<(request: unknown) => void>;

beforeEach(() => {
  dir = tempDir("plc-external-mode-");
  const dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  // hub 上停用 Claude Code；选 runtime 时按本机目录选到哪一个，都是这里的回放 runtime（不起进程）。
  vi.stubEnv("PLC_DISABLED_RUNTIMES", "claude");
  starts = vi.fn<(request: unknown) => void>();
  const replay = (runtime: "codex" | "pi") => {
    const fake = new ReplayRuntime({
      runtime, events: [{ type: "run.started", runtime, model: null }, { type: "run.completed", exitCode: 0 }],
    });
    const start = fake.start.bind(fake);
    fake.start = ((request: Parameters<typeof fake.start>[0]) => { starts(request); return start(request); }) as never;
    return fake;
  };
  deps = { db, dbPath, dataDir: join(dir, "data"), runtimeRegistry: new RuntimeRegistry([replay("codex"), replay("pi")]) };
});

afterEach(async () => {
  // self 模式的对照组启动了 Run：等 Lead 看管的 child 都收尾（它们记在模块级的表里，下一条测试的工单编号又从 1 开始），
  // 再关库。
  await Promise.allSettled([...runningChildren().values()]);
  expect(runningChildren().size).toBe(0);
  db.close();
  vi.unstubAllEnvs();
});

function ticket(title = "a ticket"): number {
  const workdir = tempDir("plc-external-mode-work-");
  return createItem(db, { title, brief: "do it", createdBy: "user", runtime: "codex", workdir });
}

function deferrals(itemId: number) {
  return listActivities(db, itemId, 1000)
    .map((activity) => JSON.parse(activity.payload))
    .filter((payload) => payload.decision === EXECUTION_DEFERRED_DECISION);
}

const maxRunId = (): number => (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM runs").get() as { id: number }).id;

// 这个入口新建的、runtime 不是 external 的 Run。
function runsWithRuntimeOtherThanExternal(after: number): unknown[] {
  return db.prepare("SELECT id, item_id, runtime FROM runs WHERE id > ? AND runtime <> ?").all(after, EXTERNAL_RUNTIME_ID);
}

interface Entry {
  name: string;
  // 准备入口要的数据（例如一个暂停的 Run）。这些 Run 不算入口建的。
  setup?(): number;
  // 调用这个入口。返回要看的工单。入口在 daemon 里的接法照抄在这里。
  invoke(itemId: number | undefined): Promise<number> | number;
  // 工单起点不是 ready 的入口（孤儿回收、恢复暂停的 Run）：闸门不改它的 stage，期望留在这个 stage。
  stage?: string;
}

const DISPATCH_TRIGGERS = ["user-rework", "continuation", "runtime-recovery", "start-stall-retry", "spawn-suspended"];

const DISPATCH_ENTRIES: Entry[] = [
  // dispatch_requests 的各种原因：daemon 的编排器每一拍认领一次，认领到的交给 spawnClaimedItem。
  ...DISPATCH_TRIGGERS.map((trigger): Entry => ({
    name: `dispatch_requests (${trigger})`,
    async invoke() {
      const itemId = ticket();
      createDispatcher(db).request({
        itemId, role: "executor", purpose: "execution", runtime: "codex", trigger, idempotencyKey: `entry:${trigger}`,
      });
      const orchestrator = createOrchestrator(db, { onDispatch: (claim) => { spawnClaimedItem(deps, claim); } });
      await orchestrator.tick();
      await orchestrator.tick();
      return itemId;
    },
  })),
  {
    name: "start (the page's start button and Lead's spawn_child for the executor)",
    invoke() {
      const itemId = ticket();
      createUserActionService({ db, startRun: (id, options) => spawnItemChild(deps, id, { ...options }) }).startItem(itemId);
      return itemId;
    },
  },
  {
    name: "spawn_child (the reviewer, and the scheduler's path into spawnItemChild)",
    invoke() {
      const itemId = ticket();
      spawnItemChild(deps, itemId, {});
      return itemId;
    },
  },
  {
    name: "a create_and_start trigger",
    invoke() {
      createOnceTrigger(db, {
        label: "every morning", fireAt: new Date(Date.now() - 60_000).toISOString(), createdBy: "user",
        action: { type: "create_and_start", payload: { title: "from a trigger", brief: "b", workdir: tempDir("plc-trigger-work-") } },
      });
      createScheduler(db, { onStartRun: (itemId) => { spawnItemChild(deps, itemId, {}); } }).tick();
      const row = db.prepare("SELECT id FROM items WHERE title='from a trigger'").get() as { id: number };
      return row.id;
    },
  },
  {
    name: "a watch's agent check (createWatchLightTask, then spawnItemChild)",
    invoke() {
      const itemId = createWatchLightTask(db, {
        dataDir: dir, watchId: 1, task: { title: "check the build", brief: "look" }, agent: { runtime: "codex" },
      });
      spawnItemChild(deps, itemId, {});
      return itemId;
    },
  },
  {
    name: "create_task(light) followed by spawn_child",
    invoke() {
      const itemId = createWatchLightTask(db, {
        dataDir: dir, watchId: 2, task: { title: "light task", brief: "look" }, agent: { runtime: "codex" },
      });
      spawnItemChild(deps, itemId, {});
      return itemId;
    },
  },
  {
    name: "orphan reclaim after a daemon restart",
    // 孤儿回收自己把执行中的工单记成 blocked（Run 被打断了），闸门不改它。
    stage: "blocked",
    setup() {
      const itemId = ticket();
      const runId = createRun(db, { itemId, runtime: "codex" });
      transition(db, { itemId, to: "active", actor: "system", reason: "started" });
      updateRun(db, runId, { state: "running" });
      return itemId;
    },
    invoke(itemId) {
      // daemon 的接法：redispatch 调 spawnItemChild，抛错时返回 false。
      recoverOrphans(db, {
        redispatch: (id) => {
          try { spawnItemChild(deps, id, {}); return true; } catch { return false; }
        },
      });
      // 没有重派：不记 auto_redispatch，正文不写「已自动重派」，Lead 收到 Run 被回收的 blocker。
      expect(listActivities(db, itemId!, 1000).map((activity) => JSON.parse(activity.payload).decision))
        .not.toContain("auto_redispatch");
      expect(getItem(db, itemId!)!.body).not.toContain("已自动重派");
      expect(db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE item_id=? AND severity='blocker'").get(itemId)).toEqual({ n: 1 });
      return itemId!;
    },
  },
  {
    name: "resumeItemChild (resuming a paused run)",
    // 暂停的 Run 的工单在执行中；恢复被推迟时 Run 留在 paused，工单不动。
    stage: "active",
    setup() {
      const itemId = ticket();
      const runId = createRun(db, { itemId, runtime: "codex" });
      transition(db, { itemId, to: "active", actor: "system", reason: "started" });
      updateRun(db, runId, { state: "running", sessionId: "s", externalSessionId: "s" });
      db.prepare("UPDATE runs SET state='paused' WHERE id=?").run(runId);
      return itemId;
    },
    async invoke(itemId) {
      const runId = listRuns(db, itemId!)[0]!.id;
      // daemon 的接法：恢复控制调 resumeItemChild，抛错时 Run 留在 paused，原因交给用户。
      const service = createUserActionService({ db, resumeRun: (request) => { resumeItemChild(deps, request); } });
      await expect(service.resumeRun(runId)).rejects.toThrow();
      expect(getRun(db, runId)!.state).toBe("paused");
      return itemId!;
    },
  },
  {
    name: "lifecycle.ts startItem without a runner",
    invoke() {
      const itemId = ticket();
      startItem(db, {}, itemId);
      return itemId;
    },
  },
  {
    name: "routeTicketMessageToAgentRun (ticket chat)",
    invoke() {
      const itemId = ticket();
      expect(() => routeTicketMessageToAgentRun(deps, { itemId, message: "how is it going?" })).toThrow(ExecutionDeferredError);
      return itemId;
    },
  },
];

describe.each(["external", "paused"] as const)("execution mode %s", (mode) => {
  beforeEach(() => { setExecutionMode(db, mode); });

  it.each(DISPATCH_ENTRIES.map((entry) => [entry.name, entry] as const))("%s only queues", async (_name, entry) => {
    const prepared = entry.setup?.();
    const before = maxRunId();
    const itemId = await entry.invoke(prepared);
    // 异步的启动路径（fire-and-forget）也给它机会跑。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runsWithRuntimeOtherThanExternal(before)).toEqual([]);
    expect(starts).not.toHaveBeenCalled();
    expect(getItem(db, itemId)!.stage).toBe(entry.stage ?? "ready");
    expect(deferrals(itemId)).toContainEqual(expect.objectContaining({ decision: EXECUTION_DEFERRED_DECISION, mode }));
  });
});

describe("the control: in self mode the same entries start the runtime", () => {
  it.each([
    DISPATCH_ENTRIES.find((entry) => entry.name.startsWith("dispatch_requests"))!,
    DISPATCH_ENTRIES.find((entry) => entry.name.startsWith("spawn_child"))!,
    DISPATCH_ENTRIES.find((entry) => entry.name.startsWith("start "))!,
  ].map((entry) => [entry.name, entry] as const))("%s", async (_name, entry) => {
    const itemId = await entry.invoke(entry.setup?.());
    await vi.waitFor(() => expect(starts).toHaveBeenCalled(), { timeout: 10_000 });
    expect(listRuns(db, itemId).length).toBeGreaterThan(0);
    expect(deferrals(itemId)).toEqual([]);
  });
});

describe("switching the mode", () => {
  it("a running Run is not affected by switching", async () => {
    const itemId = ticket();
    const runId = createRun(db, { itemId, runtime: "codex" });
    transition(db, { itemId, to: "active", actor: "system", reason: "started" });
    updateRun(db, runId, { state: "running" });
    setExecutionMode(db, "external");
    expect(getRun(db, runId)!.state).toBe("running");
    expect(getItem(db, itemId)!.stage).toBe("active");
    setExecutionMode(db, "paused");
    expect(getRun(db, runId)!.state).toBe("running");
    updateRun(db, runId, { state: "finished", endedAt: true });
  });

  // 认领在 self 下做完、启动前切到了 external：runItem 兜住，不起进程，认领建的 Run 按被拒绝的启动收尾。
  it("a dispatch claimed just before the switch does not start", async () => {
    const itemId = ticket();
    const dispatcher = createDispatcher(db);
    dispatcher.request({ itemId, role: "executor", purpose: "execution", runtime: "codex", trigger: "test", idempotencyKey: "race" });
    const claim = dispatcher.claimNext()!;
    expect(claim).toMatchObject({ itemId });
    setExecutionMode(db, "external");
    spawnClaimedItem(deps, claim);
    await Promise.allSettled([...runningChildren().values()]);
    expect(starts).not.toHaveBeenCalled();
    expect(getRun(db, claim.runId)!.state).toBe("stopped");
    expect(deferrals(itemId)).toEqual([expect.objectContaining({ mode: "external", reason: "run_item" })]);
  });

  it("paused mode also blocks worker claims", () => {
    // 工人领单在 Task 7（worker.claim）。这里先断言 paused 下派发不建 Run；领单的断言等 Task 7 补上。
    setExecutionMode(db, "paused");
    const itemId = ticket();
    expect(deferIfExternal(db, itemId, "worker_claim")).toBe(true);
    expect(listRuns(db, itemId)).toEqual([]);
  });

  it("ticket chat on a claimed ticket does not spawn", () => {
    setExecutionMode(db, "external");
    const itemId = ticket();
    // 外部工人领走了这张单：领取就是建一个 runtime=external 的 Run（Task 7 的 worker.claim 用同一个 createRun）。
    const claimed = createRun(db, { itemId, runtime: EXTERNAL_RUNTIME_ID });
    transition(db, { itemId, to: "active", actor: "system", reason: "claimed by an external worker", runId: claimed });
    updateRun(db, claimed, { state: "running" });
    expect(() => routeTicketMessageToAgentRun(deps, { itemId, message: "please also update the docs" }))
      .toThrow(ExecutionDeferredError);
    expect(starts).not.toHaveBeenCalled();
    expect(listRuns(db, itemId).map((run) => run.id)).toEqual([claimed]);
    // 消息进了工单的活动：工人下次 get_ticket 时看得到。
    expect(listActivities(db, itemId, 1000).map((activity) => ({ kind: activity.kind, payload: JSON.parse(activity.payload) })))
      .toContainEqual({ kind: "comment", payload: expect.objectContaining({ content: "please also update the docs" }) });
    updateRun(db, claimed, { state: "finished", endedAt: true });
  });
});
