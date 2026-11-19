// 会话里能引用的一段（设计规范 P17.1）：登记来源（给跳回原文和核对选中的字用），
// web 上这一段带 data-quote-key（DataScope，display: contents，不影响排版，P17.3），选字时据此认出来源。
// 原生上选字回复没有（RN 的 Text 拿不到选区，P17.10），引用从右滑和长按开始（QuotableBlock）。
import { useEffect, type ReactNode } from 'react';

import { DataScope } from '@pi-lead-child/components';
import type { ChatQuoteSource } from '@pi-lead-child/protocol';

import { QuoteSourceContext, quoteSourceKey, registerQuoteSource } from './quoteSources';

export function QuoteSource({ source, texts, children }: { source: ChatQuoteSource; texts: readonly string[]; children: ReactNode }) {
  const key = quoteSourceKey(source);
  const signature = texts.join('\u0000');
  useEffect(() => registerQuoteSource(source, texts), [key, signature]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <QuoteSourceContext.Provider value={source}>
      <DataScope data={{ 'quote-key': key }}>{children}</DataScope>
    </QuoteSourceContext.Provider>
  );
}
