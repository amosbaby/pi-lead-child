// web：跳回原文时让原文闪一下（主题 Q-9）：accent-soft 底，170 淡入、停 600、220 淡出。
// CSS Custom Highlight 不能做过渡，所以分三步换颜色深浅。系统开了减弱动态效果时不闪（P12.7）。
// 找到原文时把它滚到可视区上部三分之一处，返回 true；原文还没画出来时返回 false。
import { palette } from '@pi-lead-child/components';
import type { ChatQuoteSource } from '@pi-lead-child/protocol';

import { findQuoteRange, occurrenceOfAnchor } from './quoteRanges';
import { quoteSourceKey } from './quoteSources';

const FLASH = 'quote-flash';
const STYLE_ID = 'quote-flash-style';

type Registry = { set(name: string, value: unknown): void; delete(name: string): void };

export function flashQuote(source: ChatQuoteSource, text: string, anchor?: string): boolean {
  const container = document.querySelector(`[data-quote-key="${CSS.escape(quoteSourceKey(source))}"]`);
  const range = container ? findQuoteRange(container, text, occurrenceOfAnchor(anchor)) : null;
  if (!range) return false;
  const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  start?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const registry = (globalThis.CSS as unknown as { highlights?: Registry } | undefined)?.highlights;
  const Highlight = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!registry || !Highlight || reduced) return true;
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `::highlight(${FLASH}) { background-color: ${palette['accent-soft']}; }`;
    document.head.appendChild(style);
  }
  registry.set(FLASH, new Highlight(range));
  setTimeout(() => registry.delete(FLASH), 170 + 600 + 220);
  return true;
}
