import {
  Button, ChoiceGroup, Chip, Column, Dot, FloatingSheet, Icon, IconButton, OptionPills, Popover, Pressable, RecordRow, Row, Text, TextField, useBreakpoint,
} from '@pi-lead-child/components';
import type {
  Locale, ModelSettingsDto, Subscription, SubscriptionAccount, SubscriptionBase, SubscriptionRole, SubscriptionStrategy, SubscriptionWindow,
} from '@pi-lead-child/protocol';
import { useEffect, useState, type ReactNode } from 'react';

import { useLocale } from '@/i18n';
import { useModelSettings } from '@/state/hooks';

import { useSettingsDrawer } from './SettingsDesktopShell';
import { subscriptionsMessages } from './subscriptions.messages';
import {
  accountIdentity, accountName, activeAccount, EMPTY_WINDOW_FORM, quotaBars, resetLabel, subscriptionOf, subscriptionRoles, SUBSCRIPTION_DAYS,
  SUBSCRIPTION_LABEL_MAX, toggleDay, windowFromForm, windowLabel, type WindowForm,
} from './subscriptionsModel';
import { useSubscriptionLogin, type LoginTarget } from './SubscriptionLogin';
import { DrawerFooter, QuotaLine, SubscriptionMark, type PanelFooter } from './SubscriptionParts';
import { useModelAction } from './useModelAction';

// 订阅详情（模型配置方案 C 的 S3，画板 C-Sub-Detail）：点接入列表里的一种订阅打开。桌面上是设置页右边的抽屉（和「添加模型」同一个），
// 手机上是悬浮底部面板（P13.2）。从上到下：
//   头部：标志、名字、一句（套餐、模型数、在分工里的位置）、「再加一个账号」。
//   账号：一个账号一张小卡：名字、邮箱和套餐、「正在用」、「⋯」（改名字、重新登录、退出登录并删掉，删之前原地确认 P5.3）；
//         下面是每个额度窗口一条（只有 Codex 有，Copilot 写明没有额度查询）。
//   换号方式：单选卡（轮流 / 先用额度最多的 / 按时间段），选了马上保存（set_subscription_strategy）。
//   按时间段时，每个账号的角色（优先 / 随时 / 最后才用）和时间段（哪几天 + 钟点），改了马上保存（set_subscription_schedule）。
// 后端拒绝时（例如账号的模型还在分工里）写出拒绝的原因，不把按钮变成点不了的样子。

const DRAWER_KEY = 'model-subscription';

export function SubscriptionDetailPanel({ base, onClose }: { base: SubscriptionBase | null; onClose: () => void }) {
  const { desktop } = useBreakpoint();
  const host = useSettingsDrawer();
  const m = subscriptionsMessages(useLocale());
  const inDrawer = desktop && host !== null;
  // 面板收下的动画播完以前还要画内容：记住最后一次打开的订阅。
  const [shown, setShown] = useState<SubscriptionBase | null>(base);
  useEffect(() => {
    if (base) setShown(base);
  }, [base]);
  useEffect(() => {
    if (!inDrawer || !base || !host) return undefined;
    host.show(DRAWER_KEY, <SubscriptionDetailContent key={base} base={base} frame="drawer" onClose={onClose} />, onClose);
    return () => host.hide(DRAWER_KEY);
  }, [inDrawer, base, host, onClose]);
  if (inDrawer || !shown) return null;
  return (
    <SubscriptionDetailContent
      key={shown}
      base={shown}
      frame="sheet"
      onClose={onClose}
      render={(body, footer) => (
        <FloatingSheet testID="subscription-detail-sheet" open={base !== null} onClose={onClose} label={m.names[shown]} footer={footer}>{body}</FloatingSheet>
      )}
    />
  );
}

type Mode = { kind: 'detail' } | { kind: 'login'; target: LoginTarget };

function SubscriptionDetailContent({ base, frame, onClose, render }: {
  base: SubscriptionBase;
  frame: 'drawer' | 'sheet';
  onClose: () => void;
  render?: (body: ReactNode, footer: ReactNode) => ReactNode;
}) {
  const locale = useLocale();
  const m = subscriptionsMessages(locale);
  const { modelSettings } = useModelSettings();
  const [mode, setMode] = useState<Mode>({ kind: 'detail' });
  const login = useSubscriptionLogin({
    dto: modelSettings, target: mode.kind === 'login' ? mode.target : null, onDone: () => setMode({ kind: 'detail' }),
  });
  const subscription = modelSettings ? subscriptionOf(modelSettings, base) : null;
  const back = () => {
    login.reset();
    setMode({ kind: 'detail' });
  };

  const header = (
    <Row items="center" gap="side-item">
      <SubscriptionMark base={base} />
      <Column flex={1} minW={0} gap="text-stack">
        <Text size="sheet-title" weight="bold" numberOfLines={1}>{m.names[base]}</Text>
        {modelSettings && subscription ? (
          <Text testID="subscription-detail-sub" size="meta" tone="secondary" numberOfLines={1}>{detailSub(modelSettings, subscription, locale)}</Text>
        ) : null}
      </Column>
      {frame === 'drawer' ? (
        <IconButton testID="subscription-detail-close" icon="close" label={m.close} variant="ghost" tone="neutral" size="sm" onPress={onClose} />
      ) : null}
    </Row>
  );

  let body: ReactNode;
  let footer: PanelFooter | null = null;
  if (!modelSettings || !subscription) {
    body = <Text size="body" tone="muted">{m.starting}</Text>;
  } else if (mode.kind === 'login') {
    body = (
      <Column gap="card-section">
        <Pressable testID="subscription-detail-back" onPress={back} flexDirection="row" items="center" gap="icon-label" self="flex-start" feedback="none">
          <Icon name="chevron-left" size={14} color="text-secondary" />
          <Text size="label" weight="semibold" tone="secondary" numberOfLines={1}>{m.back}</Text>
        </Pressable>
        {login.body}
      </Column>
    );
    footer = login.footer;
  } else {
    body = (
      <SubscriptionAccounts dto={modelSettings} subscription={subscription} locale={locale}
        onLogin={(target) => setMode({ kind: 'login', target })} />
    );
  }

  const content = (
    <Column testID="subscription-detail" gap="card-section">
      {header}
      {body}
    </Column>
  );
  const footerNode = footer ? (frame === 'sheet' ? <>{footer.status ?? <Row flex={1} />}{footer.action}</> : <DrawerFooter footer={footer} />) : null;
  if (render) return <>{render(content, frame === 'sheet' ? footerNode : null)}</>;
  return (
    <Column gap="card-section">
      {content}
      {footerNode}
    </Column>
  );
}

function detailSub(dto: ModelSettingsDto, subscription: Subscription, locale: Locale): string {
  const m = subscriptionsMessages(locale);
  return [m.kinds[subscription.base], m.models(subscription.models.length), ...subscriptionRoles(dto, subscription.base, locale)].join(' · ');
}

function SubscriptionAccounts({ dto, subscription, locale, onLogin }: {
  dto: ModelSettingsDto;
  subscription: Subscription;
  locale: Locale;
  onLogin: (target: LoginTarget) => void;
}) {
  const m = subscriptionsMessages(locale);
  const active = activeAccount(dto, subscription);
  const scheduled = subscription.strategy === 'scheduled';
  return (
    <Column gap="page-section">
      <Column gap="card-row">
        <Row items="center" gap="inline-item">
          <Text flex={1} minW={0} size="label" weight="bold" tone="secondary" numberOfLines={1}>{scheduled ? m.accountsAndHours : m.accountsTitle}</Text>
          <Button testID="subscription-detail-add" label={m.addAccount} icon="plus" variant="link" size="xs"
            onPress={() => onLogin({ base: subscription.base, provider: null, label: null })} />
        </Row>
        {subscription.accounts.map((account) => (
          <AccountCard key={account.provider} account={account} subscription={subscription} active={active === account.provider} scheduled={scheduled}
            locale={locale} onRelogin={() => onLogin({ base: subscription.base, provider: account.provider, label: accountName(account, locale) })} />
        ))}
        <Text size="note" tone="muted">{subscription.quotaSupported ? m.menuHint : m.copilotHint}</Text>
      </Column>
      <StrategyChoice subscription={subscription} locale={locale} />
    </Column>
  );
}

// ── 一个账号 ─────────────────────────────────────────────────────────────────

type AccountMode = 'view' | 'rename' | 'remove';

function AccountCard({ account, subscription, active, scheduled, locale, onRelogin }: {
  account: SubscriptionAccount;
  subscription: Subscription;
  active: boolean;
  scheduled: boolean;
  locale: Locale;
  onRelogin: () => void;
}) {
  const m = subscriptionsMessages(locale);
  const { busy, run } = useModelAction();
  const [mode, setMode] = useState<AccountMode>('view');
  const [label, setLabel] = useState('');
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const name = accountName(account, locale);
  const identity = accountIdentity(account);
  const now = new Date();
  const bars = quotaBars(account, now, locale);
  const provider = account.provider;
  const rename = async () => {
    const value = label.trim();
    if (!value) return;
    const outcome = await run('rename_subscription_account', { provider, label: value });
    if (!outcome.ok) {
      setMessage({ text: outcome.error, error: true });
      return;
    }
    setMessage(null);
    setMode('view');
  };
  const remove = async () => {
    const outcome = await run('remove_subscription_account', { provider });
    // 拒绝时（例如它的模型还在分工里）原地写出原因，确认行收回。
    if (!outcome.ok) setMessage({ text: outcome.error, error: true });
    else setMessage(null);
    setMode('view');
  };
  return (
    <Column testID={`subscription-account-${provider}`} gap="card-row" px="inset-x" py="inset-y" rounded="lg" borderWidth={1}
      borderColor={active ? 'accent-soft' : 'border'}>
      <Row items="center" gap="inline-item" minW={0}>
        <Dot color={active ? 'accent' : 'text-ghost'} size={7} />
        <Text size="card-title" weight="semibold" numberOfLines={1} shrink={0}>{name}</Text>
        <Text flex={1} minW={0} size="meta" tone="secondary" numberOfLines={1}>{identity}</Text>
        {active ? <Text testID={`subscription-account-active-${provider}`} size="label" weight="semibold" tone="accent" numberOfLines={1} shrink={0}>{m.inUse}</Text> : null}
        <Popover testID={`subscription-account-more-${provider}`} label={m.moreFor(name)} title={name} width={280}
          trigger={<Icon name="more" size={16} color="text-secondary" />}>
          {(close) => (
            <Column>
              <RecordRow testID={`subscription-account-rename-${provider}`} title={m.rename} detail={m.renameDetail}
                onPress={() => { close(); setLabel(account.label ?? ''); setMessage(null); setMode('rename'); }} />
              <RecordRow divider testID={`subscription-account-relogin-${provider}`} title={m.relogin} detail={m.reloginDetail}
                onPress={() => { close(); onRelogin(); }} />
              <RecordRow divider testID={`subscription-account-remove-${provider}`} title={m.remove} detail={m.removeDetail}
                onPress={() => { close(); setMessage(null); setMode('remove'); }} />
            </Column>
          )}
        </Popover>
      </Row>
      <AccountStatus account={account} subscription={subscription} now={now} locale={locale} onLogin={onRelogin} />
      {/* 在横排里伸缩（QuotaLine 是 flex 1）：直接放进竖排会被压成 0 高。 */}
      {bars.map((bar) => (
        <Row key={bar.key}><QuotaLine bar={bar} fixedBar={false} withReset testID={`subscription-account-quota-${provider}-${bar.key}`} /></Row>
      ))}
      {scheduled ? <ScheduleEditor account={account} locale={locale} /> : null}
      {mode === 'rename' ? (
        <Row items="center" gap="actions">
          <TextField testID={`subscription-account-label-${provider}`} value={label} onChangeText={setLabel} placeholder={m.labelPlaceholder} variant="filled"
            size="sm" maxLength={SUBSCRIPTION_LABEL_MAX} autoFocus grow onSubmit={() => void rename()} />
          <Button testID={`subscription-account-label-save-${provider}`} label={busy ? m.saving : m.save} size="sm" disabled={busy || !label.trim()}
            onPress={() => void rename()} />
          <Button label={m.cancel} variant="ghost" tone="neutral" size="sm" onPress={() => setMode('view')} />
        </Row>
      ) : null}
      {mode === 'remove' ? (
        // 原地确认（P5.3）：确认行换掉原来的操作。
        <Row testID={`subscription-account-remove-confirm-${provider}`} items="center" gap="actions" flexWrap="wrap">
          <Text flex={1} minW={0} size="body" tone="secondary">{m.removeConfirm(name)}</Text>
          <Button testID={`subscription-account-remove-yes-${provider}`} label={busy ? m.removing : m.removeYes} variant="outline" tone="danger" size="sm"
            disabled={busy} onPress={() => void remove()} />
          <Button label={m.cancel} variant="ghost" tone="neutral" size="sm" disabled={busy} onPress={() => setMode('view')} />
        </Row>
      ) : null}
      {message ? (
        <Text testID={`subscription-account-message-${provider}`} size="note" tone={message.error ? 'danger-dark' : 'secondary'}>{message.text}</Text>
      ) : null}
    </Column>
  );
}

// 账号名字下面的状态：没登录（可以登录）、限流冷却、额度读不到的原因、还没读到额度。
function AccountStatus({ account, subscription, now, locale, onLogin }: {
  account: SubscriptionAccount; subscription: Subscription; now: Date; locale: Locale; onLogin: () => void;
}) {
  const m = subscriptionsMessages(locale);
  if (!account.loggedIn) {
    return (
      <Row items="center" gap="inline-item">
        <Text flex={1} minW={0} size="note" tone="warning-dark" numberOfLines={1}>{m.notLoggedIn}</Text>
        <Button testID={`subscription-account-login-${account.provider}`} label={m.logInShort} variant="link" size="xs" onPress={onLogin} />
      </Row>
    );
  }
  const lines: string[] = [];
  if (account.coolingUntil) lines.push(m.cooling(resetLabel(account.coolingUntil, now, locale)));
  if (account.quota?.problem) lines.push(account.quota.problem);
  else if (subscription.quotaSupported && !account.quota) lines.push(m.quotaNotRead);
  if (!lines.length) return null;
  return <Text size="note" tone={account.coolingUntil ? 'warning-dark' : 'muted'}>{lines.join(' · ')}</Text>;
}

// ── 换号方式 ─────────────────────────────────────────────────────────────────

const STRATEGIES: readonly SubscriptionStrategy[] = ['round-robin', 'quota-first', 'scheduled'];

function StrategyChoice({ subscription, locale }: { subscription: Subscription; locale: Locale }) {
  const m = subscriptionsMessages(locale);
  const { busy, run } = useModelAction();
  const [error, setError] = useState<string | null>(null);
  const base = subscription.base;
  if (subscription.accounts.length < 2) {
    return (
      <Column gap="field">
        <Text size="label" weight="bold" tone="secondary">{m.strategyTitle}</Text>
        <Text testID="subscription-strategy-one" size="note" tone="secondary">{m.strategyOneAccount}</Text>
      </Column>
    );
  }
  const choose = async (strategy: SubscriptionStrategy) => {
    setError(null);
    const outcome = await run('set_subscription_strategy', { base, strategy });
    if (!outcome.ok) setError(outcome.error);
  };
  const options = STRATEGIES.map((strategy) => ({
    id: strategy,
    label: m.strategies[strategy],
    description: strategy === 'quota-first' && !subscription.quotaSupported ? m.quotaFirstCopilot : m.strategyHints[strategy],
  }));
  return (
    <Column gap="card-row">
      <Text size="label" weight="bold" tone="secondary">{m.strategyTitle}</Text>
      {subscription.strategy === 'custom' ? <Text size="note" tone="secondary">{m.strategyCustom}</Text> : null}
      <ChoiceGroup testID="subscription-strategy" variant="radio" accessibilityLabel={m.strategyTitle} options={options}
        value={subscription.strategy === 'custom' ? null : subscription.strategy} disabled={busy}
        optionTestID={(id) => `subscription-strategy-${id}`}
        onSelect={(id) => { if (id !== subscription.strategy) void choose(id as SubscriptionStrategy); }} />
      {error ? <Text testID="subscription-strategy-error" size="note" tone="danger-dark">{m.notSaved(error)}</Text> : null}
      <Text testID="subscription-strategy-note" size="meta" tone="muted">{busy ? m.saving : m.strategyNote}</Text>
    </Column>
  );
}

// ── 按时间段：一个账号的角色和时间段 ───────────────────────────────────────────

const ROLES: readonly SubscriptionRole[] = ['preferred', 'default', 'overflow'];

function ScheduleEditor({ account, locale }: { account: SubscriptionAccount; locale: Locale }) {
  const m = subscriptionsMessages(locale);
  const { busy, run } = useModelAction();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<WindowForm>(EMPTY_WINDOW_FORM);
  const [error, setError] = useState<string | null>(null);
  const provider = account.provider;
  const save = async (role: SubscriptionRole, windows: SubscriptionWindow[]) => {
    setError(null);
    const outcome = await run('set_subscription_schedule', { provider, role, windows });
    if (!outcome.ok) setError(outcome.error);
    return outcome.ok;
  };
  const add = async () => {
    const parsed = windowFromForm(form, locale);
    if (!parsed.ok) {
      setError(parsed.problem);
      return;
    }
    if (await save(account.role, [...account.windows, parsed.window])) {
      setAdding(false);
      setForm(EMPTY_WINDOW_FORM);
    }
  };
  return (
    <Column testID={`subscription-schedule-${provider}`} gap="card-row" pt="card-row" borderTopWidth={1} borderTopColor="border-soft">
      <OptionPills testID={`subscription-role-${provider}`} label={m.roleLabel} disabled={busy}
        options={ROLES.map((role) => ({ value: role, label: m.roles[role] }))} selected={account.role}
        onSelect={(role) => { if (role !== account.role) void save(role as SubscriptionRole, account.windows); }} />
      <Text size="note" tone="muted">{m.roleHints[account.role]}</Text>
      {account.windows.map((window, index) => (
        <Row key={`${windowLabel(window, locale)}-${index}`} items="center" gap="inline-item">
          <Icon name="clock" size={14} color="text-secondary" />
          <Text flex={1} minW={0} size="body" numberOfLines={1}>{windowLabel(window, locale)}</Text>
          <IconButton testID={`subscription-window-remove-${provider}-${index}`} label={m.removeHours(windowLabel(window, locale))} icon="close" variant="ghost"
            tone="neutral" size="xs" disabled={busy} onPress={() => void save(account.role, account.windows.filter((_, other) => other !== index))} />
        </Row>
      ))}
      {account.windows.length === 0 && account.role === 'preferred' ? <Text size="note" tone="muted">{m.alwaysInHours}</Text> : null}
      {adding ? (
        <Column testID={`subscription-window-form-${provider}`} gap="field">
          <Row gap="chips" flexWrap="wrap" aria-label={m.days}>
            {SUBSCRIPTION_DAYS.map((day) => (
              <Chip key={day} testID={`subscription-window-day-${provider}-${day}`} label={m.dayNames[day]} selected={form.days.includes(day)}
                onPress={() => setForm((current) => ({ ...current, days: toggleDay(current.days, day) }))} />
            ))}
          </Row>
          <Row items="center" gap="inline-item">
            <Text size="body" tone="secondary" numberOfLines={1} shrink={0}>{m.from}</Text>
            <Column flex={1} minW={0}>
              <TextField testID={`subscription-window-from-${provider}`} value={form.from} onChangeText={(from) => setForm((current) => ({ ...current, from }))}
                variant="filled" size="sm" mono keyboardType="number-pad" maxLength={2} accessibilityLabel={m.from} />
            </Column>
            <Text size="body" tone="secondary" numberOfLines={1} shrink={0}>{m.to}</Text>
            <Column flex={1} minW={0}>
              <TextField testID={`subscription-window-to-${provider}`} value={form.to} onChangeText={(to) => setForm((current) => ({ ...current, to }))}
                variant="filled" size="sm" mono keyboardType="number-pad" maxLength={2} accessibilityLabel={m.to} />
            </Column>
            <Text size="body" tone="secondary" numberOfLines={1} shrink={0}>{m.hourUnit}</Text>
          </Row>
          <Row items="center" gap="actions">
            <Button testID={`subscription-window-add-${provider}`} label={busy ? m.saving : m.save} size="sm" disabled={busy} onPress={() => void add()} />
            <Button label={m.cancel} variant="ghost" tone="neutral" size="sm" onPress={() => { setAdding(false); setError(null); }} />
          </Row>
        </Column>
      ) : (
        <Row>
          <Button testID={`subscription-window-new-${provider}`} label={m.addHours} icon="plus" variant="link" size="xs" onPress={() => setAdding(true)} />
        </Row>
      )}
      {error ? <Text testID={`subscription-schedule-error-${provider}`} size="note" tone="danger-dark">{m.notSaved(error)}</Text> : null}
    </Column>
  );
}
