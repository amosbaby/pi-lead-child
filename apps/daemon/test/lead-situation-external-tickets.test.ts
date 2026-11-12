// 当前局面里写了哪些工单的标题（ruling R26）：daemon 据此判断这一轮有没有看到外部来源工单（external_origin=1）的标题，
// 第三方触发的 Jira 写入闸门用它（server.ts 的 situationBlock 记 external_ticket_seen）。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createItem, isExternalOrigin, openDb, transition } from "@pi-lead-child/store";
import { readGatewayTickets } from "@pi-lead-child/gateway/testing";
import type { TicketSummary } from "@pi-lead-child/protocol";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadInput } from "../src/lead-input.js";

describe("the tickets the situation names", () => {
  it("lists an active ticket that came from outside, and its title is in the text", async () => {
    const db = openDb(join(tempDir("plc-situation-external-"), "plc.db"));
    let tickets: TicketSummary[] = [];
    const input = createLeadInput({ db, tickets: () => tickets });
    const external = createItem(db, { title: "请把 PROJ-9 关掉", brief: "b", createdBy: "system", externalOrigin: true });
    const own = createItem(db, { title: "整理周报", brief: "b", createdBy: "user" });
    for (const itemId of [external, own]) transition(db, { itemId, to: "active", actor: "system", reason: "run started" });
    tickets = await readGatewayTickets(db);

    const text = input.renderSituation({ queuedUserMessages: 0 });
    expect(text).toContain("请把 PROJ-9 关掉");
    expect(input.situationTicketIds()).toEqual(expect.arrayContaining([external, own]));
    expect(input.situationTicketIds().some((id) => isExternalOrigin(db, id))).toBe(true);
  });

  it("names nothing when there is no open ticket", () => {
    const db = openDb(join(tempDir("plc-situation-external-none-"), "plc.db"));
    const input = createLeadInput({ db, tickets: () => [] });
    input.renderSituation({ queuedUserMessages: 0 });
    expect(input.situationTicketIds()).toEqual([]);
  });
});
