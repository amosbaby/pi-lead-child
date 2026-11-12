// 网页看台账的两个只读接口（.scratch/external-worker-hub/spec.md P1-2、P1-7）。网关、store、领单都是真的。核对：
//   - GET /v1/tickets/meta?ids=…：每张单的处理方式、复杂度、领取人、领取方式、几小时没动静、来源标签；ids 要校验、有上限；
//   - GET /v1/tickets/:id/links：来源（没有地址的也给）、会话、判断理由；子工单自己没有来源时给根工单的；
//   - 两个都只要 tickets:view；工人凭证（只有 worker）读不了；
//   - TicketSummary 的字段没有因为这些信息变多。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { TICKET_META_MAX_IDS, TicketLinksSchema, TicketMetaListSchema, TicketSummarySchema } from "@pi-lead-child/protocol";
import { Value } from "typebox/value";
import {
  addTicketSource, createItem, createLoopbackBinding, createWorkerBinding, openDb, setHandling, type Db,
} from "@pi-lead-child/store";
import { attachSession, claimTicket, reportOnTicket } from "@pi-lead-child/engine";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";

let db: Db;
const servers: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  db = openDb(join(tempDir("plc-ticket-links-"), "plc.db"));
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  db.close();
});

async function start() {
  const server = await startPairedServer({
    db,
    controlPlane: createControlPlaneService(db, {
      runtime: () => ({ model: "stub/model", sessionId: "stub-session", busy: false, runningItemIds: [], aish: null }),
      now: () => new Date(),
    }),
    hello: () => ({}),
    chat: () => "started",
    addClient: () => () => {},
    log: () => {},
  }, { port: 0 });
  servers.push(server);
  const reader = createLoopbackBinding(db, { name: "只读", scopes: ["tickets:view"] });
  const get = async (path: string, token: string | null = reader.accessToken) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { get };
}

const ticket = (title = "fix the retry policy", extra: { parentItemId?: number; rootItemId?: number } = {}) =>
  createItem(db, { title, brief: "the retry policy drops the last attempt", createdBy: "user", ...extra });

function claim(itemId: number, name = "ethan-cc") {
  const worker = createWorkerBinding(db, { name });
  claimTicket(db, { itemId, bindingId: worker.binding.id, workerName: name });
  return worker.binding.id;
}

// 外部 Run 是 hours 小时以前领的。
function claimedHoursAgo(itemId: number, hours: number) {
  const at = new Date(Date.now() - hours * 3_600_000).toISOString().replace("T", " ").slice(0, 19);
  db.prepare("UPDATE runs SET started_at=? WHERE item_id=? AND runtime='external'").run(at, itemId);
}

describe("GET /v1/tickets/meta", () => {
  it("gives handling, complexity, the worker, the claim mode, idle hours and the source label, in the order asked", async () => {
    const { get } = await start();
    const claimed = ticket("claimed");
    addTicketSource(db, { itemId: claimed, kind: "jira", url: "https://acme.example.com/browse/PROJ-123", externalKey: "PROJ-123" });
    // 领取会撤掉 needs_user 的判断（裁定 R31），auto 留着。
    setHandling(db, claimed, { handling: "auto", reason: "只读查询", complexity: "medium" });
    claim(claimed, "ethan-cc");
    claimedHoursAgo(claimed, 5);
    const plain = ticket("plain");
    addTicketSource(db, { itemId: plain, kind: "slack", url: null, conversation: "slack:dm:alice" });

    const reply = await get(`/v1/tickets/meta?ids=${plain},${claimed},999`);
    expect(reply.status).toBe(200);
    expect(Value.Check(TicketMetaListSchema, reply.body)).toBe(true);
    expect(reply.body).toEqual([
      { id: plain, handling: null, complexity: null, claimedBy: null, claimMode: null, idleHours: null, sourceLabel: "Slack", needsYou: false },
      {
        id: claimed, handling: "auto", complexity: "medium", claimedBy: "ethan-cc", claimMode: "manual", idleHours: 5,
        sourceLabel: "PROJ-123", needsYou: false,
      },
    ]);
  });

  // ruling R18：needsYou 和工人的 needs_me（R15）同一条规则：needs_user、没结束、没有活着的外部 Run。
  it("says needsYou only for a needs_user ticket that is not finished and not claimed", async () => {
    const { get } = await start();
    const waiting = ticket("waiting");
    setHandling(db, waiting, { handling: "needs_user", reason: "交给你判断" });
    const done = ticket("done");
    setHandling(db, done, { handling: "needs_user", reason: "交给你判断" });
    db.prepare("UPDATE items SET stage='done' WHERE id=?").run(done);
    const claimed = ticket("claimed");
    setHandling(db, claimed, { handling: "needs_user", reason: "交给你判断" });
    claim(claimed);
    const automatic = ticket("automatic");
    setHandling(db, automatic, { handling: "auto", reason: "只读查询" });

    const reply = await get(`/v1/tickets/meta?ids=${waiting},${done},${claimed},${automatic}`);
    expect(reply.body.map((row: any) => [row.id, row.needsYou])).toEqual([
      [waiting, true], [done, false], [claimed, false], [automatic, false],
    ]);
  });

  it("counts idle hours from the latest sign of life: a report resets them", async () => {
    const { get } = await start();
    const id = ticket();
    const bindingId = claim(id);
    claimedHoursAgo(id, 6);
    expect((await get(`/v1/tickets/meta?ids=${id}`)).body[0].idleHours).toBe(6);
    reportOnTicket(db, { itemId: id, bindingId, workerName: "ethan-cc", text: "found the cause" });
    expect((await get(`/v1/tickets/meta?ids=${id}`)).body[0].idleHours).toBe(0);
  });

  it("refuses ids that are missing, not numbers, or too many", async () => {
    const { get } = await start();
    const tooMany = Array.from({ length: TICKET_META_MAX_IDS + 1 }, (_, index) => index + 1).join(",");
    for (const query of ["", "?ids=", "?ids=1,x", "?ids=0", "?ids=-1", "?ids=1.5", "?ids=1;DROP", `?ids=${tooMany}`]) {
      expect((await get(`/v1/tickets/meta${query}`)).status, query).toBe(400);
    }
    const limit = Array.from({ length: TICKET_META_MAX_IDS }, (_, index) => index + 1).join(",");
    expect((await get(`/v1/tickets/meta?ids=${limit}`)).status).toBe(200);
  });
});

describe("GET /v1/tickets/:id/links", () => {
  it("gives the sources (also without an address), the sessions and the reason for the handling", async () => {
    const { get } = await start();
    const id = ticket();
    addTicketSource(db, { itemId: id, kind: "slack", url: "https://acme.example.com/archives/C1/p1", conversation: "slack:C1" });
    addTicketSource(db, { itemId: id, kind: "slack", url: null, conversation: "slack:dm:alice" });
    // 领取会撤掉 needs_user 的判断（裁定 R31），auto 和它的理由留着。
    setHandling(db, id, { handling: "auto", reason: "只读查询，没有副作用" });
    const bindingId = claim(id);
    attachSession(db, { itemId: id, bindingId, workerName: "ethan-cc", url: "claude://resume?session=abc" });
    attachSession(db, { itemId: id, bindingId, workerName: "ethan-cc", sessionId: "4f2a-session" });

    const reply = await get(`/v1/tickets/${id}/links`);
    expect(reply.status).toBe(200);
    expect(Value.Check(TicketLinksSchema, reply.body)).toBe(true);
    expect(reply.body.sources.map((source: any) => [source.url, source.conversation])).toEqual([
      ["https://acme.example.com/archives/C1/p1", "slack:C1"],
      [null, "slack:dm:alice"],
    ]);
    expect(reply.body.sessions).toEqual([
      { url: "claude://resume?session=abc", sessionId: null },
      { url: null, sessionId: "4f2a-session" },
    ]);
    expect(reply.body.handlingReason).toBe("只读查询，没有副作用");
  });

  it("gives the root ticket's sources to a child ticket that has none, also in the list's label", async () => {
    const { get } = await start();
    const root = ticket("root");
    addTicketSource(db, { itemId: root, kind: "notion", url: "https://www.notion.so/acme/Page-0123456789abcdef0123456789abcdef", externalKey: null });
    const child = ticket("child", { parentItemId: root, rootItemId: root });

    const reply = await get(`/v1/tickets/${child}/links`);
    expect(reply.body.sources).toHaveLength(1);
    expect(reply.body.sources[0].itemId).toBe(root);
    expect(reply.body.sessions).toEqual([]);
    expect(reply.body.handlingReason).toBeNull();
    expect((await get(`/v1/tickets/meta?ids=${child}`)).body[0].sourceLabel).toBe("Notion");
  });

  it("answers 404 for a ticket that does not exist", async () => {
    const { get } = await start();
    expect((await get("/v1/tickets/999/links")).status).toBe(404);
  });
});

describe("who may read them", () => {
  it("needs tickets:view: no token is 401, a worker credential is 403", async () => {
    const { get } = await start();
    const id = ticket();
    const worker = createWorkerBinding(db, { name: "ethan-cc" });
    for (const path of [`/v1/tickets/meta?ids=${id}`, `/v1/tickets/${id}/links`]) {
      expect((await get(path, null)).status, path).toBe(401);
      expect((await get(path, worker.accessToken)).status, path).toBe(403);
    }
  });
});

describe("TicketSummary", () => {
  it("has the same fields as before the ticket hub: the new facts are not in it", () => {
    expect(Object.keys(TicketSummarySchema.properties).sort()).toEqual(TICKET_SUMMARY_FIELDS);
  });
});

// TicketSummarySchema 的字段（integration/hub 041471f9，Task 10 以前）。
const TICKET_SUMMARY_FIELDS: string[] = [
  "acceptancePolicy", "attention", "deferUntil", "deliveryPolicy", "displayTitle", "dueAt", "executionState", "hasRun",
  "id", "kind", "nextMilestone", "parentTicketId", "pause", "priority", "project", "reviewState", "reworkPolicy",
  "rootTicketId", "runtime", "stage", "stageChangedAt", "status", "summary", "title", "updatedAt",
  "verificationPolicy", "workflowKind", "workflowState", "worklistVisibility", "workspace",
];
