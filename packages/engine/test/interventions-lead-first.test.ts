// 免沙箱开关打开时，child 的决定和审批先交给 Lead（用户 2026-11-11）：不先标「需要用户」，不先画介入卡。
// Lead 把它摆给用户（escalateInterventionToUser）以后才算等用户。开关关着时和以前一样。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { AGENT_TASK_STARTED } from "@pi-lead-child/protocol";
import {
  addActivity, createRun, getConversationCardByKey, inboxNeedsUser, inboxWakesLead, listInbox, openDb, updateRun,
  type Db,
} from "@pi-lead-child/store";
import { createCoordinator } from "../src/coordinator/service.js";
import { escalateInterventionToUser } from "../src/coordinator/interventions.js";
import { enableHostBypass } from "../src/host-bypass.js";

const NOW = new Date("2026-11-11T09:00:00.000Z");
let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-lead-first-"), "plc.db"));
});

function activeItem() {
  const coordinator = createCoordinator({ db, now: () => NOW });
  const itemId = coordinator.createRootItem({ title: "build the export page", brief: "authority", createdBy: "system" });
  const runId = createRun(db, { itemId, runtime: "claude" });
  updateRun(db, runId, { state: "running" });
  return { coordinator, itemId, runId };
}

function bypassOn() {
  enableHostBypass(db, { bindingId: null, resolvedBy: "user via page", reason: "test", now: NOW });
}

function authorityRow(type: "approval" | "decision_request", id: number) {
  const row = listInbox(db, {}).find((entry) => {
    const payload = JSON.parse(entry.payload) as Record<string, unknown>;
    return payload.authorityType === type && payload.authorityId === id;
  });
  if (!row) throw new Error(`no inbox row for ${type} #${id}`);
  return { row, payload: JSON.parse(row.payload) as Record<string, unknown> };
}

function askDecision(coordinator: ReturnType<typeof createCoordinator>, itemId: number, runId: number | null, origin?: "lead") {
  return coordinator.requestDecision({
    itemId, runId, kind: "blocker", audience: "user", blocking: true,
    ...(origin ? { origin } : {}),
    prompt: "The design uses a component the library does not have. Replace it or build it?",
    options: [{ id: "replace", label: "Replace" }, { id: "build", label: "Build" }],
    checkpoint: { title: "Component missing", summary: "DateRangePicker is not in the library.", nextStep: "Wait for the choice." },
  });
}

function askApproval(coordinator: ReturnType<typeof createCoordinator>, itemId: number, runId: number) {
  const result = coordinator.requestApproval({
    itemId, runId, requestedBy: "child", tool: "bash", action: "git push origin feature/export",
    checkpoint: { title: "Push the branch", summary: "3 commits", nextStep: "Push after approval." },
  });
  if (result.status !== "pending") throw new Error("expected a pending approval");
  return result;
}

describe("child interventions when the host-bypass switch is off", () => {
  it("marks a blocking decision as needing the user and draws the intervention card (unchanged)", () => {
    const { coordinator, itemId, runId } = activeItem();
    const { requestId } = askDecision(coordinator, itemId, runId);
    const { row, payload } = authorityRow("decision_request", requestId);
    expect(inboxNeedsUser(row)).toBe(true);
    expect(payload.leadFirst).toBeUndefined();
    expect(getConversationCardByKey(db, `intervention:decision_request:${requestId}`) ?? null).not.toBeNull();
  });

  it("does nothing when asked to escalate a request that never was lead-first", () => {
    const { coordinator, itemId, runId } = activeItem();
    const { requestId } = askDecision(coordinator, itemId, runId);
    expect(escalateInterventionToUser(db, { type: "decision_request", id: requestId, reason: "Lead sent a card", now: NOW })).toBe(false);
  });
});

describe("child interventions when the host-bypass switch is on", () => {
  it("hands a blocking decision to Lead first: no needs-user mark, no intervention card, Lead is woken", () => {
    bypassOn();
    const { coordinator, itemId, runId } = activeItem();
    const { requestId } = askDecision(coordinator, itemId, runId);
    const { row, payload } = authorityRow("decision_request", requestId);
    expect(inboxNeedsUser(row)).toBe(false);
    expect(inboxWakesLead(row, db)).toBe(true);
    expect(payload.leadFirst).toBe(true);
    expect(getConversationCardByKey(db, `intervention:decision_request:${requestId}`) ?? null).toBeNull();
  });

  it("hands an approval to Lead first", () => {
    bypassOn();
    const { coordinator, itemId, runId } = activeItem();
    const { approvalId } = askApproval(coordinator, itemId, runId);
    const { row, payload } = authorityRow("approval", approvalId!);
    expect(inboxNeedsUser(row)).toBe(false);
    expect(inboxWakesLead(row, db)).toBe(true);
    expect(payload.leadFirst).toBe(true);
    expect(getConversationCardByKey(db, `intervention:approval:${approvalId}`) ?? null).toBeNull();
  });

  it("keeps an approval of externally dispatched work with the user: Lead cannot approve it", () => {
    bypassOn();
    const { coordinator, itemId, runId } = activeItem();
    addActivity(db, {
      itemId, actor: "system", kind: "decision",
      payload: { decision: AGENT_TASK_STARTED, source: "slack", requester: "Nina" },
    });
    const { approvalId } = askApproval(coordinator, itemId, runId);
    const { row, payload } = authorityRow("approval", approvalId!);
    expect(inboxNeedsUser(row)).toBe(true);
    expect(payload.leadFirst).toBeUndefined();
    expect(getConversationCardByKey(db, `intervention:approval:${approvalId}`) ?? null).not.toBeNull();
  });

  it("leaves a decision that Lead itself asks the user unchanged", () => {
    bypassOn();
    const { coordinator, itemId } = activeItem();
    const { requestId } = askDecision(coordinator, itemId, null, "lead");
    const { row, payload } = authorityRow("decision_request", requestId);
    expect(inboxNeedsUser(row)).toBe(true);
    expect(inboxWakesLead(row, db)).toBe(false);
    expect(payload.leadFirst).toBeUndefined();
  });

  it("escalates once Lead puts the request in front of the user: needs-user mark and card appear, only once", () => {
    bypassOn();
    const { coordinator, itemId, runId } = activeItem();
    const { requestId } = askDecision(coordinator, itemId, runId);
    expect(escalateInterventionToUser(db, { type: "decision_request", id: requestId, reason: "Lead sent a card", now: NOW })).toBe(true);
    const { row, payload } = authorityRow("decision_request", requestId);
    expect(inboxNeedsUser(row)).toBe(true);
    expect(payload.escalationReason).toBe("Lead sent a card");
    expect(getConversationCardByKey(db, `intervention:decision_request:${requestId}`) ?? null).not.toBeNull();
    expect(escalateInterventionToUser(db, { type: "decision_request", id: requestId, reason: "again", now: NOW })).toBe(false);
  });

  // 启动修复要幂等、有界（AGENTS.md Core Invariants）：重启不能把还在 Lead 手里的请求变成用户面前的卡。
  it("startup repair does not draw a card for a request that is still with Lead", () => {
    bypassOn();
    const { coordinator, itemId, runId } = activeItem();
    const { requestId } = askDecision(coordinator, itemId, runId);
    const { approvalId } = askApproval(coordinator, itemId, runId);
    expect(coordinator.repairLegacyInterventions()).toEqual({ approvals: 0, decisions: 0 });
    expect(coordinator.repairLegacyInterventions()).toEqual({ approvals: 0, decisions: 0 });
    expect(getConversationCardByKey(db, `intervention:decision_request:${requestId}`) ?? null).toBeNull();
    expect(getConversationCardByKey(db, `intervention:approval:${approvalId}`) ?? null).toBeNull();
    expect(inboxNeedsUser(authorityRow("decision_request", requestId).row)).toBe(false);
  });

  it("does not draw the intervention card when Lead resolves a lead-first approval itself", () => {
    bypassOn();
    const { coordinator, itemId, runId } = activeItem();
    const { approvalId } = askApproval(coordinator, itemId, runId);
    coordinator.resolveApproval({
      approvalId: approvalId!, decision: "approve", actor: { kind: "lead", resolvedBy: "lead" }, reason: "the ticket asks for this push",
    });
    expect(getConversationCardByKey(db, `intervention:approval:${approvalId}`) ?? null).toBeNull();
  });
});
