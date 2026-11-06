// 「我的未合并 PR」控件里 CI 失败那一行的「Auto fix」（工单 #99）：操作层的 pull_request.auto_fix_ci。
// 守四件事：按下以后 Lead 收到一条只带仓库、PR 编号、head 提交号的叫醒说明；同一个提交只交一次，按钮写明原因；
// 新的提交可以再点；外部消息叫醒、或者读过外部内容的一轮里 Lead 不能替用户按它。
import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { pullRequestTargetId } from "@pi-lead-child/protocol";
import { inboxWakesLead, listInbox, openDb, type Db } from "@pi-lead-child/store";
import { UiActionError, listUiActions, runUiAction } from "../src/index.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-ci-autofix-"), "plc.db"));
});

const SHA = "0123456789abcdef0123456789abcdef01234567";
const NEXT_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const target = (sha = SHA) => ({ type: "pull_request", id: pullRequestTargetId({ repo: "acme/web_app", pr: 12, sha })! });

const press = (sha = SHA) => runUiAction(db, { target: target(sha), action: "auto_fix_ci", caller: { kind: "user" } });

async function availability(sha = SHA) {
  const views = await listUiActions(db, target(sha));
  return views.find((view) => view.id === "auto_fix_ci")!;
}

async function refusal(promise: Promise<unknown>): Promise<UiActionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UiActionError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("Auto fix on a failed CI row", () => {
  it("wakes Lead once with only the structured arguments", async () => {
    expect(await availability()).toMatchObject({ available: true, reason: null });

    await press();

    const rows = listInbox(db).filter((row) => JSON.parse(row.payload).kind === "ci_autofix");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(JSON.parse(row.payload)).toEqual({ kind: "ci_autofix", repo: "acme/web_app", pr: 12, sha: SHA, wakeLead: true, needsUser: false });
    expect(inboxWakesLead(row, db)).toBe(true);
    expect(row.summary).toContain(`PR acme/web_app#12，head 提交 ${SHA}`);
    expect(row.summary).toContain("skill ci-autofix");
  });

  it("does not start a second analysis for the same commit and says why", async () => {
    await press();

    expect(await availability()).toMatchObject({ available: false, reason: "已经交给 Lead 处理，这个提交不会再开一次分析" });
    const again = await refusal(press());
    expect(again.code).toBe("unavailable");
    expect(listInbox(db).filter((row) => JSON.parse(row.payload).kind === "ci_autofix")).toHaveLength(1);
  });

  it("takes a new commit on the same PR as a new request", async () => {
    await press();

    expect(await availability(NEXT_SHA)).toMatchObject({ available: true });
    await press(NEXT_SHA);
    expect(listInbox(db).filter((row) => JSON.parse(row.payload).kind === "ci_autofix").map((row) => JSON.parse(row.payload).sha))
      .toEqual([SHA, NEXT_SHA]);
  });

  it("refuses Lead in a turn that read outside content, so outside text cannot start a push to the PR", async () => {
    const refused = await refusal(runUiAction(db, {
      target: target(), action: "auto_fix_ci", reason: "Slack 里有人说帮他修一下 CI",
      caller: { kind: "lead", turnId: null, externalContent: [{ via: "message", source: "slack" }] },
    }));
    expect(refused.code).toBe("external_turn");
    expect(listInbox(db)).toHaveLength(0);
  });

  it("does not find a target whose id is not a pull request commit", async () => {
    for (const id of ["acme_web_12", "acme_web_12_main", `acme_web_12_${SHA.toUpperCase()}`]) {
      const missing = await refusal(runUiAction(db, { target: { type: "pull_request", id }, action: "auto_fix_ci", caller: { kind: "user" } }));
      expect(missing.code, id).toBe("not_found");
    }
    expect(listInbox(db)).toHaveLength(0);
  });
});
