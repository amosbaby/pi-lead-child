// 原生：选字回复在原生上没有（RN 的 Text 拿不到选区，设计规范 P17.10），引用从右滑和长按开始，在 QuotableBlock 里。
// 这里只登记来源，给跳回原文用。
import { useEffect, type ReactNode } from 'react';

import type { ChatQuoteSource } from '@pi-lead-child/protocol';

import { QuoteSourceContext, registerQuoteSource } from './quoteSources';

export function QuoteSource({ source, texts, children }: { source: ChatQuoteSource; texts: readonly string[]; children: ReactNode }) {
  const signature = texts.join('\u0000');
  useEffect(() => registerQuoteSource(source, texts), [source.kind, source.kind === 'turn' ? source.turnId : source.cardId, signature]); // eslint-disable-line react-hooks/exhaustive-deps
  return <QuoteSourceContext.Provider value={source}>{children}</QuoteSourceContext.Provider>;
}
