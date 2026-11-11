// 外部工人的待领队列（.scratch/external-worker-hub/spec.md P1-2、P1-4、P1-5、P1-6）：领单和回写的业务规则全在这里。
// 工单操作层（ticket-actions/worker.ts）只做声明和转调；HTTP MCP（gateway 的 worker-routes.ts）经 runTicketAction 调它们。
export {
  attachSession, claimBlocker, claimTicket, latestWorkerClaim, openWorkerClaim, ownClaimBlocker, reportOnTicket, requireOwnClaim,
  sessionUrlBlocker, WORKER_REPORT_ROUTE,
  type AttachSessionInput, type ClaimTicketInput, type ClaimTicketResult, type ReportInput, type WorkerClaim,
} from "./claim.js";
export {
  completeTicket, handBackTicket, releaseBlocker, releaseTicket, writeBackBlocker,
  type CompleteTicketInput, type CompleteTicketResult, type HandBackInput,
} from "./complete.js";
export { listTickets, workerTicket, type WorkerNote, type WorkerTicketRow, type WorkerTicketView } from "./read.js";
