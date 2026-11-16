import { Column, Dot, Icon, Pressable, Row, Text, useBreakpoint } from '@pi-lead-child/components';
import type { Locale, ModelSettingsDto, Subscription, SubscriptionAccount, SubscriptionBase } from '@pi-lead-child/protocol';
import { useCallback, useState } from 'react';

import { useLocale } from '@/i18n';

import { SubscriptionDetailPanel } from './SubscriptionDetail';
import { subscriptionsMessages } from './subscriptions.messages';
import { accountName, activeAccount, quotaBars, subscriptionsOf, subscriptionSummary, subscriptionUse } from './subscriptionsModel';
import { QuotaLine, SubscriptionMark } from './SubscriptionParts';

// 设置 → 模型的接入列表里「订阅」一组（模型配置方案 C 的 S3，画板 C-Settings-Desktop）。
// 一种订阅一行：标志、名字、账号数和换号方式、右边模型数和在分工里的位置。下面一个账号一行：名字、额度小条和已用的比例、「正在用」。
// 只有 Codex 有额度；Copilot 的账号行写明 GitHub 不提供额度查询。点一种订阅打开它的详情（SubscriptionDetail）。
// 短标签（名字、窗口名、比例、「正在用」）不换行、不缩；长的说明截断（用户否掉过一字一行的版式）。

export function SubscriptionRows({ dto }: { dto: ModelSettingsDto }) {
  const locale = useLocale();
  const m = subscriptionsMessages(locale);
  const [open, setOpen] = useState<SubscriptionBase | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const connected = (subscriptionsOf(dto)?.subscriptions ?? []).filter((subscription) => subscription.accounts.length > 0);
  return (
    <Column testID="subscription-rows">
      {connected.length === 0 ? (
        <Text testID="subscription-rows-empty" size="note" tone="muted" px="row-x" pb="row-y">{m.noSubscriptions}</Text>
      ) : connected.map((subscription, index) => (
        <SubscriptionRow key={subscription.base} dto={dto} subscription={subscription} first={index === 0} locale={locale}
          onOpen={() => setOpen(subscription.base)} />
      ))}
      <SubscriptionDetailPanel base={open} onClose={close} />
    </Column>
  );
}

function SubscriptionRow({ dto, subscription, first, locale, onOpen }: {
  dto: ModelSettingsDto;
  subscription: Subscription;
  first: boolean;
  locale: Locale;
  onOpen: () => void;
}) {
  const m = subscriptionsMessages(locale);
  const { tablet } = useBreakpoint();
  const active = activeAccount(dto, subscription);
  const base = subscription.base;
  return (
    <Pressable
      testID={`subscription-row-${base}`}
      aria-label={m.openDetail(m.names[base])}
      onPress={onOpen}
      flexDirection="column"
      py="row-y"
      gap="card-row"
      borderTopWidth={first ? 0 : 1}
      borderTopColor="border-soft"
      bg={{ default: 'surface', hover: 'surface-subtle', press: 'surface-muted' }}
      feedback="none"
    >
      <Row items="center" gap="inline-item" px="row-x">
        <SubscriptionMark base={base} />
        <Text size="card-title" weight="semibold" numberOfLines={1} shrink={0}>{m.names[base]}</Text>
        <Text testID={`subscription-row-summary-${base}`} flex={1} minW={0} size="meta" tone="secondary" numberOfLines={1}>
          {subscriptionSummary(subscription, locale)}
        </Text>
        <Text testID={`subscription-row-use-${base}`} size="meta" tone="strong" numberOfLines={1} shrink={0}>{subscriptionUse(dto, subscription, locale)}</Text>
        <Icon name="chevron-right" size={14} color="text-ghost" />
      </Row>
      {subscription.accounts.map((account) => (
        <AccountRow key={account.provider} account={account} quota={subscription.quotaSupported} active={active === account.provider} wide={tablet} locale={locale} />
      ))}
    </Pressable>
  );
}

// 一个账号一行。桌面上一行写完；手机上额度条换到名字下面一行。
function AccountRow({ account, quota, active, wide, locale }: {
  account: SubscriptionAccount;
  quota: boolean;
  active: boolean;
  wide: boolean;
  locale: Locale;
}) {
  const m = subscriptionsMessages(locale);
  const bars = quota ? quotaBars(account, new Date(), locale) : [];
  const provider = account.provider;
  const status = !account.loggedIn ? m.notLoggedIn
    : !quota ? m.noQuotaSkip
    : account.quota?.problem ?? (bars.length === 0 ? m.quotaNotRead : null);
  // 在横排里占满剩下的宽度；手机上在竖排里不能写 flex 1（会被压成 0 高）。
  const statusText = status ? (
    <Text testID={`subscription-account-row-status-${provider}`} flex={wide ? 1 : undefined} minW={0} size="meta"
      tone={account.loggedIn ? 'secondary' : 'warning-dark'} numberOfLines={wide ? 1 : 2}>{status}</Text>
  ) : null;
  const quotaLines = bars.length && !status ? (
    <Row flex={wide ? 1 : undefined} minW={0} items="center" gap="side-item">
      {bars.map((bar) => <QuotaLine key={bar.key} bar={bar} fixedBar={wide} withReset={false} testID={`subscription-account-row-quota-${provider}-${bar.key}`} />)}
    </Row>
  ) : null;
  const inUse = active ? (
    <Text testID={`subscription-account-row-active-${provider}`} size="label" weight="semibold" tone="accent" numberOfLines={1} shrink={0}>{m.inUse}</Text>
  ) : null;
  const head = (
    <>
      <Dot color={active ? 'accent' : 'text-ghost'} size={6} />
      <Text size="body" weight="semibold" numberOfLines={1} shrink={0}>{accountName(account, locale)}</Text>
    </>
  );
  if (wide) {
    return (
      <Row testID={`subscription-account-row-${provider}`} items="center" gap="side-item" pl="group-indent" pr="row-x" minW={0}>
        <Row items="center" gap="icon-label" shrink={0}>{head}</Row>
        {statusText ?? quotaLines ?? <Row flex={1} />}
        {inUse}
      </Row>
    );
  }
  return (
    <Column testID={`subscription-account-row-${provider}`} gap="text-stack" pl="group-indent" pr="row-x">
      <Row items="center" gap="icon-label" minW={0}>
        {head}
        <Row flex={1} />
        {inUse}
      </Row>
      {statusText ?? quotaLines}
    </Column>
  );
}
