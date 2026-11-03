// Lead 动态里的「Lead 装了什么」（.scratch/lead-self-install/spec.md D7）：一条 lead_install.changed（digest 级）。
//   - Lead 装了远程 MCP、本地 MCP、skill 时写一条（actor lead）。卡上带「撤销」（ui-actions/card-actions.ts）。
//   - Lead 装的东西被撤销时（谁撤销都一样）再写一条，卡原地更新，按钮消失。
//   - 用户自己在页面上装、卸的不写：不是 Lead 做的事。
// 装、卸的动作（连接中心、写 skill 目录）不在库里，所以这条事件自己开一个事务；调用方已经在事务里时并进那一个。
import {
  LEAD_INSTALL_CHANGED_KIND, leadInstallEntityKey, redactSecretText,
  type LeadInstallChangedPayload, type LeadInstallKind,
} from "@pi-lead-child/protocol";
import { appendEvent, getLocale, latestEntityEvent, leadDisplayName, setEventDisposition, type Db, type EventRecord } from "@pi-lead-child/store";
import { installMessages } from "./installs.messages.js";

// 事件的分诊依据：硬性规则，常设指令改不了它（和 core_memory_change_reported 一样）。
export const LEAD_INSTALL_REPORTED = "lead_install_reported";

export type LeadInstallTarget = LeadInstallChangedPayload["target"];

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/gu, " ").trim().replace(/[。.]+$/u, "");
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** 这个对象最近一条「Lead 装了什么」。没有时为 null。 */
export function latestLeadInstall(db: Db, target: LeadInstallTarget): (EventRecord & { payload: LeadInstallChangedPayload }) | null {
  const event = latestEntityEvent(db, leadInstallEntityKey(target), LEAD_INSTALL_CHANGED_KIND);
  return event ? event as EventRecord & { payload: LeadInstallChangedPayload } : null;
}

/** 这个对象现在是不是 Lead 装的（最近一条是 Lead 的 installed）。 */
export function installedByLead(db: Db, target: LeadInstallTarget): boolean {
  const latest = latestLeadInstall(db, target);
  return latest?.payload.action === "installed" && latest.payload.actor === "lead";
}

function append(db: Db, payload: LeadInstallChangedPayload, now: Date): number {
  return db.transaction(() => appendOne(db, payload, now))();
}

function appendOne(db: Db, payload: LeadInstallChangedPayload, now: Date): number {
  const { event } = appendEvent(db, {
    source: payload.actor === "lead" ? "lead" : "system",
    kind: LEAD_INSTALL_CHANGED_KIND,
    entityKey: leadInstallEntityKey(payload.target),
    occurredAt: now.toISOString(),
    level: "digest",
    payload: payload as unknown as Record<string, unknown>,
  }, { basis: { order: null, hardRules: [LEAD_INSTALL_REPORTED] }, receivedAt: now });
  // Lead 自己做的事不用在下一份当前局面里再告诉它（daemon 的 leadEventRoute 也跳过它）。用户撤销 Lead 装的东西留给 Lead 看。
  if (payload.actor === "lead") setEventDisposition(db, event.seq, "seen", null, now);
  return event.seq;
}

export interface LeadInstalledReport {
  kind: LeadInstallKind;
  target: LeadInstallTarget;
  name: string;
  source: string;
  reason: string;
  // 读到的工具数（MCP）。不知道时不给。
  toolCount?: number;
  // skill 带的脚本（相对路径）。
  scripts?: readonly string[];
  // 远程 MCP 加上了、还在等用户授权。
  pendingAuthorization?: boolean;
}

/** Lead 装了一个能力：写一条 lead_install.changed，返回它的 seq。 */
export function reportLeadInstalled(db: Db, report: LeadInstalledReport, now = new Date()): number {
  const m = installMessages(getLocale(db));
  const who = { actor: "lead" as const, leadName: leadDisplayName(db) };
  const reason = clip(report.reason, 200);
  const summary = [
    m.installed(who, report.kind, report.name, report.source),
    report.pendingAuthorization ? m.pendingAuthorization(report.name) : "",
    report.toolCount !== undefined ? m.tools(report.toolCount) : "",
    report.scripts?.length ? m.scripts(report.scripts.slice(0, 10)) : "",
    reason ? m.basis(reason) : "",
  ].join("");
  return append(db, {
    kind: report.kind, action: "installed", actor: "lead", target: report.target, name: report.name, source: report.source,
    reason: redactSecretText(report.reason), summary: redactSecretText(summary),
    ...(report.pendingAuthorization ? { pendingAuthorization: true } : {}),
  }, now);
}

/**
 * 一个能力被撤销了。只有它是 Lead 装的（最近一条是 Lead 的 installed）时写一条，卡原地更新；别的不写，返回 null。
 */
export function reportLeadInstallRemoved(
  db: Db, input: { target: LeadInstallTarget; actor: "lead" | "user"; reason: string }, now = new Date(),
): number | null {
  const latest = latestLeadInstall(db, input.target);
  if (latest?.payload.action !== "installed" || latest.payload.actor !== "lead") return null;
  const m = installMessages(getLocale(db));
  const who = { actor: input.actor, leadName: leadDisplayName(db) };
  const reason = clip(input.reason, 200);
  const summary = `${m.removed(who, latest.payload.kind, latest.payload.name)}${input.actor === "lead" && reason ? m.basis(reason) : ""}`;
  return append(db, {
    kind: latest.payload.kind, action: "removed", actor: input.actor, target: input.target, name: latest.payload.name,
    source: latest.payload.source, reason: redactSecretText(input.reason), summary: redactSecretText(summary),
  }, now);
}
