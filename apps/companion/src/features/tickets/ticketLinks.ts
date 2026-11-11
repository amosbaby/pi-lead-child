// 工单从哪来、怎么处理、谁领着、在哪个会话里（external-worker-hub P1-7，Task 10）。数据来自两个只读接口：
// 列表用 GET /v1/tickets/meta，详情用 GET /v1/tickets/:id/links。它们不在 TicketSummary 里，当前状态照旧只看 TicketSummary。
//   - 链接只认 https: 和 claude:（protocol 的 WORKER_SESSION_URL_SCHEMES）。别的地址（javascript:、file:、http:、坏的）照原样写成文字。
//   - 会话只有 id 时写 `claude --resume <id>`，给一个复制按钮。
//   - 手动领的单超过 IDLE_RELEASE_HOURS 小时没动静：列表上写「N 小时无动静」，给释放（ticket.release）。
import {
  sessionLinkScheme, ticketSourceLabel, WORKER_SESSION_URL_SCHEMES, type TicketLinks, type TicketMeta, type TicketSourceDto,
} from '@pi-lead-child/protocol';

import type { Locale } from '@/i18n';

import { ticketLinksMessages } from './ticketLinks.messages';

export const LINK_PROTOCOLS: readonly string[] = WORKER_SESSION_URL_SCHEMES;
export const IDLE_RELEASE_HOURS = 4;

/** 能画成链接的地址；不能时 null。 */
export function linkHref(url: string | null | undefined): string | null {
  return sessionLinkScheme(url) ? url! : null;
}

export type SourcePresentation = {
  key: string;
  label: string;
  // 能点的地址。没有地址、或者地址不是 https:、claude: 时为 null，这时写 text。
  href: string | null;
  // 不能点时写的文字：标签，后面是对话（私信建的单没有地址，只有对话）或者原样的地址。
  text: string;
};

export function sourcePresentation(source: TicketSourceDto, locale: Locale): SourcePresentation {
  const m = ticketLinksMessages(locale);
  const label = ticketSourceLabel(source) ?? m.noSource;
  const href = linkHref(source.url);
  const rest = href ? null : source.conversation ?? source.url;
  return { key: String(source.id), label, href, text: rest ? `${label} · ${rest}` : label };
}

export type SessionPresentation =
  | { kind: 'link'; key: string; href: string; label: string }
  | { kind: 'resume'; key: string; command: string }
  | { kind: 'text'; key: string; text: string };

export function sessionPresentation(session: TicketLinks['sessions'][number], index: number, locale: Locale): SessionPresentation {
  const m = ticketLinksMessages(locale);
  const key = `${index}:${session.url ?? ''}:${session.sessionId ?? ''}`;
  const href = linkHref(session.url);
  if (href) return { kind: 'link', key, href, label: sessionLinkScheme(href) === 'claude:' ? m.openInClaude : href };
  if (session.sessionId) return { kind: 'resume', key, command: m.resumeCommand(session.sessionId) };
  return { kind: 'text', key, text: session.url ?? '' };
}

export function handlingLabel(handling: TicketMeta['handling'], locale: Locale): string {
  const m = ticketLinksMessages(locale);
  return handling === 'auto' ? m.handlingAuto : handling === 'needs_user' ? m.handlingNeedsUser : m.handlingNotJudged;
}

export function complexityLabel(complexity: TicketMeta['complexity'], locale: Locale): string | null {
  return complexity ? ticketLinksMessages(locale).complexities[complexity] : null;
}

/** 手动领的单没动静多少小时（超过 IDLE_RELEASE_HOURS 时）。没人领、从队列领的（有租约）、还不到时为 null。 */
export function idleClaimHours(meta: TicketMeta | null | undefined): number | null {
  if (!meta || meta.claimMode !== 'manual' || meta.idleHours === null) return null;
  return meta.idleHours >= IDLE_RELEASE_HOURS ? meta.idleHours : null;
}

/** 列表行说明里的来源、复杂度、领取人（设计规范 P6.4：元信息合成一行）。 */
export function ticketMetaCaptionParts(meta: TicketMeta | null | undefined, locale: Locale): string[] {
  if (!meta) return [];
  const m = ticketLinksMessages(locale);
  return [
    meta.sourceLabel,
    complexityLabel(meta.complexity, locale),
    meta.claimedBy ? m.claimedCaption(meta.claimedBy) : null,
  ].filter((part): part is string => Boolean(part));
}

/** 列表搜索也查来源标签（含 Jira 的编号）、领取人、处理方式和复杂度（spec P1-2）。 */
export function ticketMetaSearchText(meta: TicketMeta | null | undefined, locale: Locale): string {
  if (!meta) return '';
  return [
    meta.sourceLabel, meta.claimedBy, meta.handling ? handlingLabel(meta.handling, locale) : null, complexityLabel(meta.complexity, locale),
  ].filter(Boolean).join(' ');
}
