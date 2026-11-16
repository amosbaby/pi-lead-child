import { Box, Button, canCopyText, copyText, ProgressBar, Row, Text } from '@pi-lead-child/components';
import type { Locale, SubscriptionBase } from '@pi-lead-child/protocol';
import { useEffect, useState, type ReactNode } from 'react';

import { useLocale } from '@/i18n';

import { subscriptionsMessages } from './subscriptions.messages';
import type { QuotaBar } from './subscriptionsModel';

// 订阅的几块小积木（模型配置方案 C 的 S3）：订阅的标志、一条额度、复制按钮、面板底部的一行、每秒走的时钟。
// 接入列表（SubscriptionRows）、添加面板的订阅 tab（SubscriptionLogin）和订阅详情（SubscriptionDetail）共用。

// 订阅的标志：浅灰底上的两个字母（画板的 Cx、Gh）。组件规格：边长 24，和 ServiceMark 的 24 一档。
const MARK_SIZE = 24;
const MARK_LETTERS: Record<SubscriptionBase, string> = { 'openai-codex': 'Cx', 'github-copilot': 'Gh' };

export function SubscriptionMark({ base }: { base: SubscriptionBase }) {
  return (
    <Box w={MARK_SIZE} h={MARK_SIZE} shrink={0} rounded="sm" bg="surface-muted" items="center" justify="center">
      <Text size="meta" weight="bold" tone="secondary" numberOfLines={1}>{MARK_LETTERS[base]}</Text>
    </Box>
  );
}

// 接入列表里一条额度的小条宽度（画板 C-Settings-Desktop），组件规格。详情里的条跟着行宽伸缩。
const LIST_BAR_WIDTH = 48;

/**
 * 一条额度：窗口名（不换行）、已用的比例条、数字。快用完时条和数字是琥珀色，读屏的名字里写「快用完了」（P13.3）。
 * fixedBar：桌面的接入列表里条是固定宽的小条；别处跟着行宽伸缩。withReset：数字后面写重置的时刻（详情）。
 */
export function QuotaLine({ bar, fixedBar, withReset, testID }: { bar: QuotaBar; fixedBar: boolean; withReset: boolean; testID?: string }) {
  const m = subscriptionsMessages(useLocale());
  const label = m.quotaBar(bar.name, bar.percent) + (bar.near ? ` · ${m.nearlyUsedUp}` : '');
  return (
    <Row testID={testID} aria-label={label} items="center" gap="inline-item" minW={0} flex={fixedBar ? undefined : 1} shrink={fixedBar ? 0 : 1}>
      <Text size="meta" tone="secondary" numberOfLines={1} shrink={0}>{bar.name}</Text>
      <Box w={fixedBar ? LIST_BAR_WIDTH : undefined} flex={fixedBar ? undefined : 1} minW={0} shrink={fixedBar ? 0 : 1} flexDirection="row">
        <ProgressBar value={bar.used ?? 0} color={bar.near ? 'warning' : 'accent'} track="border-soft" />
      </Box>
      <Text size="meta" mono weight={bar.near ? 'semibold' : 'regular'} tone={bar.near ? 'warning-dark' : 'secondary'} numberOfLines={1} shrink={0}>
        {withReset ? bar.detail : bar.percent}
      </Text>
    </Row>
  );
}

/** 复制一段文字（只在网页上有）。点了以后写「已复制」。 */
export function CopyButton({ text, label, testID, variant = 'outline', size = 'sm' }: {
  text: string; label: string; testID?: string; variant?: 'outline' | 'link'; size?: 'xs' | 'sm';
}) {
  const m = subscriptionsMessages(useLocale());
  const [copied, setCopied] = useState(false);
  if (!canCopyText) return null;
  return (
    <Button testID={testID} label={copied ? m.copied : label} variant={variant} tone="neutral" size={size}
      onPress={() => { void copyText(text).then(setCopied); }} />
  );
}

export type PanelFooter = { status: ReactNode; action: ReactNode };

/** 抽屉里底部的一行：左边状态，右边这一块唯一的主按钮（P5.1）。手机的悬浮面板用自己的操作条（AddModelPanel 的 FooterBar）。 */
export function DrawerFooter({ footer }: { footer: PanelFooter }) {
  return (
    <Row items="center" gap="side-item" pt="card-row" borderTopWidth={1} borderTopColor="border-soft">
      {footer.status ?? <Row flex={1} />}
      {footer.action}
    </Row>
  );
}

/** 状态文字：底部一行左边的那句，一行，放不下时截断。 */
export function FooterStatus({ text, tone = 'muted', testID }: { text: string; tone?: 'muted' | 'danger-dark'; testID?: string }) {
  return <Text testID={testID} flex={1} minW={0} size="note" tone={tone} numberOfLines={2}>{text}</Text>;
}

/** 现在的时刻。active 时每秒更新一次（等了多久、码还剩多久）。 */
export function useNow(active: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return undefined;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function subscriptionName(base: SubscriptionBase, locale: Locale): string {
  return subscriptionsMessages(locale).names[base];
}
