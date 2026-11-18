// 原生：跳回原文时不闪（找不到字在屏幕上的位置），只滚过去（Q-9）。
import type { ChatQuoteSource } from '@pi-lead-child/protocol';

export function flashQuote(_source: ChatQuoteSource, _text: string, _anchor?: string): boolean {
  return false;
}
