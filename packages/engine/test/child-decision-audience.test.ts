// child 不选问谁（用户 2026-11-11：「子 agent 只在遇到不确定的决策的时候去问怎么决策，实际上它并不一定需要知道是问 slack 的
// 用户还是问 lead 还是问我」）。request_decision 没有 audience 参数；请求一律存成 Lead 和用户都能回答，问谁由 Lead 定。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createItem, createRun, getDecisionRequest, openDb, transition, updateRun, type Db } from "@pi-lead-child/store";
import { AGENT_TOOL_DEFINITIONS, createAgentToolHandlers } from "../src/agent-tools/definitions.js";

let db: Db;
let itemId: number;
let runId: number;

beforeEach(() => {
  db = openDb(join(tempDir("plc-child-audience-"), "plc.db"));
  itemId = createItem(db, { title: "build the export page", brief: "b", createdBy: "system" });
  transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
  runId = createRun(db, { itemId });
  updateRun(db, runId, { state: "running" });
});

const question = {
  kind: "question",
  blocking: false,
  prompt: "The requirement conflicts with the current export logic. Which one wins?",
  checkpoint: { title: "Requirement conflict", summary: "The export keeps deleted rows; the requirement drops them." },
};

describe("a child's decision request", () => {
  it("has no audience parameter: the child does not pick who answers", () => {
    const tool = AGENT_TOOL_DEFINITIONS.find((definition) => definition.name === "request_decision")!;
    const schema = tool.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties)).not.toContain("audience");
    expect(schema.required).toEqual(["kind", "prompt", "checkpoint"]);
  });

  it("is stored so that Lead and the user can both answer it", async () => {
    const handlers = createAgentToolHandlers({ db, itemId, runId });
    const asked = await handlers.call("request_decision", question) as { request_id: number };
    expect(getDecisionRequest(db, asked.request_id)).toMatchObject({ origin: "agent", audience: "lead_or_user", state: "pending" });
  });

  it("ignores an audience that an older prompt still sends, without failing the call", async () => {
    const handlers = createAgentToolHandlers({ db, itemId, runId });
    const asked = await handlers.call("request_decision", { ...question, audience: "user" }) as { request_id: number };
    expect(getDecisionRequest(db, asked.request_id)).toMatchObject({ audience: "lead_or_user" });
  });
});
