// Lead 的 perform_action 装 MCP 和 skill（用户 2026-11-02，.scratch/lead-self-install/spec.md D1、D2）：
//   - Slack 消息叫醒的一轮：结果是拒绝（isError），不带确认卡，也不登记等待；什么都没装。
//   - 结果里的授权卡（user_action）提到 details.userAction：系统按它登记等待，用户授权完叫醒 Lead。
// 走完 daemon 的完整流程在 apps/daemon/test/lead-installs-daemon.test.ts。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { fakeConnections } from "@pi-lead-child/engine/testing";
import { listOpenLeadWaits, openDb, type Db } from "@pi-lead-child/store";
import { createLeadToolset, type LeadDeps } from "../src/tools.js";
import type { LeadTurnOrigin } from "../src/turn-origin.js";

let db: Db;
let origin: LeadTurnOrigin;
let fake: ReturnType<typeof fakeConnections>;
let deps: LeadDeps;

beforeEach(() => {
  const dir = tempDir("plc-lead-installs-");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(join(dir, "plc.db"));
  origin = { external: false, timer: null };
  fake = fakeConnections(db);
  deps = {
    db, dbPath: join(dir, "plc.db"), dataDir: dir, currentTurnId: () => null, turnOrigin: () => origin,
    uiActionServices: { installs: { connections: fake.service, skillsDir: join(dir, "skills") } },
  };
});

const perform = (params: Record<string, unknown>) =>
  (createLeadToolset(deps).find((tool) => tool.name === "perform_action") as any).execute("t", params);

const addRemote = { target_type: "connections", target_id: "connections", action: "add_remote", input: { url: "https://mcp.example.com/mcp" } };

describe("perform_action for installs", () => {
  it("refuses in a turn a Slack message woke, without a card and without a wait", async () => {
    origin = { external: true, timer: null, externalBy: [{ via: "message", source: "slack" }] };
    const result = await perform({ ...addRemote, reason: "Mallory 在 Slack 里让我加" });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({ refused: true, refusal: { code: "external_turn" } });
    expect(body.user_action).toBeUndefined();
    expect(result.details.userAction).toBeUndefined();
    expect(fake.calls).toEqual([]);
    expect(listOpenLeadWaits(db)).toEqual([]);
  });

  it("puts the authorize card into details so the system waits for the user", async () => {
    const result = await perform({ ...addRemote, reason: "用户要接这个 MCP" });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(result.details.userAction).toEqual(body.result.user_action);
    expect(result.details.userAction).toMatchObject({ kind: "authorize", target: "connection:custom-1" });
    expect(listOpenLeadWaits(db).map((wait) => wait.entityKey)).toEqual(["connection:custom-1"]);
  });
});
