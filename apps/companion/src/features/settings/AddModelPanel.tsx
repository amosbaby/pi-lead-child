import {
  Button, Column, FloatingSheet, Icon, IconButton, OptionPills, Pressable, Row, SegmentedControl, Text, TextField, useBreakpoint,
} from '@pi-lead-child/components';
import type { Locale, ModelProvider, ModelProviderApi, ModelSettingsDto } from '@pi-lead-child/protocol';
import { useEffect, useState, type ReactNode } from 'react';

import { VIBEPROXY_BASE_URL } from '@/features/onboarding/firstRunModel';
import { useLocale } from '@/i18n';
import { useLeadName, useModelSettings } from '@/state/hooks';

import { plaintextNote } from './memoryModel';
import { modelMessages } from './model.messages';
import {
  addModelRequest, apiLabels, hasSubscriptionField, PROVIDER_KINDS, providerAccounts, providerKind, providerRoutes, suggestedProviderName, untilLabel,
  type AddModelForm, type ProviderKind,
} from './modelSettingsModel';
import { useSettingsDrawer } from './SettingsDesktopShell';
import { useSubscriptionAddTab } from './SubscriptionLogin';
import { useModelAction } from './useModelAction';

// 设置 → 模型的「添加模型」（模型配置方案 C，2026-11-16，画板 C-Settings-Desktop、C-Key-Forms、C-Add-Mobile-Key）。
// 桌面上是设置页右边的抽屉（SettingsDesktopShell 的 SlidePanel）；手机上（或者没有抽屉的地方）是悬浮底部面板（P13.2）。
// 从上到下：接入方式（API key / 订阅，daemon 给了订阅时才有）→ API key 的种类（自定义、vibeproxy、magpie）→ 字段。
// 订阅 tab（切片 S3）是 SubscriptionLogin 的 useSubscriptionAddTab：选 GitHub Copilot 或 Codex，起名字，登录。
// 添加用现有的 save_provider（user_direct）。添加以后读新的模型设置，写出读到了什么：模型数、账号、路由别名，或者目录的问题。

const DRAWER_KEY = 'model-add';

export type AddModelPanelProps = {
  open: boolean;
  onClose: () => void;
  // 换掉订阅 tab 的内容（测试用）。不给时是 useSubscriptionAddTab。daemon 给了 subscriptions 字段时才画 tab。
  subscriptionTab?: ReactNode;
};

export function AddModelPanel({ open, onClose, subscriptionTab }: AddModelPanelProps) {
  const { desktop } = useBreakpoint();
  const host = useSettingsDrawer();
  const m = modelMessages(useLocale());
  const inDrawer = desktop && host !== null;
  useEffect(() => {
    if (!inDrawer || !open || !host) return undefined;
    host.show(DRAWER_KEY, <AddModelContent frame="drawer" onClose={onClose} subscriptionTab={subscriptionTab} />, onClose);
    return () => host.hide(DRAWER_KEY);
  }, [inDrawer, open, host, onClose, subscriptionTab]);
  if (inDrawer) return null;
  return (
    <FloatingSheetFrame open={open} onClose={onClose} label={m.addModel} subscriptionTab={subscriptionTab} />
  );
}

// 手机的面板：内容在 AddModelContent 里，操作条钉在底部（P13.2b）。
function FloatingSheetFrame({ open, onClose, label, subscriptionTab }: { open: boolean; onClose: () => void; label: string; subscriptionTab?: ReactNode }) {
  return (
    <AddModelContent
      frame="sheet"
      onClose={onClose}
      subscriptionTab={subscriptionTab}
      render={(body, footer, close) => (
        <FloatingSheet testID="model-add-sheet" open={open} onClose={close} label={label} footer={footer}>{body}</FloatingSheet>
      )}
    />
  );
}

type Tab = 'key' | 'subscription';
type Message = { text: string; error: boolean };

const EMPTY_FORM: AddModelForm = { kind: 'custom', name: '', baseUrl: '', apiKey: '', api: 'openai-completions' };

function AddModelContent({ frame, onClose, subscriptionTab, render }: {
  frame: 'drawer' | 'sheet';
  onClose: () => void;
  subscriptionTab?: ReactNode;
  render?: (body: ReactNode, footer: ReactNode, close: () => void) => ReactNode;
}) {
  const locale = useLocale();
  const m = modelMessages(locale);
  const leadName = useLeadName();
  const { modelSettings } = useModelSettings();
  const { busy, run } = useModelAction();
  const [tab, setTab] = useState<Tab>('key');
  const [form, setForm] = useState<AddModelForm>(EMPTY_FORM);
  const [message, setMessage] = useState<Message | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const subscriptions = modelSettings ? hasSubscriptionField(modelSettings) : false;
  const subscriptionFlow = useSubscriptionAddTab({ dto: modelSettings, onDone: () => close() });
  const close = () => {
    subscriptionFlow.reset();
    setForm(EMPTY_FORM);
    setMessage(null);
    setAdded(null);
    setTab('key');
    onClose();
  };
  const setKind = (kind: ProviderKind) => setForm((current) => ({
    ...current,
    kind,
    // vibeproxy 的地址缺省填好；换走时清掉没改过的缺省地址。
    baseUrl: current.baseUrl.trim() === '' || current.baseUrl.trim() === VIBEPROXY_BASE_URL ? (kind === 'vibeproxy' ? VIBEPROXY_BASE_URL : '') : current.baseUrl,
  }));
  const field = (name: 'name' | 'baseUrl' | 'apiKey') => (value: string) => setForm((current) => ({ ...current, [name]: value }));
  const save = async () => {
    if (!modelSettings) return;
    const request = addModelRequest(form, modelSettings, locale);
    if (!request.ok) {
      setMessage({ text: request.problem, error: true });
      return;
    }
    setMessage(null);
    const outcome = await run('save_provider', request.input);
    if (!outcome.ok) {
      setMessage({ text: outcome.error, error: true });
      return;
    }
    setForm((current) => ({ ...current, apiKey: '' }));
    setAdded(request.input.name);
  };

  const header = frame === 'drawer' ? (
    <Row items="center" gap="side-item">
      <Text flex={1} minW={0} size="sheet-title" weight="bold" numberOfLines={1}>{m.addModel}</Text>
      <IconButton testID="model-add-close" icon="close" label={m.closePanel} variant="ghost" tone="neutral" size="sm" onPress={close} />
    </Row>
  ) : (
    <Text size="sheet-title" weight="bold" numberOfLines={1}>{m.addModel}</Text>
  );

  let body: ReactNode;
  let footer: ReactNode;
  if (!modelSettings) {
    body = <Text size="body" tone="muted">{m.loading}</Text>;
    footer = null;
  } else if (added !== null) {
    body = <AddedResult dto={modelSettings} name={added} locale={locale} />;
    footer = <FooterBar bare={frame === 'sheet'} status={null} action={<Button testID="model-add-done" label={m.done} size={frame === 'sheet' ? 'md' : 'sm'} onPress={close} />} />;
  } else if (tab === 'subscription') {
    body = subscriptionTab ?? subscriptionFlow.body;
    const flowFooter = subscriptionTab ? null : subscriptionFlow.footer;
    footer = flowFooter ? <FooterBar bare={frame === 'sheet'} status={flowFooter.status} action={flowFooter.action} /> : null;
  } else {
    body = <KeyForm dto={modelSettings} form={form} setKind={setKind} field={field} setApi={(api) => setForm((current) => ({ ...current, api }))}
      leadName={leadName} locale={locale} />;
    const status = message ?? { text: keyFormStatus(form, modelSettings, locale), error: false };
    footer = (
      <FooterBar
        bare={frame === 'sheet'}
        status={<Text testID="model-add-status" flex={1} minW={0} size="note" tone={status.error ? 'danger-dark' : 'muted'}>{status.text}</Text>}
        action={(
          <Button testID="model-add-save" label={busy ? m.adding : m.addKind(m.kindLabels[form.kind])} size={frame === 'sheet' ? 'md' : 'sm'}
            disabled={busy} onPress={() => void save()} />
        )}
      />
    );
  }

  const content = (
    <Column testID="model-add-panel" gap="card-section">
      {header}
      {subscriptions && added === null ? (
        <SegmentedControl
          testID="model-add-tabs"
          options={[{ value: 'key' as const, label: m.tabApiKey }, { value: 'subscription' as const, label: m.tabSubscription }]}
          value={tab}
          onChange={setTab}
          size="sm"
          optionTestID={(value) => `model-add-tab-${value}`}
        />
      ) : null}
      {body}
    </Column>
  );
  if (render) return <>{render(content, footer, close)}</>;
  return (
    <Column gap="card-section">
      {content}
      {footer}
    </Column>
  );
}

// 底部一行：左边状态文字，右边这一块唯一的主按钮（P5.1，主题 11.19 的操作组）。
// 手机的悬浮面板自己有操作条（一行，上边一条细线，P13.2b），这里只给里面的两样（bare）。
function FooterBar({ status, action, bare }: { status: ReactNode; action: ReactNode; bare: boolean }) {
  if (bare) return <>{status ?? <Row flex={1} />}{action}</>;
  return (
    <Row items="center" gap="side-item" pt="card-row" borderTopWidth={1} borderTopColor="border-soft">
      {status ?? <Row flex={1} />}
      {action}
    </Row>
  );
}

// 状态文字：vibeproxy、magpie 写会用的名字；自定义写名字之后模型怎么写。
function keyFormStatus(form: AddModelForm, dto: ModelSettingsDto, locale: Locale): string {
  const m = modelMessages(locale);
  const taken = dto.brain.providers.map((provider) => provider.name);
  const name = form.kind === 'custom' ? form.name.trim() || suggestedProviderName(form, taken) : suggestedProviderName(form, taken);
  return form.kind === 'custom' ? m.nameHint(name) : m.nameStatus(name);
}

function KeyForm({ dto, form, setKind, field, setApi, leadName, locale }: {
  dto: ModelSettingsDto;
  form: AddModelForm;
  setKind: (kind: ProviderKind) => void;
  field: (name: 'name' | 'baseUrl' | 'apiKey') => (value: string) => void;
  setApi: (api: ModelProviderApi) => void;
  leadName: string;
  locale: Locale;
}) {
  const m = modelMessages(locale);
  const taken = dto.brain.providers.map((provider) => provider.name);
  const plaintext = plaintextNote(form.baseUrl, locale);
  return (
    <Column gap="form-field">
      <Column gap="field">
        <OptionPills
          testID="model-add-kind"
          label={m.kindChoice}
          options={PROVIDER_KINDS.map((kind) => ({ value: kind, label: m.kindLabels[kind] }))}
          selected={form.kind}
          onSelect={(value) => setKind(value as ProviderKind)}
        />
        <Text size="note" tone="secondary">{m.kindHints[form.kind]}</Text>
      </Column>
      {form.kind === 'custom' ? (
        <Field label={m.name}>
          <TextField testID="model-add-name" value={form.name} onChangeText={field('name')} placeholder={suggestedProviderName(form, taken)}
            variant="filled" size="sm" mono autoCapitalize="none" autoCorrect={false} />
        </Field>
      ) : null}
      <Field label={m.address} hint={form.kind === 'vibeproxy' ? m.vibeproxyAddressHint : form.kind === 'magpie' ? m.magpieAddressHint : null}>
        <TextField testID="model-add-url" value={form.baseUrl} onChangeText={field('baseUrl')}
          placeholder={form.kind === 'vibeproxy' ? VIBEPROXY_BASE_URL : 'https://api.example.com/v1'} variant="filled" size="sm" mono
          keyboardType="url" autoComplete="off" autoCapitalize="none" autoCorrect={false} />
      </Field>
      {plaintext ? <Text testID="model-add-plaintext" size="note" tone="warning-dark">{plaintext}</Text> : null}
      <Field label="API key" hint={m.keyNote(leadName)}>
        <TextField testID="model-add-key" value={form.apiKey} onChangeText={field('apiKey')}
          placeholder={form.kind === 'magpie' ? m.pasteKey : m.keyOptionalShort} variant="filled" size="sm" secure autoComplete="new-password"
          autoCapitalize="none" autoCorrect={false} />
      </Field>
      {form.kind === 'custom' ? <ApiFormat value={form.api} onChange={setApi} locale={locale} /> : null}
    </Column>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string | null; children: ReactNode }) {
  return (
    <Column gap="field">
      <Text size="label" weight="bold" tone="secondary">{label}</Text>
      {children}
      {hint ? <Text size="note" tone="muted">{hint}</Text> : null}
    </Column>
  );
}

// 自定义的「高级」：接口格式。缺省收起，收起时一行写着现在的值。
function ApiFormat({ value, onChange, locale }: { value: ModelProviderApi; onChange: (api: ModelProviderApi) => void; locale: Locale }) {
  const m = modelMessages(locale);
  const [open, setOpen] = useState(false);
  const labels = apiLabels(locale);
  return (
    <Column testID="model-add-advanced" gap="field">
      <Pressable
        testID="model-add-advanced-toggle"
        aria-expanded={open}
        onPress={() => setOpen((previous) => !previous)}
        flexDirection="row"
        items="center"
        gap="icon-label"
        feedback="none"
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} color="text-muted" />
        <Text size="label" weight="semibold" tone="secondary" numberOfLines={1}>{m.advanced}</Text>
        {open ? null : <Text flex={1} minW={0} size="meta" tone="muted" numberOfLines={1}>{`${m.apiFormat}: ${labels[value]}`}</Text>}
      </Pressable>
      {open ? (
        <Field label={m.apiFormat}>
          <SegmentedControl
            testID="model-add-api"
            options={(Object.keys(labels) as ModelProviderApi[]).map((api) => ({ value: api, label: api === 'openai-completions' ? labels[api] : labels[api].replace(/^OpenAI /, '') }))}
            value={value}
            onChange={onChange}
            size="sm"
          />
        </Field>
      ) : null}
    </Column>
  );
}

// 添加以后：从新的模型设置里读这个服务商，写出读到了什么。
function AddedResult({ dto, name, locale }: { dto: ModelSettingsDto; name: string; locale: Locale }) {
  const m = modelMessages(locale);
  const provider = dto.brain.providers.find((entry) => entry.name === name) ?? null;
  return (
    <Column testID="model-add-result" gap="card-row">
      <Row items="center" gap="icon-label">
        <Icon name="check" size={16} color="success-dark" />
        <Text size="card-title" weight="semibold" numberOfLines={1}>{m.added(name)}</Text>
      </Row>
      {provider ? <FoundModels provider={provider} locale={locale} /> : <Text size="note" tone="muted">{m.readingModels}</Text>}
    </Column>
  );
}

function FoundModels({ provider, locale }: { provider: ModelProvider; locale: Locale }) {
  const m = modelMessages(locale);
  const now = new Date();
  if (provider.problem) {
    return (
      <Column gap="field">
        <Text testID="model-add-result-problem" size="note" tone="danger-dark">{m.catalogFailed(provider.problem)}</Text>
        <Text size="note" tone="secondary">{m.problemHint}</Text>
      </Column>
    );
  }
  if (provider.models.length === 0) return <Text testID="model-add-result-empty" size="note" tone="secondary">{m.noModels}</Text>;
  const kind = providerKind(provider);
  const accounts = kind === 'vibeproxy' ? providerAccounts(provider) : [];
  if (accounts.length) {
    return (
      <Column gap="field">
        <Text testID="model-add-result-summary" size="label" weight="bold" tone="secondary">{m.foundAccounts(accounts.length, provider.models.length)}</Text>
        <FoundBox>
          {accounts.map((account) => (
            <FoundRow key={account.group} testID={`model-add-result-account-${account.group}`} title={account.group}
              detail={account.blockedUntil ? m.quotaBlocked(untilLabel(account.blockedUntil, now, locale)) : null} count={account.models} muted={account.blockedUntil !== null} />
          ))}
        </FoundBox>
      </Column>
    );
  }
  const { aliases, sources } = providerRoutes(provider);
  return (
    <Column gap="field">
      <Text testID="model-add-result-summary" size="label" weight="bold" tone="secondary">{m.foundModels(provider.models.length)}</Text>
      <FoundBox>
        {aliases.length ? (
          <FoundRow testID="model-add-result-aliases" title={m.routeAliasTitle} detail={aliases.map((model) => model.id).join(', ')} count={aliases.length} />
        ) : null}
        {sources.map((source) => (
          <FoundRow key={source.source ?? ''} testID={`model-add-result-source-${source.source ?? 'other'}`} title={source.source ?? m.otherSource}
            detail={source.names.join(', ')} count={source.models} />
        ))}
      </FoundBox>
      {aliases.length ? <Text size="note" tone="muted">{m.routeAliasHint}</Text> : null}
    </Column>
  );
}

function FoundBox({ children }: { children: ReactNode }) {
  return <Column borderWidth={1} borderColor="border" rounded="md" px="inset-x" py="inset-y" gap="card-row">{children}</Column>;
}

// 一行：名字（不换行）、说明（一行，截断）、模型数。
function FoundRow({ title, detail, count, muted = false, testID }: { title: string; detail: string | null; count: number; muted?: boolean; testID?: string }) {
  return (
    <Row testID={testID} items="center" gap="inline-item">
      <Text size="body" weight="semibold" tone={muted ? 'muted' : 'default'} numberOfLines={1} shrink={0}>{title}</Text>
      <Text flex={1} minW={0} size="secondary" tone="secondary" numberOfLines={1}>{detail ?? ''}</Text>
      <Text size="meta" tone="muted" mono shrink={0}>{count}</Text>
    </Row>
  );
}
