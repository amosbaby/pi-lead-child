// Lead 能用的工具和操作（工具名，和界面操作的「对象.操作」），daemon 每次起来时和上一次记下的比（2026-11-02）。
// 15:46 的部署加了改 Slack 消息的操作，没有人告诉 Lead：它 15:58 还在笔记里写「没有编辑消息的权限」，之后照这条拒绝用户。
// 变了的，下一轮告诉它一次（server.ts 的 capabilityNotice）。
import type { Db } from "@pi-lead-child/store";

export const LEAD_CAPABILITIES_KEY = "lead.capabilities";
// 通知里每一类最多列这么多个，其余的写个数。
const LISTED = 30;

export interface LeadCapabilityChange {
  added: string[];
  removed: string[];
}

/** 记下这一次的清单，返回和上一次比多了、少了哪些。第一次记、上一次读不出来、或者没有变化时是 null。 */
export function recordLeadCapabilities(db: Db, current: readonly string[], now: Date = new Date()): LeadCapabilityChange | null {
  const names = [...new Set(current)].sort();
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(LEAD_CAPABILITIES_KEY) as { value: string } | undefined;
  let previous: string[] | null = null;
  try {
    const parsed: unknown = row ? JSON.parse(row.value) : null;
    if (Array.isArray(parsed)) previous = parsed.filter((name): name is string => typeof name === "string");
  } catch {
    previous = null;
  }
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(LEAD_CAPABILITIES_KEY, JSON.stringify(names), now.toISOString());
  if (!previous) return null;
  const before = new Set(previous);
  const after = new Set(names);
  const added = names.filter((name) => !before.has(name));
  const removed = previous.filter((name) => !after.has(name)).sort();
  return added.length || removed.length ? { added, removed } : null;
}

/** 告诉 Lead 的一段话：变了什么，以前记下的「做不到」可能过时了，用到时先调用。 */
export function leadCapabilityNotice(change: LeadCapabilityChange): string {
  const list = (names: string[]) => names.slice(0, LISTED).join("、") + (names.length > LISTED ? `，另有 ${names.length - LISTED} 个` : "");
  return [
    "系统更新了，你能用的工具和操作有变化。",
    ...(change.added.length ? [`新增：${list(change.added)}。`] : []),
    ...(change.removed.length ? [`去掉：${list(change.removed)}。`] : []),
    "以前记下的「做不到」「会被拦」「没有权限」可能已经过时：用户要你做时先调用，按调用的结果说，不要凭记忆或摘要拒绝。"
      + "笔记里这样写的过时结论，用 update_note 改掉。",
  ].join("\n");
}
