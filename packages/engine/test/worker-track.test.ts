// 外部工人从自己的会话建单（worker.track）和用户改工单的处理方式（ticket.set_handling），.scratch/external-worker-hub/spec.md P1-2、P1-5。
// 核对：
//   - track 一次调用：建单、记来源（按链接认 slack / jira / notion，认不出或没有链接是 manual）、领取（外部 Run）、挂会话；
//     external_origin 是 0（用户自己的会话）；
//   - 同一个 Jira 单（或 Notion 页）已经是一张工单的来源：不再建单，领那张单、挂会话；自己已经领着时只挂会话；
//   - 链接不是 https、会话链接不收的 scheme、没有 worker 权限、paused：拒绝，什么都不建；
//   - ticket.set_handling 是 user_direct：用户改了写进工单和账本，Lead 拿到结构化拒绝，什么都不写；工人不能调。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { EXTERNAL_RUNTIME_ID, type Scope } from "@pi-lead-child/protocol";
import {
  addTicketSource, createItem, createLoopbackBinding, getItem, listActivities, listRuns, openDb, setHandling, ticketSources, transition, type Db,
} from "@pi-lead-child/store";
import {
  listLeadTicketActions, listTicketActions, runTicketAction, runWorkerTrack, setExecutionMode, TicketActionError, trackSourceOf,
  workerTicket, type TicketActionCaller,
} from "../src/index.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-worker-track-"), "plc.db"));
});

afterEach(() => {
  db.close();
});

type Worker = Extract<TicketActionCaller, { kind: "worker" }>;

function worker(name: string, scopes: Scope[] = ["worker"]): Worker {
  const { binding } = createLoopbackBinding(db, { name, scopes });
  return { kind: "worker", bindingId: binding.id, workerName: name };
}

const track = (caller: TicketActionCaller, input: Record<string, unknown>) => runWorkerTrack(db, { caller, input, host: { liveItemIds: () => [] } });

const refusal = (promise: Promise<unknown>) => promise.then(
  () => { throw new Error("expected a refusal"); },
  (error: unknown) => {
    if (!(error instanceof TicketActionError)) throw error;
    return { code: error.code, message: error.message };
  },
);

const itemCount = () => (db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n;
const judgment = (itemId: number) => db.prepare("SELECT handling, handling_reason, complexity, external_origin FROM items WHERE id=?").get(itemId);
const decisions = (itemId: number) => listActivities(db, itemId, 1000)
  .filter((activity) => activity.kind === "decision").map((activity) => JSON.parse(activity.payload));

describe("worker.track", () => {
  it("track creates, sources, claims and attaches in one call", async () => {
    const ethan = worker("Ethan's Claude Code");
    const outcome = await track(ethan, {
      title: "check the flaky retry test", note: "it fails one run in ten on CI", sessionUrl: "claude://resume?session=s1", sessionId: "s1",
    });
    const { ticketId, runId, created } = outcome.result as { ticketId: number; runId: number; created: boolean };
    expect(created).toBe(true);
    expect(outcome).toMatchObject({ ticketId, action: "worker.track", authority: "worker", by: { actor: "worker", bindingId: ethan.bindingId } });
    expect(getItem(db, ticketId)).toMatchObject({ title: "check the flaky retry test", brief: "it fails one run in ten on CI", stage: "active", kind: "task" });
    expect(judgment(ticketId)).toMatchObject({ external_origin: 0 });
    expect(ticketSources(db, ticketId)).toMatchObject([{ kind: "manual", url: null, externalKey: null }]);
    expect(listRuns(db, ticketId)).toMatchObject([{ id: runId, runtime: EXTERNAL_RUNTIME_ID, state: "running" }]);
    expect(workerTicket(db, ticketId, ethan.bindingId).claim).toMatchObject({
      runId, open: true, sessions: [{ url: "claude://resume?session=s1", sessionId: "s1" }],
    });
    expect(decisions(ticketId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ decision: "worker_tracked", bindingId: ethan.bindingId, workerName: "Ethan's Claude Code", sourceKind: "manual" }),
      expect.objectContaining({ decision: "worker_claimed" }),
      expect.objectContaining({ decision: "worker_session_attached" }),
    ]));
  });

  it("tracks without a session, and without a note", async () => {
    const ethan = worker("Ethan's Claude Code");
    const { ticketId } = (await track(ethan, { title: "look at the retry docs" })).result as { ticketId: number };
    expect(getItem(db, ticketId)!.stage).toBe("active");
    expect(getItem(db, ticketId)!.brief).not.toBe("");
    expect(workerTicket(db, ticketId, ethan.bindingId).claim.sessions).toEqual([]);
  });

  it("recognizes Slack, Jira and Notion links, and keeps any other https link as manual", () => {
    expect(trackSourceOf("https://acme.slack.com/archives/C0RETRY/p1762934400000100")).toEqual({
      kind: "slack", url: "https://acme.slack.com/archives/C0RETRY/p1762934400000100", externalKey: null,
    });
    expect(trackSourceOf("https://acme.atlassian.net/browse/PROJ-123")).toMatchObject({ kind: "jira", externalKey: "PROJ-123" });
    expect(trackSourceOf("https://acme.atlassian.net/jira/software/projects/PROJ/boards/7?selectedIssue=PROJ-124")).toMatchObject({ kind: "jira", externalKey: "PROJ-124" });
    // Confluence 也在 atlassian.net 上，不是 Jira。
    expect(trackSourceOf("https://acme.atlassian.net/wiki/spaces/ENG/pages/42/Retry")).toMatchObject({ kind: "manual", externalKey: null });
    expect(trackSourceOf("https://www.notion.so/acme/Retry-policy-0123456789abcdef0123456789ABCDEF")).toMatchObject({
      kind: "notion", externalKey: "0123456789abcdef0123456789abcdef",
    });
    expect(trackSourceOf("https://acme.notion.site/01234567-89ab-cdef-0123-456789abcdef?pvs=4")).toMatchObject({
      kind: "notion", externalKey: "0123456789abcdef0123456789abcdef",
    });
    expect(trackSourceOf("https://github.com/acme/x/pull/7")).toEqual({ kind: "manual", url: "https://github.com/acme/x/pull/7", externalKey: null });
    expect(trackSourceOf(undefined)).toEqual({ kind: "manual", url: null, externalKey: null });
  });

  it("writes the source of the link it was given", async () => {
    const ethan = worker("Ethan's Claude Code");
    const { ticketId } = (await track(ethan, { title: "PROJ-123 retry", sourceUrl: "https://acme.atlassian.net/browse/PROJ-123" })).result as { ticketId: number };
    expect(ticketSources(db, ticketId)).toMatchObject([{ kind: "jira", externalKey: "PROJ-123", url: "https://acme.atlassian.net/browse/PROJ-123" }]);
  });

  it("claims and attaches the existing ticket when the link is already the source of one", async () => {
    const existing = createItem(db, { title: "PROJ-123 from the Jira pull", brief: "b", createdBy: "system" });
    addTicketSource(db, { itemId: existing, kind: "jira", externalKey: "PROJ-123" });
    setHandling(db, existing, { handling: "needs_user", reason: "要你定发版时间" });
    const before = itemCount();
    const ethan = worker("Ethan's Claude Code");
    const outcome = await track(ethan, { title: "retry", sourceUrl: "https://acme.atlassian.net/browse/PROJ-123", sessionId: "s1" });
    expect(outcome.result).toMatchObject({ ticketId: existing, created: false });
    expect(itemCount()).toBe(before);
    expect(ticketSources(db, existing)).toHaveLength(1);
    expect(getItem(db, existing)!.stage).toBe("active");
    expect(workerTicket(db, existing, ethan.bindingId).claim.sessions).toMatchObject([{ sessionId: "s1" }]);

    // 这次领取是新的领取：撤掉以前的处理方式判断（裁定 R31）。
    expect(judgment(existing)).toMatchObject({ handling: null, handling_reason: null });

    // 自己已经领着：只挂会话，不报错。
    const again = await track(ethan, { title: "retry", sourceUrl: "https://acme.atlassian.net/browse/PROJ-123", sessionId: "s2" });
    expect(again.result).toMatchObject({ ticketId: existing, created: false });
    expect(listRuns(db, existing)).toHaveLength(1);
    expect(workerTicket(db, existing, ethan.bindingId).claim.sessions.map((session) => session.sessionId)).toEqual(["s1", "s2"]);

    // 别的工人领着：拒绝，写着是谁。
    const nina = worker("Nina's Claude Code");
    expect(await refusal(track(nina, { title: "retry", sourceUrl: "https://acme.atlassian.net/browse/PROJ-123" })))
      .toMatchObject({ code: "unavailable", message: expect.stringContaining("Ethan's Claude Code") });
    expect(itemCount()).toBe(before);
  });

  it("refuses a link that is not https, a session url with a refused scheme, and a credential without the worker scope", async () => {
    const ethan = worker("Ethan's Claude Code");
    const before = itemCount();
    expect(await refusal(track(ethan, { title: "x", sourceUrl: "javascript:alert(1)" }))).toMatchObject({ code: "invalid_input" });
    expect(await refusal(track(ethan, { title: "x", sourceUrl: "file:///etc/passwd" }))).toMatchObject({ code: "invalid_input" });
    expect(await refusal(track(ethan, { title: "x", sessionUrl: "file:///tmp/session" }))).toMatchObject({ code: "invalid_input" });
    expect(await refusal(track(ethan, { title: "   " }))).toMatchObject({ code: "invalid_input" });
    expect(await refusal(track(ethan, { title: "x", extra: 1 }))).toMatchObject({ code: "invalid_input" });
    const page = worker("Mac web page", ["tickets:create"]);
    expect(await refusal(track(page, { title: "x" }))).toMatchObject({ code: "forbidden" });
    expect(await refusal(track({ kind: "user" }, { title: "x" }))).toMatchObject({ code: "forbidden" });
    expect(itemCount()).toBe(before);
  });

  it("is refused in paused mode and leaves no ticket behind", async () => {
    setExecutionMode(db, "paused");
    const before = itemCount();
    expect(await refusal(track(worker("Ethan's Claude Code"), { title: "x" }))).toMatchObject({ code: "unavailable" });
    expect(itemCount()).toBe(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ticket_sources").get()).toEqual({ n: 0 });
  });
});

describe("ticket.set_handling", () => {
  const ready = () => createItem(db, { title: "retry policy", brief: "b", createdBy: "user" });

  it("lets the user flip the handling, keeps the complexity, and writes the ledger", async () => {
    const itemId = ready();
    setHandling(db, itemId, { handling: "auto", reason: "Lead: read-only lookup", complexity: "simple" });
    const outcome = await runTicketAction(db, {
      itemId, action: "ticket.set_handling", input: { handling: "needs_user" }, reason: "I want to look at it myself", caller: { kind: "user" },
    });
    expect(outcome).toMatchObject({ authority: "user", by: { actor: "user" } });
    expect(judgment(itemId)).toMatchObject({ handling: "needs_user", handling_reason: "I want to look at it myself", complexity: "simple" });
    expect(decisions(itemId)).toEqual([expect.objectContaining({
      decision: "handling_set", from: "auto", to: "needs_user", reason: "I want to look at it myself", actor: "user",
    })]);
  });

  it("is user_direct: Lead gets a structured refusal and nothing is written", async () => {
    const itemId = ready();
    const listed = (await listTicketActions(db, itemId)).find((action) => action.id === "ticket.set_handling");
    expect(listed).toMatchObject({ permission: "user_direct", available: true });
    expect((await listLeadTicketActions(db, itemId, { turnId: null })).find((action) => action.id === "ticket.set_handling"))
      .toMatchObject({ lead: "user_direct", leadReady: false });
    const error = await refusal(runTicketAction(db, {
      itemId, action: "ticket.set_handling", input: { handling: "auto" }, reason: "用户说自动处理", caller: { kind: "lead", turnId: null },
    }));
    expect(error).toMatchObject({ code: "user_direct" });
    expect(judgment(itemId)).toMatchObject({ handling: null, handling_reason: null });
    expect(decisions(itemId)).toEqual([]);
    expect(await refusal(runTicketAction(db, { itemId, action: "ticket.set_handling", input: { handling: "auto" }, caller: worker("Ethan's Claude Code") })))
      .toMatchObject({ code: "forbidden" });
  });

  it("checks the input and refuses a finished ticket", async () => {
    const itemId = ready();
    expect(await refusal(runTicketAction(db, { itemId, action: "ticket.set_handling", input: { handling: "later" }, caller: { kind: "user" } })))
      .toMatchObject({ code: "invalid_input" });
    transition(db, { itemId, to: "cancelled", actor: "user", reason: "not needed" });
    expect(await refusal(runTicketAction(db, { itemId, action: "ticket.set_handling", input: { handling: "auto" }, caller: { kind: "user" } })))
      .toMatchObject({ code: "unavailable" });
  });
});
