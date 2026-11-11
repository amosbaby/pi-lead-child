// 撤销外部工人的凭证（设置 → 设备 → 已配对设备，或者 plc pair revoke）要放掉它领着的单（.scratch/external-worker-hub/spec.md P1-5）：
// 外部 Run 关掉、工单回到 ready，和 ticket.release 一样。别的工人领着的单、已经交差的单、没有外部 Run 的单都不动。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createCliBinding, createItem, createWorkerBinding, getBinding, getItem, listActivities, listRuns, openDb, type Db } from "@pi-lead-child/store";
import { releaseBindingClaims, runTicketAction, runUiAction, type TicketActionCaller } from "../src/index.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-worker-revoke-"), "plc.db"));
});

afterEach(() => {
  db.close();
});

type Worker = Extract<TicketActionCaller, { kind: "worker" }>;

function pairedWorker(name: string): Worker {
  const { binding } = createWorkerBinding(db, { name });
  return { kind: "worker", bindingId: binding.id, workerName: name };
}

function ticket(title = "fix the retry policy"): number {
  return createItem(db, { title, brief: "the retry policy drops the last attempt", createdBy: "user" });
}

const act = (caller: TicketActionCaller, itemId: number, action: string, input: unknown = {}) =>
  runTicketAction(db, { itemId, action, input, caller });

async function claim(by: Worker, itemId = ticket()): Promise<number> {
  await act(by, itemId, "worker.claim");
  return itemId;
}

const revokeAsUser = (bindingId: number) =>
  runUiAction(db, { target: { type: "device", id: bindingId }, action: "revoke", caller: { kind: "user" } });

const released = (itemId: number) => listActivities(db, itemId, 1000)
  .map((activity) => ({ actor: activity.actor, payload: JSON.parse(activity.payload) }))
  .filter((activity) => activity.payload.decision === "worker_claim_released");

describe("revoking a worker credential", () => {
  it("releases every ticket it holds: the external Run closes and the ticket is ready again", async () => {
    const ethan = pairedWorker("ethan-cc");
    const first = await claim(ethan);
    const second = await claim(ethan);

    await revokeAsUser(ethan.bindingId);

    expect(getBinding(db, ethan.bindingId)?.status).toBe("revoked");
    for (const itemId of [first, second]) {
      expect(getItem(db, itemId)!.stage).toBe("ready");
      expect(listRuns(db, itemId)).toMatchObject([{ runtime: "external", state: "stopped" }]);
      expect(released(itemId)).toMatchObject([{ actor: "user", payload: { workerName: "ethan-cc", bindingId: ethan.bindingId } }]);
    }
    // the same transition ticket.release makes: active -> ready by the user, carrying the Run
    const edge = listActivities(db, first, 1000).map((a) => JSON.parse(a.payload)).find((p) => p.from === "active" && p.to === "ready");
    expect(edge).toBeDefined();
  });

  it("lets another worker claim the released ticket", async () => {
    const ethan = pairedWorker("ethan-cc");
    const nina = pairedWorker("nina-codex");
    const itemId = await claim(ethan);
    await revokeAsUser(ethan.bindingId);
    await act(nina, itemId, "worker.claim");
    expect(getItem(db, itemId)!.stage).toBe("active");
    expect(listRuns(db, itemId).filter((run) => run.state === "running")).toHaveLength(1);
  });

  it("leaves other workers' tickets, finished tickets and tickets nobody holds alone", async () => {
    const ethan = pairedWorker("ethan-cc");
    const nina = pairedWorker("nina-codex");
    const ninas = await claim(nina);
    const done = await claim(ethan);
    await act(ethan, done, "worker.complete", { summary: "done", evidence: "tests pass" });
    const untouched = ticket("nobody holds this");

    await revokeAsUser(ethan.bindingId);

    expect(getItem(db, ninas)!.stage).toBe("active");
    expect(listRuns(db, ninas)).toMatchObject([{ state: "running" }]);
    expect(getItem(db, done)!.stage).toBe("review");
    expect(released(done)).toEqual([]);
    expect(getItem(db, untouched)!.stage).toBe("ready");
  });

  it("is a no-op for a credential that is not a worker", async () => {
    const { binding } = createCliBinding(db, { name: "plc" });
    expect(releaseBindingClaims(db, binding.id, { actor: "user" })).toEqual([]);
    await revokeAsUser(binding.id);
    expect(getBinding(db, binding.id)?.status).toBe("revoked");
  });

  it("revoking twice releases nothing the second time", async () => {
    const ethan = pairedWorker("ethan-cc");
    const itemId = await claim(ethan);
    await revokeAsUser(ethan.bindingId);
    await revokeAsUser(ethan.bindingId);
    expect(released(itemId)).toHaveLength(1);
  });
});
