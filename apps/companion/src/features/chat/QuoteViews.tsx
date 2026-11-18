// 引用回复的显示（设计规范 P17.7、主题 Q-8）：你的气泡里，正文上面按加入的顺序排着引用，一条一块。
// 第一行是回复图标加原文（最多 2 行），第二行是你对这一段的说明。整块可以点，点了跳回原文（onJump）。
import { Column, Icon, Pressable, Row, Text } from '@pi-lead-child/components';

import { useMessages } from '@/i18n';

import { quoteMessages } from './quote.messages';

export interface QuoteBlockQuote {
  id: string;
  text: string;
  note?: string;
}

export function QuoteBlock({ quote, onJump }: { quote: QuoteBlockQuote; onJump?: () => void }) {
  const m = useMessages(quoteMessages);
  return (
    <Pressable
      testID={`quote-block-${quote.id}`}
      accessibilityRole="button"
      accessibilityLabel={m.jumpToSource(quote.text)}
      onPress={onJump}
      disabled={!onJump}
    >
      <Column bg="surface" rounded="md" px="inset-x" py="inset-y" gap="text-stack">
        <Row gap="icon-label" items="flex-start">
          <Icon name="reply" size={14} color="text-secondary" />
          <Text size="secondary" tone="strong" numberOfLines={2} flex={1} minW={0}>{quote.text}</Text>
        </Row>
        {quote.note ? <Text size="secondary">{quote.note}</Text> : null}
      </Column>
    </Pressable>
  );
}
