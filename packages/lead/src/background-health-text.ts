// 后台任务健康事件给 Lead 的文字（.scratch/background-models spec D3）。写入方是 engine 的 background-health.ts：
//   · system.background_failing（tell）：单独一轮交给 Lead。写明什么失败了、从什么时候起、系统已经做了什么、Lead 能做什么，
//     以及折进这一条的其他任务；
//   · system.background_recovered（record）：只在当前局面里记一句。
// 原因的原话写入时脱敏、截断过，这里再截一次。
import { localIso } from "@pi-lead-child/core";
import { redactAndCap } from "@pi-lead-child/protocol";

const JOB_LABELS: Record<string, string> = {
  background_model: "后台模型（分诊判断、压缩摘要这类不在你回合里的模型调用）",
  channel_memory: "通道记忆（从对话里整理记忆）",
  hindsight: "Hindsight 记忆",
};

const REASON_MAX = 300;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function capped(value: string, limit: number): string {
  const result = redactAndCap(value.replace(/\s+/gu, " "), limit);
  return result.truncated ? `${result.text}…` : result.text;
}

/** 本地的「月-日 时:分」。 */
function when(iso: unknown): string {
  const at = new Date(text(iso));
  return Number.isNaN(at.getTime()) ? text(iso) || "未知时间" : localIso(at).slice(5, 16).replace("T", " ");
}

/** 一个后台任务给 Lead 看的名字。 */
export function backgroundJobLabel(job: string): string {
  return JOB_LABELS[job] ? `「${JOB_LABELS[job]}」（${job}）` : `「${job}」`;
}

// 操作名 target.action 对应的 perform_action 写法。
function operationHint(operation: string): string {
  const [target, action] = operation.split(".");
  if (operation === "background_model.set") {
    return "用 perform_action(target_type='background_model', action='set') 换一个后台模型。你只能选便宜的模型；"
      + "不给模型就是自动选第一个便宜的模型。";
  }
  return `用 perform_action(target_type='${target}', action='${action}')。`;
}

/** system.background_failing 的正文（不含事件头）。 */
export function backgroundFailingLines(payload: Record<string, unknown>): string[] {
  const job = text(payload.job);
  const failures = typeof payload.failures === "number" ? payload.failures : null;
  const lines = [
    `后台任务${backgroundJobLabel(job)}从 ${when(payload.since)} 起一直失败，转为失败`
      + `（${failures !== null ? `到现在失败了 ${failures} 次，` : ""}原因类别 ${text(payload.reasonClass) || "unknown"}）。`,
  ];
  const reason = text(payload.reason);
  if (reason) lines.push(`最近一次的原因：${capped(reason, REASON_MAX)}`);
  const action = text(payload.action);
  lines.push(action ? `系统已经做了：${capped(action, REASON_MAX)}` : "系统没有自动处理它。");
  const operation = text(payload.operation);
  lines.push(operation
    ? `你能做的：${operationHint(operation)}`
    : "你能做的：这件事没有你能直接用的操作。影响到用户时告诉他；他可以在 设置 → 模型 → 后台工作 看状态。");
  if (payload.afterHold === true) lines.push("它在模型暂停期间转为失败，暂停解除以后还在失败，所以现在才告诉你。");
  const folded = Array.isArray(payload.folded)
    ? payload.folded.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null) : [];
  if (folded.length) {
    lines.push(`另外还有 ${folded.length} 个后台任务也转为失败。这一小时叫醒你的次数用完了，所以合在这一条里说：`);
    for (const entry of folded) {
      const why = text(entry.reason);
      lines.push(`  - ${backgroundJobLabel(text(entry.job))}：原因类别 ${text(entry.reasonClass) || "unknown"}，从 ${when(entry.since)} 起`
        + `${why ? `；最近一次：${capped(why, 160)}` : ""}`);
    }
  }
  lines.push("它恢复以后，系统只在当前局面里记一句，不再叫醒你。同一个任务、同一类原因 6 小时内不会再为它叫醒你。");
  return lines;
}

/** system.background_recovered 在当前局面里的一句。 */
export function backgroundRecoveredNote(payload: Record<string, unknown>): string {
  const failures = typeof payload.failures === "number" ? `，失败了 ${payload.failures} 次` : "";
  return `后台任务${backgroundJobLabel(text(payload.job))}在 ${when(payload.recoveredAt)} 恢复了`
    + `（从 ${when(payload.since)} 起失败${failures}，原因类别 ${text(payload.reasonClass) || "unknown"}）`;
}
