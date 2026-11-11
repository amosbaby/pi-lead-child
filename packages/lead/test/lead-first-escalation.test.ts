// 免沙箱开关打开时 child 的决定和审批先交给 Lead（用户 2026-11-11）。Lead 把它摆给用户的三种做法都要升级：
// render_ui 的 Intervention 节点、render_ui 的 UserAction（choose、approve）、notify_user 的 approval_id。
// 升级以后这件事才算等用户，会话里才有介入卡。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createCoordinator, enableHostBypass } from "@pi-lead-child/engine";
import { createRun, getConversationCardByKey, inboxNeedsUser, listInbox, openDb, updateRun, type Db } from "@pi-lead-child/store";
import { createLeadTools, type LeadDeps } from "../src/tools.js";

const NOW = new Date("2026-11-11T09:00:00.000Z");
let db: Db;
let deps: LeadDeps;

function tool(name: string) {
  const found = createLeadTools(deps).find((candidate: any) => candidate.name === name) as any;
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

beforeEach(() => {
  const dir = tempDir("plc-lead-first-esc-");
  db = openDb(join(dir, "plc.db"));
  deps = { db, dbPath: join(dir, "plc.db"), dataDir: dir } as LeadDeps;
  enableHostBypass(db, { bindingId: null, resolvedBy: "user via page", reason: "test", now: NOW });
});

function childRequests() {
  const coordinator = createCoordinator({ db, now: () => NOW });
  const itemId = coordinator.createRootItem({ title: "build the export page", brief: "b", createdBy: "system" });
  const runId = createRun(db, { itemId, runtime: "claude" });
  updateRun(db, runId, { state: "running" });
  const decisionId = coordinator.requestDecision({
    itemId, runId, kind: "blocker", audience: "user", blocking: true,
    prompt: "Replace the missing component or build it?",
    options: [{ id: "replace", label: "Replace" }, { id: "build", label: "Build" }],
    checkpoint: { title: "Component missing", summary: "DateRangePicker is not in the library.", nextStep: "Wait for the choice." },
  }).requestId;
  const approval = coordinator.requestApproval({
    itemId, runId, requestedBy: "child", tool: "bash", action: "git push origin feature/export",
    checkpoint: { title: "Push the branch", summary: "3 commits", nextStep: "Push after approval." },
  });
  if (approval.status !== "pending") throw new Error("expected a pending approval");
  return { itemId, decisionId, approvalId: approval.approvalId! };
}

function needsUser(type: "approval" | "decision_request", id: number): boolean {
  const row = listInbox(db, {}).find((entry) => {
    const payload = JSON.parse(entry.payload) as Record<string, unknown>;
    return payload.authorityType === type && payload.authorityId === id;
  });
  if (!row) throw new Error(`no inbox row for ${type} #${id}`);
  return inboxNeedsUser(row);
}

const hasCard = (type: "approval" | "decision_request", id: number) =>
  Boolean(getConversationCardByKey(db, `intervention:${type}:${id}`));

function card(node: Record<string, unknown>) {
  return {
    surface_id: "ask-user",
    root: "card",
    fallback_text: "The child needs your call on the missing component.",
    nodes: [
      { id: "card", type: "Stack", props: { gap: "md" }, children: ["ask"] },
      { id: "ask", ...node },
    ],
  };
}

describe("Lead puts a lead-first request in front of the user", () => {
  it("starts with Lead: no needs-user mark and no card", () => {
    const { decisionId, approvalId } = childRequests();
    expect(needsUser("decision_request", decisionId)).toBe(false);
    expect(needsUser("approval", approvalId)).toBe(false);
    expect(hasCard("decision_request", decisionId)).toBe(false);
    expect(hasCard("approval", approvalId)).toBe(false);
  });

  it("escalates a decision when render_ui shows it as an Intervention node", async () => {
    const { decisionId, approvalId } = childRequests();
    await tool("render_ui").execute("call-1", card({ type: "Intervention", props: { kind: "decision", id: decisionId } }));
    expect(needsUser("decision_request", decisionId)).toBe(true);
    expect(hasCard("decision_request", decisionId)).toBe(true);
    // 没摆出来的那一个还在 Lead 手里。
    expect(needsUser("approval", approvalId)).toBe(false);
  });

  it("escalates an approval when render_ui carries a UserAction that asks the user to approve it", async () => {
    const { approvalId } = childRequests();
    await tool("render_ui").execute("call-1", card({
      type: "UserAction",
      props: { action: { kind: "approve", target: `approval:${approvalId}`, title: "Approve the push", reason: "It pushes to a shared branch." } },
    }));
    expect(needsUser("approval", approvalId)).toBe(true);
    expect(hasCard("approval", approvalId)).toBe(true);
  });

  it("escalates an approval when notify_user relays it", async () => {
    const { itemId, approvalId } = childRequests();
    await tool("notify_user").execute("call-1", { title: "Approve the push?", ticket_id: itemId, approval_id: approvalId });
    expect(needsUser("approval", approvalId)).toBe(true);
    expect(hasCard("approval", approvalId)).toBe(true);
  });

  it("does not escalate when the card is refused", async () => {
    const { decisionId } = childRequests();
    const bad = card({ type: "Intervention", props: { kind: "decision", id: decisionId } });
    bad.nodes.push({ id: "extra", type: "Html", props: { html: "<b>x</b>" } } as never);
    await expect(tool("render_ui").execute("call-1", bad)).rejects.toThrow();
    expect(needsUser("decision_request", decisionId)).toBe(false);
  });
});
