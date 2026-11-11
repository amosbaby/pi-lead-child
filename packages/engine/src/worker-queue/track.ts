// 外部工人从自己的会话建单（.scratch/external-worker-hub/spec.md P1-5 的 track，protocol 的 WorkerTrackInputSchema）：
// 用户自己开的 Claude Code 会话一句话挂进台账。一笔事务：建单、记来源、领取（外部 Run）、挂会话；哪一步被拒都什么都不留。
// - 来源按链接认（ticket-sources.ts 的 trackSourceOf）；没有链接是 manual。同一个 Jira 单、Notion 页已经是一张工单的来源时
//   （store 的 addTicketSource 按 (kind, external_key) 去重）不再建单：领那张单、挂会话；自己已经领着时只挂会话。
// - 建的单算用户自己的（created_by=user，external_origin=0）：工人是用户自己配对的，会话是用户自己开的。
import type { WorkerSession } from "@pi-lead-child/protocol";
import { addActivity, addTicketSource, createItem, findItemByExternalKey, getItem, type Db, type TicketSourceKind } from "@pi-lead-child/store";
import { TicketActionError } from "../ticket-actions/types.js";
import { trackSourceOf } from "../ticket-sources.js";
import { attachSession, claimTicket, openWorkerClaim, sessionUrlBlocker } from "./claim.js";

export interface TrackTicketInput {
  bindingId: number;
  workerName: string;
  title: string;
  sourceUrl?: string;
  note?: string;
  sessionUrl?: string;
  sessionId?: string;
  liveItemIds?: readonly number[];
  now?: Date;
}

export interface TrackTicketResult {
  ticketId: number;
  runId: number;
  // 新建的单为 true；链接已经是一张工单的来源、领的是那张单时为 false。
  created: boolean;
  source: { kind: TicketSourceKind; url: string | null; externalKey: string | null };
  sessions: WorkerSession[];
}

export const WORKER_TRACKED_DECISION = "worker_tracked";

export function trackTicket(db: Db, input: TrackTicketInput): TrackTicketResult {
  const title = input.title.trim();
  if (!title) throw new TicketActionError("invalid_input", "worker.track：title 不能是空的。");
  const source = trackSourceOf(input.sourceUrl);
  const urlBlocker = input.sessionUrl === undefined ? null : sessionUrlBlocker(input.sessionUrl);
  if (urlBlocker) throw new TicketActionError("invalid_input", urlBlocker);
  const live = input.liveItemIds ? { liveItemIds: input.liveItemIds } : {};
  return db.transaction((): TrackTicketResult => {
    const existing = source.externalKey === null ? null : findItemByExternalKey(db, source.kind, source.externalKey);
    let ticketId: number;
    let runId: number;
    if (existing !== null) {
      if (!getItem(db, existing)) throw new TicketActionError("not_found", `工单 #${existing} 不存在`);
      ticketId = existing;
      const mine = openWorkerClaim(db, existing);
      runId = mine && mine.bindingId === input.bindingId
        ? mine.runId
        : claimTicket(db, { itemId: existing, bindingId: input.bindingId, workerName: input.workerName, ...live }).runId;
    } else {
      const brief = input.note?.trim() || `外部工人 ${input.workerName} 从自己的会话建的单，没有写说明。`;
      ticketId = createItem(db, { title, brief, createdBy: "user", externalOrigin: false });
      addTicketSource(db, {
        itemId: ticketId, kind: source.kind, url: source.url, externalKey: source.externalKey, ...(input.now ? { now: input.now } : {}),
      });
      addActivity(db, {
        itemId: ticketId, actor: "system", kind: "decision",
        payload: {
          decision: WORKER_TRACKED_DECISION, bindingId: input.bindingId, workerName: input.workerName,
          sourceKind: source.kind, sourceUrl: source.url, externalKey: source.externalKey,
        },
      });
      runId = claimTicket(db, { itemId: ticketId, bindingId: input.bindingId, workerName: input.workerName, ...live }).runId;
    }
    let sessions = openWorkerClaim(db, ticketId)?.sessions ?? [];
    if (input.sessionUrl !== undefined || input.sessionId !== undefined) {
      sessions = attachSession(db, {
        itemId: ticketId, bindingId: input.bindingId, workerName: input.workerName,
        ...(input.sessionUrl !== undefined ? { url: input.sessionUrl } : {}),
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(input.now ? { now: input.now } : {}),
      }).sessions;
    }
    return { ticketId, runId, created: existing === null, source, sessions };
  }).immediate();
}
