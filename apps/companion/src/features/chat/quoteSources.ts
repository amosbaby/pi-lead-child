// 会话里能引用的话（设计规范 P17.1）：Lead 的一轮回答、你自己发的一条消息、外来消息卡里对方的话。
// 画它们的地方用 QuoteSource 包起来：web 上那一段 DOM 带 data-quote-key，选字时据此认出来源；登记表里存着来源和原文，
// 选中的字先在这里核对一遍（和 daemon 同一个规则，chatQuoteAppearsIn），对不上的不给「回复」。
import { createContext } from 'react';

import { chatQuoteAppearsIn, type ChatQuoteSource } from '@pi-lead-child/protocol';

export function quoteSourceKey(source: ChatQuoteSource): string {
  return source.kind === 'turn' ? `turn:${source.turnId}:${source.role}` : `card:${source.cardId}`;
}

interface Registered {
  source: ChatQuoteSource;
  texts: readonly string[];
  count: number;
}

const registry = new Map<string, Registered>();

// 登记一个来源，返回取消登记的函数。同一个来源画在两处（例如浮层里也画了）时按次数算。
export function registerQuoteSource(source: ChatQuoteSource, texts: readonly string[]): () => void {
  const key = quoteSourceKey(source);
  const existing = registry.get(key);
  registry.set(key, { source, texts, count: (existing?.count ?? 0) + 1 });
  return () => {
    const current = registry.get(key);
    if (!current) return;
    if (current.count <= 1) registry.delete(key);
    else registry.set(key, { ...current, count: current.count - 1 });
  };
}

export function quoteSourceOf(key: string): ChatQuoteSource | null {
  return registry.get(key)?.source ?? null;
}

// 选中的字能不能引用：来源登记过，字确实在来源里。
export function canQuote(key: string, text: string): boolean {
  const entry = registry.get(key);
  return Boolean(entry && chatQuoteAppearsIn(text, entry.texts));
}

// ── 手机：右滑和长按一段开始引用（P17.10、Q-7）──────────────────────────────────────────────────
// QuoteSource 把来源放进 context，Markdown 的每一段（QuotableBlock）从这里知道自己属于哪一轮。
// QuoteGestures：会话打开手势时（手机宽度、daemon 收引用）给，onBegin 在开始引用以后聚焦输入框、弹出键盘。

export const QuoteSourceContext = createContext<ChatQuoteSource | null>(null);
export const QuoteGesturesContext = createContext<{ onBegin: () => void } | null>(null);
