// /compact in Lead's message box (2026-11-18): the line under the input after the daemon answered POST /v1/lead/compact.
// The result of the compaction itself shows in the conversation as a system notice (the daemon writes it).
import type { CompactLeadContextResult } from '@pi-lead-child/protocol';

import type { Locale } from '@/i18n';

import { composerMessages } from './composer.messages';

export function compactNoticeText(result: CompactLeadContextResult, locale: Locale): string {
  const m = composerMessages(locale).compact;
  if (result.existing) return m.joined;
  switch (result.applied) {
    case 'now':
      return m.now(result.model);
    case 'after_turn':
      return m.afterTurn(result.model);
    case 'nothing_to_compact':
      return m.nothing;
    case 'held':
      return m.held;
  }
}
