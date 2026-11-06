// 「我的未合并 PR」控件里 CI 失败那一行的「Auto fix」（用户 2026-11-06，工单 #99）。页面（POST /v1/actions/pull_request/<编号>/auto_fix_ci）
// 和 Lead（perform_action）调同一个定义。
//   - 按钮只带结构化的参数：仓库、PR 编号、head 提交号，都在目标编号里（protocol 的 pullRequestTargetId），没有任意文字。
//   - 做的事只有一件：往 Lead 的收件箱放一条叫醒 Lead 的说明，Lead 按 skill ci-autofix 的固定流程处理
//     （轻子 agent 分析，能修就修好推到 PR 的分支，修不了就建工单）。说明里只有这三个参数，没有 PR 标题这类外部文字。
//   - 同一个 PR 的同一个提交只交一次：收件箱里已经有这个提交的那一行时，按钮写「处理中」、停用，并写明原因。
//     推了新提交（head 变了）就是新的编号，可以再点。
//   - 不放宽外部内容的边界：外部消息叫醒、或者读过外部内容的一轮里，Lead 不能替用户按它（externalTurnFloor），
//     否则 Slack 里的一句话就能让 Lead 在之后不带外部内容的一轮里往用户的 PR 推代码。
import { parsePullRequestTargetId, type CiAutofixRef } from "@pi-lead-child/protocol";
import { addInbox, firstInboxOfScope } from "@pi-lead-child/store";
import { AVAILABLE, unavailable } from "../ticket-actions/types.js";
import { UiActionError, type UiActionDefinition, type UiActionRun, type UiActionTargetKind } from "./types.js";

const WHERE = "会话顶栏右边的「自定义视图」面板，「我的未合并 PR」控件里 CI 失败那一行的「Auto fix」";

export type PullRequestTarget = CiAutofixRef & {
  id: string;
  // 这个提交已经交给 Lead 的时间（收件箱那一行的 created_at，UTC）。没交过时为 null。
  requestedAt: string | null;
};

export const ciAutofixScope = (targetId: string) => `ci_autofix:${targetId}`;

export const PULL_REQUEST_TARGET: UiActionTargetKind<PullRequestTarget> = {
  type: "pull_request",
  label: "PR 的一个提交",
  idHint: "<owner>_<repo>_<PR 编号>_<head 的 40 位提交号>，例如 acme_web_12_0123…（控件的 Auto fix 按钮自带）",
  load: (env, id) => {
    const ref = parsePullRequestTargetId(id);
    if (!ref) return null;
    const row = firstInboxOfScope(env.db, ciAutofixScope(id));
    return { ...ref, id, requestedAt: row ? row.created_at : null };
  },
  name: (target) => `PR ${target.repo}#${target.pr}（提交 ${target.sha.slice(0, 7)}）`,
  describe: (target) => ({ repo: target.repo, pr: target.pr, sha: target.sha, requestedAt: target.requestedAt }),
};

function summaryFor(target: PullRequestTarget): string {
  return [
    `用户在「我的未合并 PR」控件上点了 Auto fix：PR ${target.repo}#${target.pr}，head 提交 ${target.sha}，CI 失败。`,
    "先读 skill ci-autofix，按里面的固定流程处理：派轻子 agent 分析 CI 失败的原因；能修就修好推到这个 PR 的分支；修不了就建一张完整的工单，写清原因。",
    "这个提交只交给你这一次，用户再点不会再叫醒你。",
  ].join("\n");
}

export const PULL_REQUEST_ACTIONS = {
  auto_fix_ci: {
    target: "pull_request", id: "auto_fix_ci", label: "Auto fix", scope: "chat",
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false,
    externalTurnFloor: "让 Lead 自动修 PR 的 CI 并往 PR 的分支推代码",
    where: WHERE,
    hint: "用户要你自动修一个 PR 的 CI 失败时用：交给你自己一条带仓库、PR 编号、head 提交号的说明，"
      + "之后按 skill ci-autofix 处理。同一个提交只能交一次。",
    defaultReason: "用户要自动修这个 PR 的 CI",
    available: (target: PullRequestTarget) => (target.requestedAt
      ? unavailable("已经交给 Lead 处理，这个提交不会再开一次分析")
      : AVAILABLE),
    run: (run: UiActionRun<PullRequestTarget, Record<string, never>>) => run.db.transaction(() => {
      // 两次点击挨得很近时，第二次在这里认出来（available 和 run 之间没有锁）。
      if (firstInboxOfScope(run.db, ciAutofixScope(run.target.id))) {
        throw new UiActionError("unavailable", "已经交给 Lead 处理，这个提交不会再开一次分析");
      }
      const added = addInbox(run.db, {
        dedupScope: ciAutofixScope(run.target.id), severity: "attention", source: "structural", lossless: true,
        summary: summaryFor(run.target),
        payload: {
          kind: "ci_autofix", repo: run.target.repo, pr: run.target.pr, sha: run.target.sha, wakeLead: true, needsUser: false,
        },
      });
      return { inbox: added.id, repo: run.target.repo, pr: run.target.pr, sha: run.target.sha };
    })(),
    forLead: (run) => ({
      result: "queued", repo: run.target.repo, pr: run.target.pr, sha: run.target.sha,
      next: "系统已经把这个提交交给你自己：收到那条说明时按 skill ci-autofix 处理。不用再告诉用户。",
    }),
    detail: (run) => ({ repo: run.target.repo, pr: run.target.pr, sha: run.target.sha }),
  },
} satisfies Record<string, UiActionDefinition<PullRequestTarget, any>>;
