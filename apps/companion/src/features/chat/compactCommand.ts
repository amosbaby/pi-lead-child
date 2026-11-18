// /compact in Lead's message box (2026-11-18): the line under the input after the daemon answered POST /v1/lead/compact.
// The result of the compaction itself shows in the conversation as a system notice (the daemon writes it).
// The daemon's error text is detail for logs; the page shows its own text by the HTTP status (docs/i18n.md).
import type { CompactLeadContextResult } from '@pi-lead-child/protocol';

import type { Locale } from '@/i18n';

import { composerMessages } from './composer.messages';

export type CompactNotice = { text: string; tone: 'muted' | 'danger' };

export function compactNotice(result: CompactLeadContextResult, locale: Locale): CompactNotice {
  const m = composerMessages(locale).compact;
  const list = result.candidates.join(m.separator);
  switch (result.applied) {
    case 'model_ambiguous':
      return { text: m.ambiguous(result.model, list), tone: 'danger' };
    case 'model_unknown':
      return { text: list ? m.unknown(result.model, list) : m.unknownNone(result.model), tone: 'danger' };
    case 'held':
      // The page is always the user's own request, which passes the hold: this answer comes only from a newer daemon rule.
      return { text: m.notStarted, tone: 'danger' };
    case 'nothing_to_compact':
      return { text: m.nothing, tone: 'muted' };
    case 'now':
    case 'after_turn':
      if (result.existing) return { text: result.requestApplied ? m.joined : m.joinedOther(result.model), tone: 'muted' };
      return { text: result.applied === 'now' ? m.now(result.model) : m.afterTurn(result.model), tone: 'muted' };
  }
}

/** A request that failed: the text by the HTTP status (400 invalid, 404 an older daemon, 409 not now), never the server's. */
export function compactErrorNotice(error: unknown, locale: Locale): CompactNotice {
  const m = composerMessages(locale).compact;
  const status = typeof error === 'object' && error !== null && 'status' in error ? (error as { status?: unknown }).status : undefined;
  const text = status === 400 ? m.invalid : status === 404 ? m.noRoute : status === 409 || status === 503 ? m.unavailable : m.failed;
  return { text, tone: 'danger' };
}
