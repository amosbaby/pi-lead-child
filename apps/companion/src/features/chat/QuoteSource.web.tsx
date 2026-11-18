// web：可以引用的那一段 DOM 带 data-quote-key（quoteSources.ts）。display: contents，不影响排版（P17.3）。
import { useEffect, type ReactNode } from 'react';

import type { ChatQuoteSource } from '@pi-lead-child/protocol';

import { QuoteSourceContext, quoteSourceKey, registerQuoteSource } from './quoteSources';

export function QuoteSource({ source, texts, children }: { source: ChatQuoteSource; texts: readonly string[]; children: ReactNode }) {
  const key = quoteSourceKey(source);
  const signature = texts.join('\u0000');
  useEffect(() => registerQuoteSource(source, texts), [key, signature]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <QuoteSourceContext.Provider value={source}>
      <div data-quote-key={key} style={{ display: 'contents' }}>{children}</div>
    </QuoteSourceContext.Provider>
  );
}
