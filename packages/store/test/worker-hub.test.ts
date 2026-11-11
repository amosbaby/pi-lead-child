// 来源、判断和「没找到」记录的存储层（v68）。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  addConversationSource, addTicketSource, createItem, findItemByExternalKey, isExternalOrigin, missesSince, openDb, recordMiss,
  recordTicketOrigin, setExternalOrigin, setHandling, ticketSourceKindOf, ticketSources, type Db,
} from "../src/index.js";

function db(): Db {
  return openDb(join(tempDir("plc-worker-hub-"), "plc.db"));
}
const ticket = (d: Db, title = "t") => createItem(d, { title, brief: "b", createdBy: "lead" });

describe("ticket sources", () => {
  it("records a source and lists it with its position", () => {
    const d = db();
    const id = ticket(d);
    expect(addTicketSource(d, {
      itemId: id, kind: "jira", url: "https://jira.example.com/browse/PROJ-123", externalKey: "PROJ-123", now: new Date("2026-11-10T01:00:00.000Z"),
    })).toBe(id);
    expect(addTicketSource(d, { itemId: id, kind: "slack", conversation: "slack:C0TEAM:1730790000.000100", messageTs: "1730790000.000100" })).toBe(id);
    expect(ticketSources(d, id)).toEqual([
      expect.objectContaining({
        itemId: id, kind: "jira", url: "https://jira.example.com/browse/PROJ-123", externalKey: "PROJ-123", conversation: null, messageTs: null,
        createdAt: "2026-11-10T01:00:00.000Z",
      }),
      expect.objectContaining({ kind: "slack", url: null, externalKey: null, conversation: "slack:C0TEAM:1730790000.000100", messageTs: "1730790000.000100" }),
    ]);
    expect(ticketSources(d, id + 1000)).toEqual([]);
    d.close();
  });

  it("returns the existing item when the same Jira key comes again, and records nothing new", () => {
    const d = db();
    const first = ticket(d, "first");
    const second = ticket(d, "second");
    expect(addTicketSource(d, { itemId: first, kind: "jira", externalKey: "PROJ-123" })).toBe(first);
    expect(addTicketSource(d, { itemId: second, kind: "jira", externalKey: "PROJ-123", url: "https://jira.example.com/browse/PROJ-123" })).toBe(first);
    expect(ticketSources(d, second)).toEqual([]);
    expect(ticketSources(d, first)).toHaveLength(1);
    expect(findItemByExternalKey(d, "jira", "PROJ-123")).toBe(first);
    d.close();
  });

  it("keeps the same key apart across kinds, and does not dedupe sources without a key", () => {
    const d = db();
    const a = ticket(d, "a");
    const b = ticket(d, "b");
    expect(addTicketSource(d, { itemId: a, kind: "jira", externalKey: "X-1" })).toBe(a);
    expect(addTicketSource(d, { itemId: b, kind: "notion", externalKey: "X-1" })).toBe(b);
    expect(addTicketSource(d, { itemId: a, kind: "manual" })).toBe(a);
    expect(addTicketSource(d, { itemId: b, kind: "manual" })).toBe(b);
    expect(findItemByExternalKey(d, "notion", "X-1")).toBe(b);
    expect(findItemByExternalKey(d, "jira", "NOPE-1")).toBeNull();
    d.close();
  });

  it("refuses a kind outside the list, an empty key, and an item that does not exist", () => {
    const d = db();
    const id = ticket(d);
    expect(() => addTicketSource(d, { itemId: id, kind: "email" as never })).toThrow(/kind/);
    expect(() => addTicketSource(d, { itemId: id, kind: "jira", externalKey: "  " })).toThrow(/externalKey/);
    expect(() => addTicketSource(d, { itemId: 9999, kind: "jira", externalKey: "PROJ-9" })).toThrow(/FOREIGN KEY/);
    expect(findItemByExternalKey(d, "jira", "PROJ-9")).toBeNull();
    d.close();
  });
});

describe("sources written by the creation paths", () => {
  const at = new Date("2026-11-12T01:00:00.000Z");
  const origin = (d: Db, id: number) => (d.prepare("SELECT external_origin FROM items WHERE id=?").get(id) as { external_origin: number }).external_origin;

  it("records the owner DM of a ticket as a source once, the same shape as the v68 backfill", () => {
    const d = db();
    const id = ticket(d);
    expect(recordTicketOrigin(d, { itemId: id, conversation: "slack:D0SELF:main", now: at })).toBe(true);
    expect(recordTicketOrigin(d, { itemId: id, conversation: "slack:D0SELF:main", now: at })).toBe(false);
    expect(ticketSources(d, id)).toEqual([expect.objectContaining({
      kind: "slack", conversation: "slack:D0SELF:main", messageTs: null, url: null, externalKey: null, createdAt: at.toISOString(),
    })]);
    d.close();
  });

  it("maps a channel to a source kind by the kind list only", () => {
    expect(ticketSourceKindOf("slack")).toBe("slack");
    expect(ticketSourceKindOf("jira")).toBe("jira");
    expect(ticketSourceKindOf("webhook")).toBe("manual");
    expect(ticketSourceKindOf("manual")).toBe("manual");
  });

  it("writes one conversation source per position", () => {
    const d = db();
    const id = ticket(d);
    expect(addConversationSource(d, { itemId: id, kind: "slack", conversation: "slack:C0TEAM:main", messageTs: "1762934400.000100" })).toBe(true);
    expect(addConversationSource(d, { itemId: id, kind: "slack", conversation: "slack:C0TEAM:main", messageTs: "1762934400.000100" })).toBe(false);
    expect(addConversationSource(d, { itemId: id, kind: "slack", conversation: "slack:C0TEAM:main", messageTs: null })).toBe(true);
    expect(ticketSources(d, id)).toHaveLength(2);
    d.close();
  });

  it("creates a ticket with external_origin when asked, and sets it later without touching the lifecycle", () => {
    const d = db();
    const own = ticket(d);
    const outside = createItem(d, { title: "from Nina", brief: "b", createdBy: "lead", externalOrigin: true });
    expect([origin(d, own), origin(d, outside)]).toEqual([0, 1]);
    expect([isExternalOrigin(d, own), isExternalOrigin(d, outside), isExternalOrigin(d, null), isExternalOrigin(d, own + 1000)])
      .toEqual([false, true, false, false]);
    const before = d.prepare("SELECT stage, stage_changed_at FROM items WHERE id=?").get(own);
    setExternalOrigin(d, own, true);
    expect(origin(d, own)).toBe(1);
    setExternalOrigin(d, outside, false);
    expect(origin(d, outside)).toBe(0);
    expect(d.prepare("SELECT stage, stage_changed_at FROM items WHERE id=?").get(own)).toEqual(before);
    expect(() => setExternalOrigin(d, own + 1000, true)).toThrow();
    d.close();
  });
});

describe("handling", () => {
  it("writes the judgment, replaces it on a second call, and leaves the lifecycle alone", () => {
    const d = db();
    const id = ticket(d);
    const before = d.prepare("SELECT stage, stage_changed_at, closed_at FROM items WHERE id = ?").get(id);
    setHandling(d, id, { handling: "auto", reason: "a plain lookup", complexity: "simple" });
    const read = () => d.prepare("SELECT handling, handling_reason, complexity, external_origin FROM items WHERE id = ?").get(id);
    expect(read()).toEqual({ handling: "auto", handling_reason: "a plain lookup", complexity: "simple", external_origin: 0 });
    setHandling(d, id, { handling: "needs_user", reason: "touches billing" });
    expect(read()).toEqual({ handling: "needs_user", handling_reason: "touches billing", complexity: null, external_origin: 0 });
    expect(d.prepare("SELECT stage, stage_changed_at, closed_at FROM items WHERE id = ?").get(id)).toEqual(before);
    d.close();
  });

  it("refuses a missing item and an unknown value", () => {
    const d = db();
    const id = ticket(d);
    expect(() => setHandling(d, 9999, { handling: "auto", reason: "r" })).toThrow(/9999/);
    expect(() => setHandling(d, id, { handling: "maybe" as never, reason: "r" })).toThrow(/handling/);
    expect(() => setHandling(d, id, { handling: "auto", reason: "r", complexity: "huge" as never })).toThrow(/complexity/);
    d.close();
  });
});

describe("misses", () => {
  it("counts only the misses since the given time", () => {
    const d = db();
    recordMiss(d, "could not find the Jira ticket for the refund bug", new Date("2026-11-01T00:00:00.000Z"));
    recordMiss(d, "second", new Date("2026-11-08T00:00:00.000Z"));
    recordMiss(d, "third", new Date("2026-11-09T12:00:00.000Z"));
    expect(missesSince(d, new Date("2026-11-08T00:00:00.000Z"))).toBe(2);
    expect(missesSince(d, new Date("2026-11-10T00:00:00.000Z"))).toBe(0);
    expect(missesSince(d, new Date(0))).toBe(3);
    expect(() => recordMiss(d, "   ")).toThrow(/text/);
    d.close();
  });
});
