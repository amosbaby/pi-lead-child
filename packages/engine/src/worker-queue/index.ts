// 外部工人的待领队列（.scratch/external-worker-hub/spec.md P1-2、P1-4、P1-5、P1-6）：领单和回写的业务规则全在这里。
// 工单操作层（ticket-actions/worker.ts）只做声明和转调；HTTP MCP（gateway 的 worker-mcp.ts）经 runTicketAction 调它们。
export {
  attachSession, claimBlocker, claimTicket, holdMessageForWorker, latestWorkerClaim, openWorkerClaim, ownClaimBlocker, reportOnTicket,
  requireOwnClaim, sessionUrlBlocker, WORKER_CLAIMED_ROUTE, WORKER_REPORT_ROUTE, WorkerClaimedError,
  type AttachSessionInput, type ClaimTicketInput, type ClaimTicketResult, type ReportInput, type WorkerClaim,
} from "./claim.js";
export {
  completeTicket, handBackTicket, releaseBlocker, releaseTicket, writeBackBlocker,
  type CompleteTicketInput, type CompleteTicketResult, type HandBackInput,
} from "./complete.js";
export {
  closeOutAnsweredTicket, onCardDisposed, REPLIED_IN_SOURCE_DECISION, settleDeferredLookups, type CardDisposal, type TicketCloseout,
} from "./closeout.js";
export { releaseBindingClaims, revokeBindingReleasingClaims, type ReleasedClaim } from "./revoke.js";
export { trackTicket, WORKER_TRACKED_DECISION, type TrackTicketInput, type TrackTicketResult } from "./track.js";
export { listTickets, ticketNeedsMe, workerTicket, type WorkerNote, type WorkerTicketGrant, type WorkerTicketRow, type WorkerTicketView } from "./read.js";
export { effectiveTicketSources, ticketLinks, ticketMeta } from "./links.js";
export {
  createTicketPusher, ensureTicketPushBaseline, syncTicketPush, TICKET_PUSH_RECENT_MS, ticketPushesToSync, ticketPushState, ticketsToPush,
  type TicketPushOptions, type TicketPushReason, type TicketPusher, type TicketPusherDeps, type TicketPushSlack, type TicketPushState,
} from "./pushes.js";
