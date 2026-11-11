// 工单从哪来（.scratch/external-worker-hub/spec.md P1-2）：建单的各条路怎么写 ticket_sources（store 的 worker-hub.ts）。
//   - 通道卡（Lead 派活 dispatch_agent_task、Lead 在外部消息叫醒的一轮里 create_task）：种类按卡的来源插件，对话是卡的对象键，
//     消息位置是卡的锚点（reply_target.thread_ts：线程的根或者开卡的那条消息，不一定是叫醒这一轮的那条），和 v68 回填同一个含义。
//   - 用户私信里让 Lead 建的单：store 的 recordTicketOrigin 记。
//   - 工人从自己的会话建单（worker.track）：按链接认种类（trackSourceOf）。
// 代码里不写工作区的域名：Slack、Jira、Notion 只按公开的域名后缀和路径认，链接原样存，网页按 scheme 白名单渲染。
import { MESSAGE_EVENT_KIND, sourceLink } from "@pi-lead-child/protocol";
import {
  addConversationSource, getChannelCard, getEvent, setExternalOrigin, ticketSourceKindOf, type ChannelCard, type Db, type TicketSourceKind,
} from "@pi-lead-child/store";
import { TicketActionError } from "./ticket-actions/types.js";

// 卡的锚点：卡回复的位置里的线程根（开卡的那条消息或者它所在线程的根）。
function cardAnchor(card: ChannelCard): string | null {
  const ts = card.replyTarget.thread_ts;
  return typeof ts === "string" && ts !== "" ? ts : null;
}

/**
 * 记下这张工单来自这张通道卡（card_id 是卡本身：卡和工单按它关联，ruling R19）。同一张工单同一张卡只记一次。卡不存在时什么都不记，返回 false。
 * url：在来源里打开那条消息的地址（来源插件的 link()，经 protocol 的 sourceLink 只收 https）。插件拼不出时为 null。
 */
export function recordCardTicketSource(db: Db, input: { itemId: number; cardId: number; url?: string | null; now?: Date }): boolean {
  const card = getChannelCard(db, input.cardId);
  if (!card) return false;
  return addConversationSource(db, {
    itemId: input.itemId, kind: ticketSourceKindOf(card.source), conversation: card.objectKey, messageTs: cardAnchor(card), cardId: card.id,
    url: sourceLink(input.url ?? null), ...(input.now ? { now: input.now } : {}),
  });
}

/**
 * 这几条事件（一轮的 externalEvents）里外部通道的消息事件对应的通道卡和消息的链接（消息事件的 payload.link，hub 建事件时用
 * 来源插件的 link() 算好的），按卡去重，按事件的先后。
 */
export function messageEventCards(db: Db, eventSeqs: readonly number[]): Array<{ cardId: number; url: string | null }> {
  const cards: Array<{ cardId: number; url: string | null }> = [];
  for (const seq of eventSeqs) {
    const event = getEvent(db, seq);
    const cardId = event?.kind === MESSAGE_EVENT_KIND ? event.payload.cardId : null;
    if (typeof cardId === "number" && !cards.some((card) => card.cardId === cardId)) {
      cards.push({ cardId, url: sourceLink(event!.payload.link) });
    }
  }
  return cards;
}

/** Lead 建单（create_task、hand_off）：叫醒这一轮的外部通道消息的卡记成工单的来源。返回记下了几条。 */
export function recordTurnCardSources(db: Db, input: { itemId: number; eventSeqs: readonly number[]; now?: Date }): number {
  let recorded = 0;
  for (const card of messageEventCards(db, input.eventSeqs)) {
    if (recordCardTicketSource(db, { itemId: input.itemId, cardId: card.cardId, url: card.url, ...(input.now ? { now: input.now } : {}) })) recorded += 1;
  }
  return recorded;
}

/**
 * Lead 派活（dispatch_agent_task）建的单：派单器建单时一律记成来自外部来源（每一张都来自通道卡，失败时宁可多算外部）；
 * 这里记卡的来源（对话、锚点、消息的链接），派活的那条消息是用户本人写的（self_reply）时把 external_origin 清成 0。
 */
export function recordDispatchedCardSource(
  db: Db, input: { itemId: number; cardId: number; eventSeq: number; url: string | null; now?: Date },
): void {
  recordCardTicketSource(db, { itemId: input.itemId, cardId: input.cardId, url: input.url, ...(input.now ? { now: input.now } : {}) });
  if (isOwnMessageEvent(db, input.eventSeq)) setExternalOrigin(db, input.itemId, false);
}

/** 这条消息事件是不是用户本人写的（卡上的 self_reply）。别人的消息、读不到的事件都不是。 */
export function isOwnMessageEvent(db: Db, eventSeq: number): boolean {
  return getEvent(db, eventSeq)?.payload.role === "self_reply";
}

export interface TrackSource {
  kind: TicketSourceKind;
  url: string | null;
  // Jira 的单号（PROJ-123），Notion 页的 id（32 位小写十六进制，没有连字符）。认不出时 null。
  externalKey: string | null;
}

const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const NOTION_ID = /([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})(?:$|[^0-9a-f])/i;
const hostIs = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

function jiraKey(url: URL): string | null {
  const browse = /^\/browse\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  if (browse && JIRA_KEY.test(browse)) return browse;
  const selected = url.searchParams.get("selectedIssue");
  return selected && JIRA_KEY.test(selected) ? selected : null;
}

/**
 * worker.track 的链接是哪种来源。只收 https（javascript:、file: 这类一律不收，抛 invalid_input）。不给链接时是 manual。
 *   - Slack：slack.com 下的链接。没有单号。
 *   - Jira：atlassian.net 下的单（/browse/<KEY> 或者看板上的 selectedIssue=<KEY>），单号是 KEY。atlassian.net 下别的页面
 *     （例如 Confluence）不是 Jira，记成 manual。
 *   - Notion：notion.so、notion.site 下的页面，单号是页的 id。
 *   - 别的 https 链接：manual，链接原样存。
 */
export function trackSourceOf(sourceUrl: string | undefined): TrackSource {
  if (sourceUrl === undefined) return { kind: "manual", url: null, externalKey: null };
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new TicketActionError("invalid_input", `来源链接不是一个 URL：${sourceUrl.slice(0, 200)}`);
  }
  if (url.protocol !== "https:") throw new TicketActionError("invalid_input", `来源链接只收 https:，不收 ${url.protocol}`);
  const host = url.hostname.toLowerCase();
  if (hostIs(host, "slack.com")) return { kind: "slack", url: sourceUrl, externalKey: null };
  if (hostIs(host, "atlassian.net")) {
    const key = jiraKey(url);
    if (key) return { kind: "jira", url: sourceUrl, externalKey: key };
    return { kind: "manual", url: sourceUrl, externalKey: null };
  }
  if (hostIs(host, "notion.so") || hostIs(host, "notion.site")) {
    const id = NOTION_ID.exec(url.pathname)?.[1];
    return { kind: "notion", url: sourceUrl, externalKey: id ? id.replace(/-/g, "").toLowerCase() : null };
  }
  return { kind: "manual", url: sourceUrl, externalKey: null };
}
