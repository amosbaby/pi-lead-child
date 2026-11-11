// 待你处理推送（.scratch/external-worker-hub/spec.md「待你处理」，计划 Task 12）：用户不用守着网页列表，要他拿主意的工单
// 推一次到他自己的 Slack 私信，再弹一条桌面通知。
//   - 「待你处理」就是 needs_me（read.ts 的 NEEDS_ME，ruling R15、R18）。S1 里推的原因只有 needs_user（Lead 判断要你处理）和
//     handed_back（工人交回给你）。自动处理的单（handling=auto）不逐条推（每日汇总是 S4 的事）。
//   - 一张单最多一条消息（ticket_pushes 以工单编号为主键）：状态变了（被领走、交回、验收、完成、取消、不用你处理了）就改写那条，
//     不另发；重启以后按库里记的状态比，不重发也不重改。又变成「待你处理」时改写那条，桌面通知再弹一次（Slack 改消息不提醒）。
//   - 只推到用户自己的私信（store 的 ownerConversationOf），不发到来源频道。没有私信、Slack 私信推送关着时只弹桌面通知。
//     私信推送和私信里的决定请求一样，不看「同步到 Slack 私信」开关、也不看「自动代你处理」：那两个管的是 Lead 写的话。
//   - 只推最近一小时里变成「待你处理」的（items.updated_at）：功能上线时以前就在等的单不会一起涌进私信。
//   - 消息里：工单编号和标题、来源链接（只有 https 的）、理由、工单链接（只用编号拼）、有会话链接时「在 Claude Code 打开」
//     （只有 claude: 和 https: 的）。工单的文字（标题、理由、工人名字）只当纯文字放进正文，不进任何链接，也拼不成链接或提到谁。
//   - 发消息走通道 hub 的「回给用户本人」（daemon 接上），幂等键是工单编号：发到一半崩溃后重试，来源里也不会多一条。
import { EXTERNAL_RUNTIME_ID, WORKER_SESSION_URL_SCHEMES } from "@pi-lead-child/protocol";
import {
  detachTicketPushMessage, getItem, getLocale, getTicketPush, getTicketPushSetting, insertTicketPush, openTicketPushes,
  ownerConversationOf, setTicketPushMessage, setTicketPushShown, type Db,
} from "@pi-lead-child/store";
import { latestWorkerClaim, openWorkerClaim } from "./claim.js";
import { effectiveTicketSources, ticketLinks } from "./links.js";
import { NEEDS_ME, ticketNeedsMe } from "./read.js";
import { ticketPushMessages } from "./pushes.messages.js";

/**
 * 推送的原因。S1 只推 needs_user 和 handed_back；draft_ready（草稿待发）、lease_expired（租约到期）、needs_permission（要授权）
 * 是 S3、S4 的，这里只占着类型，不会推。
 */
export type TicketPushReason = "needs_user" | "handed_back" | "draft_ready" | "lease_expired" | "needs_permission";
/** 用户看到的状态：「待你处理」的原因，或者离开「待你处理」以后的样子。 */
export type TicketPushState = "needs_user" | "handed_back" | "claimed" | "in_review" | "done" | "cancelled" | "cleared";

// 用户自己的私信在哪个来源里（计划 Task 12：ownerConversationOf(db, "slack")）。
const OWNER_DM_SOURCE = "slack";
// 只推这段时间里变成「待你处理」的；没发出去的消息也只在这段时间里重发（和私信里的决定请求一样，owner-decisions.ts）。
export const TICKET_PUSH_RECENT_MS = 60 * 60_000;
// 发不出去、改不成的，过多久再试（同一个幂等键，来源里不会多发）。
const RETRY_MS = 60_000;
const LIST_LIMIT = 50;
const TITLE_MAX = 200;
const REASON_MAX = 500;
const NAME_MAX = 80;
const SOURCE_SCHEMES: readonly string[] = ["https:"];
const SESSION_SCHEMES: readonly string[] = WORKER_SESSION_URL_SCHEMES;

/** 发消息的那一层（daemon 里是通道的 hub：回给用户本人那条路）。发不出去、改不成时抛错，下一次再试。 */
export interface TicketPushSlack {
  /** 在用户自己的私信里发一条。key 是幂等键：同一个键只发一次。返回那条消息的位置。 */
  post(conversation: string, text: string, key: string): Promise<{ ref: Record<string, string> }>;
  /** 把发过的那条改成 text。那条消息没了（例如用户删了）时返回 gone。key 是这一次改写的幂等键。 */
  edit(conversation: string, ref: Record<string, string>, text: string, key: string): Promise<{ gone?: boolean }>;
}

export interface TicketPushOptions {
  /** 弹一条桌面通知（daemon 的 DesktopNotifier）。不给时不弹。 */
  desktop?: ((text: string) => void) | null;
  /** 网页的地址（daemon 的网关）。工单链接是它加 /ticket/<编号>。不给、不是 http(s) 时不带工单链接。 */
  webBase?: (() => string | null) | null;
  now?: Date;
}

const NEEDS_YOU: readonly string[] = ["needs_user", "handed_back"];
const isNeedsYou = (state: string | null): state is "needs_user" | "handed_back" => state !== null && NEEDS_YOU.includes(state);

function handedBack(db: Db, itemId: number): boolean {
  const claim = latestWorkerClaim(db, itemId);
  if (!claim || claim.open) return false;
  return db.prepare(
    `SELECT 1 FROM activities WHERE item_id=? AND run_id=? AND kind='decision' AND json_valid(payload)
       AND json_extract(payload, '$.decision')='worker_handed_back' LIMIT 1`,
  ).get(itemId, claim.runId) !== undefined;
}

/** 用户现在该看到的状态。工单不存在时 null。 */
export function ticketPushState(db: Db, itemId: number): TicketPushState | null {
  const item = getItem(db, itemId);
  if (!item) return null;
  if (ticketNeedsMe(db, itemId)) return handedBack(db, itemId) ? "handed_back" : "needs_user";
  if (item.stage === "done") return "done";
  if (item.stage === "cancelled") return "cancelled";
  if (item.stage === "review") return "in_review";
  if (openWorkerClaim(db, itemId)) return "claimed";
  return "cleared";
}

/** 要推、还没推过的单：「待你处理」、最近一小时里变成这样的、从没推过的。按编号。 */
export function ticketsToPush(db: Db, now: Date): Array<{ itemId: number; reason: TicketPushReason }> {
  const since = new Date(now.getTime() - TICKET_PUSH_RECENT_MS).toISOString();
  const ids = (db.prepare(
    `SELECT i.id FROM items i
     WHERE ${NEEDS_ME}
       AND NOT EXISTS (SELECT 1 FROM ticket_pushes p WHERE p.item_id = i.id)
       AND datetime(i.updated_at) >= datetime(?)
     ORDER BY i.id LIMIT ?`,
  ).all(EXTERNAL_RUNTIME_ID, since, LIST_LIMIT) as Array<{ id: number }>).map((row) => row.id);
  return ids.map((itemId) => ({ itemId, reason: handedBack(db, itemId) ? "handed_back" : "needs_user" }));
}

const isRecent = (at: string, now: Date) => now.getTime() - Date.parse(at) < TICKET_PUSH_RECENT_MS;

/** 推过、现在要发（没发出去的）或者要改写（状态变了）的单。按编号。 */
export function ticketPushesToSync(db: Db, now: Date): number[] {
  return openTicketPushes(db).filter((itemId) => {
    const push = getTicketPush(db, itemId);
    if (!push) return false;
    if (push.conversation !== null && push.messageRef === null && isRecent(push.createdAt, now)) return true;
    const state = ticketPushState(db, itemId);
    return state !== null && state !== push.shownState;
  });
}

// ── 文字 ──────────────────────────────────────────────────────────────────────────────

// 工单的文字放进 Slack 正文：一行、截断、转义 & < >（不会被当成提到谁、频道或链接），拆开 Markdown 链接的「](」
// （hub 发送时把正文的 Markdown 换成 Slack 的格式，[文字](地址) 会变成链接）。
function slackPlain(text: string, max: number): string {
  return clip(text, max).replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/\]\(/gu, "]​(");
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// 能放进 Markdown 链接的地址：协议在清单里、不带用户名密码；( ) | 换成百分号编码（不改地址的意思，链接不会提前断开）。
function safeHref(url: string | null | undefined, schemes: readonly string[]): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!schemes.includes(parsed.protocol) || parsed.username || parsed.password) return null;
  return parsed.href.replace(/\(/gu, "%28").replace(/\)/gu, "%29").replace(/\|/gu, "%7C");
}

// 工单链接：网页地址加 /ticket/<编号>。只用编号，不带工单的任何文字。
function ticketHref(webBase: string | null, itemId: number): string | null {
  const base = safeHref(webBase, ["https:", "http:"]);
  return base ? `${base.replace(/\/+$/u, "")}/ticket/${itemId}` : null;
}

interface PushView {
  state: TicketPushState;
  title: string;
  reason: string | null;
  worker: string | null;
  source: string | null;
  ticket: string | null;
  session: string | null;
}

function viewOf(db: Db, itemId: number, state: TicketPushState, webBase: string | null): PushView {
  const item = getItem(db, itemId)!;
  const { handling_reason: reason } = db.prepare("SELECT handling_reason FROM items WHERE id=?").get(itemId) as { handling_reason: string | null };
  const worker = state === "claimed" ? openWorkerClaim(db, itemId)?.workerName ?? null
    : state === "handed_back" ? latestWorkerClaim(db, itemId)?.workerName ?? null
    : null;
  return {
    state,
    title: item.display_title?.trim() || item.title,
    reason: isNeedsYou(state) && reason?.trim() ? reason : null,
    worker,
    source: effectiveTicketSources(db, itemId).map((source) => safeHref(source.url, SOURCE_SCHEMES)).find((href) => href !== null) ?? null,
    ticket: ticketHref(webBase, itemId),
    session: ticketLinks(db, itemId).sessions.map((session) => safeHref(session.url, SESSION_SCHEMES)).find((href) => href !== null) ?? null,
  };
}

function headline(db: Db, itemId: number, view: PushView, plain: (text: string, max: number) => string): string {
  const m = ticketPushMessages(getLocale(db));
  const ticket = `#${itemId} ${plain(view.title, TITLE_MAX)}`;
  const worker = view.worker ? plain(view.worker, NAME_MAX) : null;
  switch (view.state) {
    case "handed_back": return m.headline.handed_back(ticket, worker);
    case "claimed": return m.headline.claimed(ticket, worker);
    default: return m.headline[view.state](ticket);
  }
}

/** 私信里那条消息现在的样子（Markdown，hub 发送时换成 Slack 的格式）。 */
function slackText(db: Db, itemId: number, view: PushView): string {
  const m = ticketPushMessages(getLocale(db));
  const links = [
    view.source ? `[${m.source}](${view.source})` : null,
    view.ticket ? `[${m.ticket}](${view.ticket})` : null,
    view.session ? `[${m.session}](${view.session})` : null,
  ].filter((link): link is string => link !== null);
  return [
    headline(db, itemId, view, slackPlain),
    view.reason ? m.reason(slackPlain(view.reason, REASON_MAX)) : null,
    links.length ? links.join(" · ") : null,
  ].filter((line): line is string => line !== null).join("\n");
}

/** 桌面通知的正文（纯文字）。 */
function desktopText(db: Db, itemId: number, view: PushView): string {
  const m = ticketPushMessages(getLocale(db));
  return [headline(db, itemId, view, clip), view.reason ? m.reason(clip(view.reason, REASON_MAX)) : null]
    .filter((line): line is string => line !== null).join("\n");
}

// ── 同步一张单 ────────────────────────────────────────────────────────────────────────

/**
 * 按库里的状态推一张单：
 *   - 没推过、现在「待你处理」：记下来，弹桌面通知，发到用户自己的私信（有私信、私信推送开着时）；
 *   - 发过但没发出去（一小时内）：用同一个幂等键再发一次，发的是现在的样子；
 *   - 发出去了、状态变了：改写那条消息；又变成「待你处理」时再弹一次桌面通知。
 * 发不出去、改不成时抛错，库里的状态不动，下一次再试。
 */
export async function syncTicketPush(db: Db, slack: TicketPushSlack | null, itemId: number, options: TicketPushOptions = {}): Promise<void> {
  const now = options.now ?? new Date();
  const state = ticketPushState(db, itemId);
  if (!state) return;
  const webBase = options.webBase?.() ?? null;
  const notify = (view: PushView) => {
    if (options.desktop && getTicketPushSetting(db, "desktop").enabled) options.desktop(desktopText(db, itemId, view));
  };
  const push = getTicketPush(db, itemId);

  if (!push) {
    if (!isNeedsYou(state)) return;
    const conversation = getTicketPushSetting(db, "slack_dm").enabled ? ownerConversationOf(db, OWNER_DM_SOURCE) : null;
    if (!insertTicketPush(db, { itemId, reason: state, conversation, shownState: state, now })) return;
    const view = viewOf(db, itemId, state, webBase);
    notify(view);
    if (conversation && slack) {
      const sent = await slack.post(conversation, slackText(db, itemId, view), `ticket-push:${itemId}`);
      setTicketPushMessage(db, itemId, sent.ref, state, now);
    }
    return;
  }

  const unsent = push.conversation !== null && push.messageRef === null && isRecent(push.createdAt, now);
  if (!unsent && push.shownState === state) return;
  const view = viewOf(db, itemId, state, webBase);
  if (push.conversation && slack) {
    if (unsent) {
      const sent = await slack.post(push.conversation, slackText(db, itemId, view), `ticket-push:${itemId}`);
      setTicketPushMessage(db, itemId, sent.ref, state, now);
    } else if (push.messageRef) {
      const edited = await slack.edit(push.conversation, push.messageRef, slackText(db, itemId, view), `ticket-push:${itemId}:${state}:${push.updatedAt}`);
      if (edited.gone) detachTicketPushMessage(db, itemId, now);
    }
  }
  if (isNeedsYou(state) && !isNeedsYou(push.shownState)) notify(view);
  setTicketPushShown(db, itemId, { shownState: state, ...(isNeedsYou(state) ? { reason: state } : {}), now });
}

// ── daemon 每一拍调的那一层 ──────────────────────────────────────────────────────────────

export interface TicketPusherDeps {
  db: Db;
  slack: TicketPushSlack | null;
  desktop?: ((text: string) => void) | null;
  webBase?: (() => string | null) | null;
  log(line: string): void;
  now?: () => Date;
}

export interface TicketPusher {
  /** 推新的「待你处理」，改写状态变了的。同一时间只跑一次；发不出去的单过一分钟再试。 */
  sync(): Promise<void>;
}

export function createTicketPusher(deps: TicketPusherDeps): TicketPusher {
  const now = deps.now ?? (() => new Date());
  const retryAt = new Map<number, number>();
  let syncing = false;

  return {
    async sync() {
      if (syncing) return;
      syncing = true;
      try {
        const at = now();
        const ids = [...new Set([...ticketsToPush(deps.db, at).map((ticket) => ticket.itemId), ...ticketPushesToSync(deps.db, at)])];
        for (const itemId of ids) {
          const due = retryAt.get(itemId);
          if (due !== undefined && due > at.getTime()) continue;
          try {
            await syncTicketPush(deps.db, deps.slack, itemId, { desktop: deps.desktop ?? null, webBase: deps.webBase ?? null, now: at });
            retryAt.delete(itemId);
          } catch (error) {
            retryAt.set(itemId, at.getTime() + RETRY_MS);
            deps.log(`[ticket-pushes] could not push ticket #${itemId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } finally {
        syncing = false;
      }
    },
  };
}
