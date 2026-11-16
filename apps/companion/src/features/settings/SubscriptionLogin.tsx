import { Box, Button, Column, copyText, Icon, isWeb, openURL, Pressable, Row, Spinner, Text, TextField, useBreakpoint } from '@pi-lead-child/components';
import {
  SUBSCRIPTION_BASES,
  type Locale, type ModelSettingsDto, type SubscriptionBase, type SubscriptionLogin,
} from '@pi-lead-child/protocol';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useLocale } from '@/i18n';
import { useLeadName } from '@/state/hooks';

import { contextWindowLabel } from './modelSettingsModel';
import { subscriptionsMessages } from './subscriptions.messages';
import {
  accountIdentity, accountName, clockLabel, loginById, msUntil, openLogin, shortUrl, subscriptionOf, SUBSCRIPTION_LABEL_MAX,
} from './subscriptionsModel';
import { CopyButton, FooterStatus, SubscriptionMark, useNow, type PanelFooter } from './SubscriptionParts';
import { useModelAction } from './useModelAction';

// 订阅的登录（模型配置方案 C 的 S3，画板 C-Sub-Flows、C-Add-Mobile-Sub；spec D3）。
// 添加面板的订阅 tab 先选订阅（GitHub Copilot 或 Codex），再起账号名字、开始登录；订阅详情的「再加一个账号」「重新登录」直接到登录。
// 登录的状态全部来自模型设置 DTO 的 subscriptions.logins（daemon 每变一次都推 snapshot.required，页面重取）：
//   - Codex：浏览器登录。网页桌面上点「登录」时先开一个空白标签页，拿到登录地址后指过去；回调到运行 daemon 的 Mac 的
//     localhost:1455，登录自己往下走。手机上回调打不开：粘贴地址栏里的地址是主路径（awaitingCode 时可以交）。
//   - Copilot：设备码。大号等宽的码、复制、「打开 GitHub」、还剩多久失效。
// 登录、粘贴、取消都是 user_direct 的操作（start/submit/cancel_subscription_login），只有用户本人能在这里做。

export type LoginTarget = {
  base: SubscriptionBase;
  /** 重新登录这个账号。null：加一个新账号。 */
  provider: string | null;
  /** 重新登录时账号现在的名字（标题用）。 */
  label: string | null;
};

type Flow = { body: ReactNode; footer: PanelFooter | null; reset: () => void };

// 网页上点「登录」的那一刻开的空白标签页（不在点击里开会被浏览器拦下），拿到登录地址以后指过去。
function openBlankWindow(): Window | null {
  try {
    return typeof window !== 'undefined' && typeof window.open === 'function' ? window.open('', '_blank') : null;
  } catch {
    return null;
  }
}

function pointWindow(popup: Window, url: string): boolean {
  try {
    popup.opener = null;
    popup.location.href = url;
    return true;
  } catch {
    return false;
  }
}

/** 这次登录：自己开始的那一次；还没开始时，接上这种订阅（重新登录时是这个账号）没结束的那一次（例如关了面板又打开）。 */
function currentLogin(dto: ModelSettingsDto | null, target: LoginTarget | null, loginId: string | null): SubscriptionLogin | null {
  if (!dto || !target) return null;
  if (loginId !== null) return loginById(dto, loginId);
  const open = openLogin(dto, target.base);
  return open && (target.provider === null || open.provider === target.provider) ? open : null;
}

/**
 * 一次登录：开始以前是账号名字和「登录」，开始以后按 DTO 里的登录状态画。target 为 null 时什么都不画。
 * 返回内容和底部一行（状态、主按钮），由面板自己摆：抽屉里跟在内容后面，手机的悬浮面板钉在底部（P13.2b）。
 */
export function useSubscriptionLogin({ dto, target, onDone }: {
  dto: ModelSettingsDto | null;
  target: LoginTarget | null;
  onDone: () => void;
}): Flow {
  const locale = useLocale();
  const m = subscriptionsMessages(locale);
  const { desktop } = useBreakpoint();
  const { busy, run } = useModelAction();
  const [label, setLabel] = useState('');
  const [loginId, setLoginId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const popup = useRef<Window | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const login = currentLogin(dto, target, loginId);
  const currentId = login?.id ?? null;
  const waiting = login !== null && (login.state === 'starting' || login.state === 'waiting');
  const now = useNow(waiting);

  // 拿到登录地址时：把点击时开的空白标签页指过去。登录结束了还没用上时关掉它。
  const authUrl = login?.authUrl ?? null;
  const loginState = login?.state ?? null;
  useEffect(() => {
    const tab = popup.current;
    if (!tab) return;
    if (authUrl && currentId !== null) {
      popup.current = null;
      if (pointWindow(tab, authUrl)) setOpened(currentId);
      else tab.close();
    } else if (loginState === 'error' || loginState === 'cancelled' || loginState === 'done') {
      popup.current = null;
      tab.close();
    }
  }, [authUrl, loginState, currentId]);

  const reset = () => {
    setLabel('');
    setLoginId(null);
    setMessage(null);
    setOpened(null);
    popup.current?.close();
    popup.current = null;
  };

  if (!dto || !target) return { body: null, footer: null, reset };
  const { base, provider: targetProvider, label: targetLabel } = target;
  const name = m.names[base];

  const start = async () => {
    const trimmed = label.trim();
    if (trimmed.length > SUBSCRIPTION_LABEL_MAX) {
      setMessage({ text: m.labelTooLong, error: true });
      return;
    }
    setMessage(null);
    setOpened(null);
    // 网页桌面上的 Codex：在点击里先开空白标签页。手机上不开：回调到不了这台手机，靠粘贴地址。
    if (base === 'openai-codex' && isWeb && desktop) popup.current = openBlankWindow();
    const outcome = await run('start_subscription_login', {
      base,
      ...(targetProvider ? { provider: targetProvider } : {}),
      ...(!targetProvider && trimmed ? { label: trimmed } : {}),
    });
    if (!outcome.ok) {
      popup.current?.close();
      popup.current = null;
      setMessage({ text: outcome.error, error: true });
      return;
    }
    const result = outcome.result as { login?: string; note?: string | null } | null;
    setLoginId(result?.login ?? null);
    setMessage(result?.note ? { text: result.note, error: false } : null);
  };
  const cancel = async () => {
    if (currentId === null) return;
    const outcome = await run('cancel_subscription_login', { login: currentId });
    if (!outcome.ok) {
      setMessage({ text: outcome.error, error: true });
      return;
    }
    reset();
  };

  // 开始以前：重新登录只写账号；新账号要一个名字（可以不填）。
  if (!login || login.state === 'cancelled') {
    const body = (
      <Column testID="subscription-login-form" gap="form-field">
        {targetProvider ? (
          <Text size="body" tone="secondary">{m.reloginDetail}</Text>
        ) : (
          <Column gap="field">
            <Text size="label" weight="bold" tone="secondary">{m.labelField}</Text>
            <TextField testID="subscription-login-label" value={label} onChangeText={setLabel} placeholder={m.labelPlaceholder}
              variant="filled" size="sm" maxLength={SUBSCRIPTION_LABEL_MAX} autoCapitalize="none" autoCorrect={false} onSubmit={() => void start()} />
            <Text size="note" tone="muted">{m.labelHint}</Text>
          </Column>
        )}
        {message ? <Text testID="subscription-login-message" size="note" tone={message.error ? 'danger-dark' : 'secondary'}>{message.text}</Text> : null}
      </Column>
    );
    return {
      body,
      footer: {
        status: null,
        action: (
          <Button testID="subscription-login-start" label={busy ? m.starting : targetProvider ? m.reloginTo(targetLabel ?? name) : m.logIn(name)}
            size={desktop ? 'sm' : 'md'} disabled={busy} onPress={() => void start()} />
        ),
      },
      reset,
    };
  }

  const note = message ? <Text testID="subscription-login-message" size="note" tone={message.error ? 'danger-dark' : 'secondary'}>{message.text}</Text> : null;

  if (login.state === 'done') {
    return {
      body: <><LoginDone dto={dto} login={login} locale={locale} />{note}</>,
      footer: {
        status: null,
        action: <Button testID="subscription-login-done" label={m.done} size={desktop ? 'sm' : 'md'} onPress={() => { reset(); onDone(); }} />,
      },
      reset,
    };
  }

  if (login.state === 'error') {
    return {
      body: (
        <Column testID="subscription-login-error" gap="card-row">
          <Row items="center" gap="icon-label">
            <Icon name="close" size={16} color="danger-dark" />
            <Text size="card-title" weight="semibold" tone="danger-dark" numberOfLines={1}>{m.failed}</Text>
          </Row>
          {login.error ? <Text size="note" tone="danger-dark">{login.error}</Text> : null}
          {note}
        </Column>
      ),
      footer: {
        status: <Row flex={1}><Button testID="subscription-login-back" label={m.cancel} variant="ghost" tone="neutral" size="sm" onPress={reset} /></Row>,
        action: <Button testID="subscription-login-retry" label={busy ? m.starting : m.retry} size={desktop ? 'sm' : 'md'} disabled={busy} onPress={() => void start()} />,
      },
      reset,
    };
  }

  // 进行中：开始了、在等用户。
  const waited = m.waited(clockLabel(now.getTime() - new Date(login.startedAt).getTime()));
  const cancelButton = (
    <Button testID="subscription-login-cancel" label={m.cancel} variant="outline" tone="neutral" size={desktop ? 'sm' : 'md'} disabled={busy}
      onPress={() => void cancel()} />
  );
  if (base === 'github-copilot') {
    const left = login.deviceCode ? msUntil(login.deviceCode.expiresAt, now) : null;
    const expired = left !== null && left <= 0;
    const code = login.deviceCode;
    return {
      body: <><DeviceCode login={login} left={left} />{note}</>,
      footer: {
        status: <Row flex={1}>{cancelButton}</Row>,
        action: expired ? (
          <Button testID="subscription-login-new-code" label={busy ? m.starting : m.newCode} size={desktop ? 'sm' : 'md'} disabled={busy} onPress={() => void start()} />
        ) : code ? (
          <Button testID="subscription-login-open-github" label={m.copyAndOpenGithub} size={desktop ? 'sm' : 'md'}
            onPress={() => { void copyText(code.code).finally(() => openURL(code.uri)); }} />
        ) : null,
      },
      reset,
    };
  }
  return {
    body: (
      <>
        <BrowserLogin login={login} opened={opened !== null && opened === currentId} phone={!desktop} busy={busy}
          onSubmit={async (code) => {
            if (currentId === null) return false;
            const outcome = await run('submit_subscription_login_code', { login: currentId, code });
            if (!outcome.ok) setMessage({ text: outcome.error, error: true });
            else setMessage(null);
            return outcome.ok;
          }} />
        {note}
      </>
    ),
    footer: { status: <FooterStatus testID="subscription-login-waited" text={waited} />, action: cancelButton },
    reset,
  };
}

// ── Codex：浏览器登录 ─────────────────────────────────────────────────────────

function BrowserLogin({ login, opened, phone, busy, onSubmit }: {
  login: SubscriptionLogin;
  opened: boolean;
  phone: boolean;
  busy: boolean;
  onSubmit: (code: string) => Promise<boolean>;
}) {
  const m = subscriptionsMessages(useLocale());
  const url = login.authUrl;
  const [pasteOpen, setPasteOpen] = useState(false);
  const [code, setCode] = useState('');
  const submit = async () => {
    const value = code.trim();
    if (!value) return;
    if (await onSubmit(value)) setCode('');
  };
  const paste = (
    <Column testID="subscription-login-paste" gap="field">
      <Text size="label" weight="bold" tone="secondary">{m.pasteTitle}</Text>
      <Text size="note" tone="secondary">{phone ? m.pastePhone : m.pasteOtherComputer}</Text>
      <TextField testID="subscription-login-paste-field" value={code} onChangeText={setCode} placeholder={m.pastePlaceholder} variant="filled" size="sm"
        mono keyboardType="url" autoComplete="off" autoCapitalize="none" autoCorrect={false} disabled={!login.awaitingCode} onSubmit={() => void submit()} />
      {login.awaitingCode ? (
        <Row>
          <Button testID="subscription-login-paste-submit" label={busy ? m.submitting : m.submit} variant="outline" tone="neutral" size="sm"
            disabled={busy || !code.trim()} onPress={() => void submit()} />
        </Row>
      ) : <Text size="note" tone="muted">{m.pasteWaiting}</Text>}
    </Column>
  );
  // 手机：打开登录页、复制地址，粘贴是主路径。
  if (phone) {
    return (
      <Column testID="subscription-login-browser" gap="card-section">
        {url ? (
          <Row items="center" gap="actions" flexWrap="wrap">
            <Button testID="subscription-login-open" label={m.openLoginPage} variant="outline" tone="neutral" size="sm" onPress={() => openURL(url)} />
            <CopyButton testID="subscription-login-copy" text={url} label={m.copyLoginUrl} />
          </Row>
        ) : (
          <Row items="center" gap="icon-label"><Spinner size={14} /><Text size="secondary" tone="secondary">{m.starting}</Text></Row>
        )}
        {paste}
        {login.progress ? <Text size="note" tone="muted">{login.progress}</Text> : null}
      </Column>
    );
  }
  return (
    <Column testID="subscription-login-browser" gap="card-section">
      <Column gap="card-row">
        <Step index={1} done={opened} title={url ? (opened ? m.stepOpened : m.stepOpen) : m.starting} active={!url} />
        <Step index={2} title={m.stepLogin} hint={m.stepLoginHint} active={Boolean(url)} />
        <Step index={3} title={m.stepModels} />
      </Column>
      {url ? (
        <Column gap="field">
          <Text size="note" tone="secondary">{m.notOpened}</Text>
          <Row items="center" gap="actions" flexWrap="wrap">
            <Button testID="subscription-login-open" label={m.openLoginPage} variant="outline" tone="neutral" size="xs" onPress={() => openURL(url)} />
            <CopyButton testID="subscription-login-copy" text={url} label={m.copyLoginUrl} variant="outline" size="xs" />
          </Row>
        </Column>
      ) : null}
      {login.progress ? <Text size="note" tone="muted">{login.progress}</Text> : null}
      {pasteOpen ? paste : (
        <Row>
          <Button testID="subscription-login-paste-toggle" label={m.pasteInstead} variant="link" tone="neutral" size="xs" onPress={() => setPasteOpen(true)} />
        </Row>
      )}
    </Column>
  );
}

// 一步：圆里的序号（做完了是勾），标题，可以有一句说明。正在等的那一步标题加粗。
function Step({ index, title, hint, done = false, active = false }: { index: number; title: string; hint?: string; done?: boolean; active?: boolean }) {
  return (
    <Row items="flex-start" gap="icon-label">
      {/* 组件规格：序号圆的直径 18，和单选圈一样大 */}
      <Box w={18} h={18} shrink={0} rounded="full" items="center" justify="center" bg={done ? 'success-soft' : active ? 'accent-soft' : 'surface-muted'}>
        {done ? <Icon name="check" size={12} color="success-dark" /> : (
          <Text size="meta" weight="bold" tone={active ? 'accent' : 'muted'}>{String(index)}</Text>
        )}
      </Box>
      <Column flex={1} minW={0} gap="text-stack">
        <Text size="body" weight={active ? 'semibold' : 'regular'} tone={done || active ? 'default' : 'muted'}>{title}</Text>
        {hint && active ? <Text size="note" tone="muted">{hint}</Text> : null}
      </Column>
    </Row>
  );
}

// ── Copilot：设备码 ───────────────────────────────────────────────────────────

function DeviceCode({ login, left }: { login: SubscriptionLogin; left: number | null }) {
  const m = subscriptionsMessages(useLocale());
  const code = login.deviceCode;
  if (!code) {
    return (
      <Row testID="subscription-login-device-pending" items="center" gap="icon-label">
        <Spinner size={14} />
        <Text size="secondary" tone="secondary">{login.progress ?? m.gettingCode}</Text>
      </Row>
    );
  }
  const expired = left !== null && left <= 0;
  return (
    <Column testID="subscription-login-device" gap="card-row">
      <Text size="body">{m.deviceIntro}</Text>
      <Text size="code" mono tone="accent" numberOfLines={1}>{shortUrl(code.uri)}</Text>
      <Row items="center" gap="side-item" px="inset-x" py="inset-y" rounded="lg" borderWidth={1} borderColor="border">
        <Text testID="subscription-login-device-code" flex={1} minW={0} size="stat-value" mono weight="bold" letterSpacing={2} numberOfLines={1}
          tone={expired ? 'muted' : 'default'}>{code.code}</Text>
        <CopyButton testID="subscription-login-device-copy" text={code.code} label={m.copy} />
      </Row>
      <Row items="center" gap="icon-label">
        {expired ? null : <Spinner size={14} />}
        <Text testID="subscription-login-device-expiry" flex={1} minW={0} size="note" tone={expired ? 'warning-dark' : 'secondary'}>
          {expired ? m.expired : [m.deviceWaiting, left !== null ? m.expiresIn(clockLabel(left)) : null].filter(Boolean).join(' ')}
        </Text>
      </Row>
    </Column>
  );
}

// ── 登录好了：账号和读到的模型 ─────────────────────────────────────────────────

const SHOWN_MODELS = 3;

function LoginDone({ dto, login, locale }: { dto: ModelSettingsDto; login: SubscriptionLogin; locale: Locale }) {
  const m = subscriptionsMessages(locale);
  const subscription = subscriptionOf(dto, login.base);
  const account = subscription?.accounts.find((entry) => entry.provider === login.provider) ?? null;
  const models = subscription?.models ?? [];
  const identity = account ? accountIdentity(account) : '';
  return (
    <Column testID="subscription-login-result" gap="card-row">
      <Row items="center" gap="icon-label">
        <Icon name="check" size={16} color="success-dark" />
        <Text size="card-title" weight="semibold" numberOfLines={1} shrink={0}>{m.loggedIn}</Text>
        <Text flex={1} minW={0} size="secondary" tone="secondary" numberOfLines={1}>
          {[account ? accountName(account, locale) : login.label, identity].filter(Boolean).join(' · ')}
        </Text>
      </Row>
      {models.length ? (
        <Column gap="field">
          <Text testID="subscription-login-result-models" size="label" weight="bold" tone="secondary">{m.readModels(models.length)}</Text>
          <Column borderWidth={1} borderColor="border" rounded="md" px="inset-x" py="inset-y" gap="card-row">
            {models.slice(0, SHOWN_MODELS).map((model) => (
              <Row key={model.model} items="center" gap="inline-item">
                <Text flex={1} minW={0} size="body" weight="semibold" numberOfLines={1}>{model.name ?? model.id}</Text>
                <Text size="meta" tone="muted" numberOfLines={1} shrink={0}>
                  {[model.image ? m.image : null, contextWindowLabel(model.contextWindow, locale)].filter(Boolean).join(' · ')}
                </Text>
              </Row>
            ))}
            {models.length > SHOWN_MODELS ? <Text size="meta" tone="muted">{m.moreModels(models.length - SHOWN_MODELS)}</Text> : null}
          </Column>
        </Column>
      ) : <Text size="note" tone="muted">{m.readingModels}</Text>}
    </Column>
  );
}

// ── 添加面板的订阅 tab ─────────────────────────────────────────────────────────

/**
 * 添加面板的订阅 tab：先列两种订阅（已连接几个、正在等你登录），点一种进入它的登录。
 * 登录完点「完成」关掉面板（onDone）。
 */
export function useSubscriptionAddTab({ dto, onDone }: { dto: ModelSettingsDto | null; onDone: () => void }): Flow {
  const locale = useLocale();
  const m = subscriptionsMessages(locale);
  const leadName = useLeadName();
  const [base, setBase] = useState<SubscriptionBase | null>(null);
  const flow = useSubscriptionLogin({ dto, target: base ? { base, provider: null, label: null } : null, onDone });
  const reset = () => {
    flow.reset();
    setBase(null);
  };
  if (!dto) return { body: null, footer: null, reset };
  if (base) {
    return {
      body: (
        <Column gap="card-section">
          <Pressable testID="subscription-add-back" onPress={reset} flexDirection="row" items="center" gap="icon-label" self="flex-start" feedback="none">
            <Icon name="chevron-left" size={14} color="text-secondary" />
            <Text size="label" weight="semibold" tone="secondary" numberOfLines={1}>{m.allSubscriptions}</Text>
          </Pressable>
          <Row items="center" gap="side-item">
            <SubscriptionMark base={base} />
            <Column flex={1} minW={0} gap="text-stack">
              <Text size="card-title" weight="semibold" numberOfLines={1}>{m.names[base]}</Text>
              <Text size="meta" tone="secondary" numberOfLines={1}>{m.kinds[base]}</Text>
            </Column>
          </Row>
          {flow.body}
        </Column>
      ),
      footer: flow.footer,
      reset,
    };
  }
  return {
    body: (
      <Column testID="subscription-add-choose" gap="card-section">
        <Text size="note" tone="secondary">{m.intro}</Text>
        <Column borderWidth={1} borderColor="border" rounded="lg" overflow="hidden">
          {SUBSCRIPTION_BASES.map((entry, index) => {
            const subscription = subscriptionOf(dto, entry);
            const accounts = subscription?.accounts ?? [];
            const pending = openLogin(dto, entry);
            const sub = pending ? m.waitingForYou
              : accounts.length ? [m.connected(accounts.length), accounts.map((account) => accountName(account, locale)).join(locale === 'zh' ? '、' : ', ')].join(' · ')
              : m.kinds[entry];
            return (
              <Pressable
                key={entry}
                testID={`subscription-add-${entry}`}
                aria-label={m.logIn(m.names[entry])}
                onPress={() => setBase(entry)}
                flexDirection="row"
                items="center"
                gap="side-item"
                px="row-x"
                py="row-y"
                borderTopWidth={index === 0 ? 0 : 1}
                borderTopColor="border-soft"
                bg={{ default: 'surface', hover: 'surface-subtle', press: 'surface-muted' }}
                feedback="none"
              >
                <SubscriptionMark base={entry} />
                <Column flex={1} minW={0} gap="text-stack">
                  <Text size="card-title" weight="semibold" numberOfLines={1}>{m.names[entry]}</Text>
                  <Text testID={`subscription-add-${entry}-sub`} size="meta" tone={pending ? 'accent' : 'secondary'} numberOfLines={1}>{sub}</Text>
                </Column>
                <Text size="label" weight="semibold" tone="accent" numberOfLines={1} shrink={0}>{accounts.length ? m.addAccountShort : m.logInShort}</Text>
                <Icon name="chevron-right" size={14} color="text-ghost" />
              </Pressable>
            );
          })}
        </Column>
        <Text size="note" tone="muted">{m.footnote(leadName)}</Text>
      </Column>
    ),
    footer: null,
    reset,
  };
}
