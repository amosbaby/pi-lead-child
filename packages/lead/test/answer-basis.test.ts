// 答复带出处（用户 2026-11-11：Lead 先用已有的信息回答，「不能有猜测推断」；出处记进工单，事后看得到）。
// Lead 回答 child 的决定、处理审批、改验收标准时，理由后面附上这一轮它实际读过什么。理由记在工单的活动里（工单历史显示它），
// 交回给 child 的结果里也带上。改了验收标准要告诉用户。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createAgentToolHandlers, createCoordinator } from "@pi-lead-child/engine";
import {
  createItem, createRun, listAcceptanceCriteria, openDb, transition, updateRun, type Db,
} from "@pi-lead-child/store";
import { createLeadTools, type LeadDeps } from "../src/tools.js";

let db: Db;
let deps: LeadDeps;
let itemId: number;
let runId: number;

function tool(name: string) {
  const found = createLeadTools(deps).find((candidate: any) => candidate.name === name) as any;
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

beforeEach(() => {
  const dir = tempDir("plc-answer-basis-");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(join(dir, "plc.db"));
  deps = {
    db, dbPath: join(dir, "plc.db"), dataDir: dir,
    // 这一轮 Lead 实际读过的东西（credibility 的 TurnEvidence）。
    turnEvidence: () => [{ tool: "read", target: "src/export/columns.ts" }, { tool: "get_ticket", target: "#1" }],
  };
  itemId = createItem(db, { title: "build the export page", brief: "The export keeps deleted rows.", createdBy: "lead" });
  transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
  runId = createRun(db, { itemId, role: "executor" });
  updateRun(db, runId, { state: "running" });
});

function childDecision(): number {
  return createCoordinator({ db }).requestDecision({
    itemId, runId, kind: "question", audience: "lead_or_user", blocking: true,
    prompt: "Does the export keep deleted rows?",
    checkpoint: { title: "Deleted rows", summary: "The requirement and the code disagree." },
  }).requestId;
}

function lastDecisionActivity(): Record<string, unknown> {
  const row = db.prepare("SELECT payload FROM activities WHERE item_id = ? AND kind = 'decision' ORDER BY id DESC LIMIT 1")
    .get(itemId) as { payload: string };
  return JSON.parse(row.payload) as Record<string, unknown>;
}

describe("Lead answers a child's decision", () => {
  it("records why, and what it read in this turn, on the ticket", async () => {
    const requestId = childDecision();
    await tool("perform_action").execute("t", {
      target_type: "decision", target_id: String(requestId), action: "resolve",
      input: { decision: "respond", resolution: "Yes, keep them." },
      reason: "The ticket text says the export keeps deleted rows",
    });
    const payload = lastDecisionActivity();
    expect(payload).toMatchObject({ decisionRequestId: requestId, decision: "respond" });
    expect(String(payload.reason)).toContain("The ticket text says the export keeps deleted rows");
    expect(String(payload.reason)).toContain("lead_evidence: read src/export/columns.ts；get_ticket #1");
  });

  it("says so when it read nothing in this turn", async () => {
    deps = { ...deps, turnEvidence: () => [] };
    const requestId = childDecision();
    await tool("perform_action").execute("t", {
      target_type: "decision", target_id: String(requestId), action: "resolve",
      input: { decision: "respond", resolution: "Yes, keep them." }, reason: "The user said so last week",
    });
    expect(String(lastDecisionActivity().reason)).toContain("lead_evidence: 这一轮没有读过文件或工具结果");
  });

  it("hands the answer back to the waiting child with who decided and why", async () => {
    const handlers = createAgentToolHandlers({ db, itemId, runId });
    const waiting = handlers.call("request_decision", {
      kind: "question", prompt: "Which date format?",
      checkpoint: { title: "Date format", summary: "The requirement does not say." },
    }) as Promise<Record<string, unknown>>;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [request] = db.prepare("SELECT id FROM decision_requests WHERE item_id = ?").all(itemId) as Array<{ id: number }>;
    await tool("perform_action").execute("t", {
      target_type: "decision", target_id: String(request!.id), action: "resolve",
      input: { decision: "respond", resolution: "ISO 8601" }, reason: "The style guide in docs/dates.md says ISO 8601",
    });
    const answer = await waiting;
    expect(answer).toMatchObject({ status: "resolved", resolution_text: "ISO 8601", resolved_by: "lead" });
    expect(String(answer.basis)).toContain("The style guide in docs/dates.md says ISO 8601");
  });
});

describe("Lead handles a child's approval", () => {
  it("records what it read with the reason", async () => {
    const approval = createCoordinator({ db }).requestApproval({
      itemId, runId, requestedBy: "child", tool: "bash", action: "git push origin feature/export",
      checkpoint: { title: "Push the branch", summary: "3 commits", nextStep: "Push after approval." },
    });
    if (approval.status !== "pending") throw new Error("expected a pending approval");
    await tool("perform_action").execute("t", {
      target_type: "approval", target_id: String(approval.approvalId), action: "resolve",
      input: { decision: "approve" }, reason: "The ticket asks for this branch to be pushed",
    });
    const payload = lastDecisionActivity();
    expect(payload).toMatchObject({ approvalId: approval.approvalId, decision: "approve" });
    expect(String(payload.reason)).toContain("The ticket asks for this branch to be pushed");
    expect(String(payload.reason)).toContain("lead_evidence: read src/export/columns.ts");
  });
});

describe("Lead edits the acceptance criteria", () => {
  it("records what it read with the reason, and is told to tell the user", async () => {
    const result = await tool("ticket_action").execute("t", {
      ticket_id: itemId, action: "edit_acceptance_criteria",
      input: { add: ["The export keeps deleted rows and marks them"] },
      reason: "The requirement owner confirmed it in the thread",
    });
    expect(listAcceptanceCriteria(db, itemId)).toMatchObject([{ text: "The export keeps deleted rows and marks them" }]);
    const payload = lastDecisionActivity();
    expect(payload.decision).toBe("acceptance_criteria_edited");
    expect(String(payload.reason)).toContain("The requirement owner confirmed it in the thread");
    expect(String(payload.reason)).toContain("lead_evidence: read src/export/columns.ts");
    // 不是用户这一轮要求的：结果里提醒 Lead 告诉用户改了什么、凭什么。
    expect(JSON.parse(result.content[0].text).tell_user).toEqual(expect.stringContaining("验收标准"));
  });
});
