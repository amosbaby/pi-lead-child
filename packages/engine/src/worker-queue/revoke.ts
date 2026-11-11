// 撤销外部工人的凭证时放掉它领着的单（spec P1-5）：每张被这个凭证领着的单，外部 Run 关掉（stopped），工单回到 ready，
// 和 ticket.release 是同一个函数（releaseTicket）。调用方在同一个事务里撤销凭证（ui-actions 的 device.revoke，
// 网关的「不是我」）：放掉一半就失败时，凭证也不会被撤销，重试一次就行。
import { EXTERNAL_RUNTIME_ID } from "@pi-lead-child/protocol";
import { itemUpdatedEvent, publishGatewayEvent, revokeBinding, runUpdatedEvent, type Db } from "@pi-lead-child/store";
import type { ActionAttribution } from "../ticket-actions/attribution.js";
import { openWorkerClaim } from "./claim.js";
import { releaseTicket } from "./complete.js";

export interface ReleasedClaim {
  ticketId: number;
  runId: number;
  stage: string;
}

/** 放掉 bindingId 领着的所有单。这个凭证没有领着什么（或者不是工人）时返回空数组，什么也不写。 */
export function releaseBindingClaims(db: Db, bindingId: number, by: ActionAttribution): ReleasedClaim[] {
  return db.transaction((): ReleasedClaim[] => {
    // metadata 在 JS 里解析（parseMetadata 容忍坏 JSON），不在 SQL 里 json_extract：一行坏数据不能让撤销失败。
    const itemIds = db.prepare(
      "SELECT DISTINCT item_id FROM runs WHERE runtime = ? AND state IN ('starting','running') ORDER BY item_id",
    ).all(EXTERNAL_RUNTIME_ID).map((row) => (row as { item_id: number }).item_id);
    const released: ReleasedClaim[] = [];
    for (const itemId of itemIds) {
      if (openWorkerClaim(db, itemId)?.bindingId !== bindingId) continue;
      released.push(releaseTicket(db, { itemId, by, reason: `the worker's credential (binding #${bindingId}) was revoked` }));
    }
    return released;
  }).immediate();
}

/**
 * 撤销一个凭证（binding）。它是外部工人时，领着的单先放掉；放掉和撤销在一个事务里。放掉了单就发事件，页面马上看到工单回到 ready。
 * 设置里的撤销（device.revoke）和「不是我」都走这里：两个入口撤销的是同一种凭证。
 */
export function revokeBindingReleasingClaims(db: Db, bindingId: number, by: ActionAttribution): ReleasedClaim[] {
  const released = db.transaction((): ReleasedClaim[] => {
    const claims = releaseBindingClaims(db, bindingId, by);
    revokeBinding(db, bindingId);
    return claims;
  }).immediate();
  for (const claim of released) {
    publishGatewayEvent(db, runUpdatedEvent(claim.ticketId, claim.runId));
    publishGatewayEvent(db, itemUpdatedEvent(claim.ticketId));
  }
  return released;
}
