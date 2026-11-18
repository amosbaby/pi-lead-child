// 跳回引用的原文（设计规范 P17.7、主题 Q-9）。会话提供它：滚到原文、闪一下；原文不在已加载的范围里时先往上加载（P17.8）。
// 没有提供时（例如工单对话）引用块不能点。
import { createContext, useContext } from 'react';

import type { MessagePart } from '../../state/types';

export type QuotePartForJump = Extract<MessagePart, { kind: 'quote' }>;
export type QuoteJump = (quote: QuotePartForJump) => void;

export const QuoteJumpContext = createContext<QuoteJump | null>(null);

export function useQuoteJump(): QuoteJump | null {
  return useContext(QuoteJumpContext);
}
