// 手机：Lead 回答里的一段（设计规范 P17.10、主题 Q-7）。往右滑过 44 时轻震一下，松手就引用这一段；长按也开始引用这一段
// （组件库的 SwipeAction）。开始以后输入框自动聚焦、键盘弹起（QuoteGesturesContext 的 onBegin），不弹带遮罩的面板。
// 不在手势打开的会话里（桌面、工单对话、daemon 不收引用）时原样画出这一段。
import { useContext, type ReactNode } from 'react';

import { SwipeAction } from '@pi-lead-child/components';

import { useMessages } from '@/i18n';

import { quoteMessages } from './quote.messages';
import { quoteDrafts, useQuoteDrafts } from './quoteDrafts';
import { QuoteGesturesContext, QuoteSourceContext, quoteSourceKey } from './quoteSources';

export function QuotableBlock({ text, children }: { text: string; children: ReactNode }) {
  const source = useContext(QuoteSourceContext);
  const gestures = useContext(QuoteGesturesContext);
  const m = useMessages(quoteMessages);
  // 正在引用的就是这一段：淡淡标出（主题 Q-3，手机上正在引用的整段）。
  const quoting = useQuoteDrafts((state) => Boolean(source && state.pending && state.pending.context === text
    && quoteSourceKey(state.pending.source) === quoteSourceKey(source)));
  if (!source || !gestures || !text.trim()) return <>{children}</>;
  const begin = () => {
    quoteDrafts.getState().begin({ source, text, context: text });
    gestures.onBegin();
  };
  return (
    <SwipeAction testID="quotable-block" icon="reply" actionLabel={m.quoteParagraph} hint={m.quoteSwipeHint} onAction={begin} onLongPress={begin} highlighted={quoting}>
      {children}
    </SwipeAction>
  );
}
