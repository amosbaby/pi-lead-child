import { Badge, Box, Button, Chip, Column, Icon, Popover, Pressable, Row, Text, TextField } from '@pi-lead-child/components';
import { parseLeadModelSpec, type LeadModelCatalog, type LeadModelChoice, type LeadModelOption } from '@pi-lead-child/protocol';
import { useEffect, useState } from 'react';

import { useLocale, useMessages } from '@/i18n';

import { useCompanionRuntime } from '@/state/CompanionStateProvider';

import { leadModelMessages } from './leadModel.messages';
import { effortForModel, groupLeadModels, leadModelLabel, leadModelProviders } from './leadModelGroups';

// 会话输入框右下角的模型名（2026-10-26，参考 Kimi）：写着 Lead 正在用的模型 id 和推理强度，点开换模型。
// 浮层里先是推理强度，再是搜索框，下面左栏是 provider、右边是这个 provider 按「账号 · 通道」分的段（见 ./leadModelGroups）。换模型和 Lead 的
// switch_lead_model 是同一个操作：Lead 空闲时马上换，正在回答时这一轮结束后换，不用重启。
// 浮层宽 560：左栏 provider（144）加右边的模型列表。
const POPOVER_WIDTH = 560;

export function LeadModelPicker({ current }: { current: string | null | undefined }) {
  const m = useMessages(leadModelMessages);
  const accounts = useModelAccounts();
  // daemon 还不知道用哪个模型时（hello 里是 unknown）不写。
  if (!current?.trim() || current === 'unknown') return null;
  // 知道账号时去掉它（as4/claude-sonnet-5 写成 claude-sonnet-5）；目录还没读到时写完整的 id。
  const label = leadModelLabel(current, accounts.get(parseLeadModelSpec(current).model) ?? null);
  // 外面包一层：Popover 的锚点自己是 alignSelf: flex-start，直接放进工具栏会贴着这一行的上边，
  // 和左边的「+」、右边的发送按钮对不齐（2026-10-26 用户截图）。这一层由工具栏垂直居中。
  return (
    <Box testID="lead-model-anchor">
    <Popover
      testID="lead-model"
      label={m.pickerLabel(`${label.id}${label.effort ? ` ${label.effort}` : ''}`)}
      title={m.pickerTitle}
      width={POPOVER_WIDTH}
      trigger={(
        // 参考 Claude Code 的模型名：平时只是文字，鼠标放上去出现圆角的浅灰底，看起来像一个按钮，知道这里能点。
        // spacing-exempt: 按钮的规格，左右 8、上下 6，高 28（文字行高 16）
        <Row testID="lead-model-button" items="center" gap="icon-label" px={8} py={6} rounded="sm" bg={{ default: 'transparent', hover: 'surface-muted' }}>
          <Text testID="composer-model" size="label" tone="secondary" numberOfLines={1}>{label.id}</Text>
          {label.effort ? <Text testID="composer-model-effort" size="label" tone="muted">{label.effort}</Text> : null}
        </Row>
      )}
    >
      {(close) => <LeadModelPanel close={close} />}
    </Popover>
    </Box>
  );
}

// 目录里每个模型的账号（Lead 模型分组，2026-11-05）：前缀是不是账号由 daemon 按服务商的 accountPrefix 定，
// 输入框右下角的模型名要靠它决定去不去掉前缀。挂上时读一次目录（daemon 缓存 30 秒），读不到时当作没有账号。
export function useModelAccounts(): Map<string, string | null> {
  const runtime = useCompanionRuntime();
  const [accounts, setAccounts] = useState<Map<string, string | null>>(() => new Map());
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => runtime.loadLeadModels()).then(
      (catalog) => {
        if (live && catalog?.models) setAccounts(new Map(catalog.models.map((model) => [model.model, model.prefix])));
      },
      () => {},
    );
    return () => { live = false; };
  }, [runtime]);
  return accounts;
}

type PanelState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; catalog: LeadModelCatalog };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 没有回答的那一轮里的「换个模型重发」（画布「没有回答」状态 2）：点开同一个模型浮层，换好以后再发一次你那句话。
// 换模型和输入框右下角是同一个操作；Lead 正在回答时，新模型在这一轮结束后换上，重发的那句排在后面，用的是新模型。
export function LeadModelResendLink({ onSwitched }: { onSwitched: () => void }) {
  const m = useMessages(leadModelMessages);
  return (
    <Popover
      testID="lead-model-resend"
      label={m.resend}
      title={m.resend}
      width={POPOVER_WIDTH}
      trigger={<Text testID="lead-model-resend-button" size="secondary" weight="semibold" tone="accent">{m.resend}</Text>}
    >
      {(close) => <LeadModelPanel close={close} onSwitched={onSwitched} />}
    </Popover>
  );
}

export function LeadModelPanel({ close, onSwitched }: { close: () => void; onSwitched?: () => void }) {
  const locale = useLocale();
  const m = leadModelMessages(locale);
  const runtime = useCompanionRuntime();
  const [state, setState] = useState<PanelState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // 正在换的那一个（换好之前按钮都不能点），和换完以后的一句话。
  const [switching, setSwitching] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'secondary' | 'danger'; text: string } | null>(null);
  const [search, setSearch] = useState('');
  // 左栏选中的 provider；null 是全部模型。
  const [provider, setProvider] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    runtime.loadLeadModels().then(
      (catalog) => { if (live) setState({ status: 'ready', catalog }); },
      (error: unknown) => { if (live) setState({ status: 'error', message: errorText(error) }); },
    );
    return () => { live = false; };
  }, [runtime, attempt]);

  if (state.status === 'loading') return <Text testID="lead-model-loading" size="note" tone="muted">{m.loading}</Text>;
  if (state.status === 'error') {
    return (
      <Column gap="card-row">
        <Text testID="lead-model-error" size="note" tone="danger">{m.loadFailed(state.message)}</Text>
        <Row><Button label={m.retry} size="sm" variant="outline" onPress={() => { setState({ status: 'loading' }); setAttempt((count) => count + 1); }} /></Row>
      </Column>
    );
  }

  const { catalog } = state;
  const selected = catalog.selected;
  const selectedOption = catalog.models.find((model) => model.model === selected.model) ?? null;
  const choose = (choice: LeadModelChoice) => {
    if (switching) return;
    const spec = choice.effort ? `${choice.model}(${choice.effort})` : choice.model;
    setSwitching(spec);
    setNotice(null);
    runtime.switchLeadModel(choice).then(
      (result) => {
        setSwitching(null);
        setState({ status: 'ready', catalog: { ...catalog, selected: result.selected, ...(result.applied === 'after_turn' ? {} : { current: result.selected }) } });
        if (onSwitched) {
          // 换好了（或者排在这一轮之后）：重发你那句话，关掉浮层。
          close();
          onSwitched();
        } else if (result.applied === 'after_turn') {
          setNotice({ tone: 'secondary', text: m.afterTurn(leadModelLabel(spec, catalog.models.find((model) => model.model === choice.model)?.prefix ?? null).id) });
        } else {
          close();
        }
      },
      (error: unknown) => {
        setSwitching(null);
        setNotice({ tone: 'danger', text: errorText(error) });
      },
    );
  };

  const pending = selected.model !== catalog.current.model || selected.effort !== catalog.current.effort;
  // 「正在用」那一行按全部分组算：搜索、左栏都不影响它。
  const groups = groupLeadModels(catalog.models);
  const providers = leadModelProviders(catalog.models);
  const shown = groupLeadModels(catalog.models, { query: search, provider });
  // 选着的模型可能在列表很下面：最上面写一行它是哪个来源的哪个模型，不用翻下去找。
  const selectedGroup = groups.find((group) => group.models.some((model) => model.model === selected.model));
  const selectedId = selectedOption?.prefix ? selectedOption.id.slice(selectedOption.prefix.length + 1) : parseLeadModelSpec(selected.model).id;
  return (
    <Column gap="card-section" testID="lead-model-catalog">
      <Text testID="lead-model-selected" size="body" weight="semibold">
        {m.inUse(`${selectedGroup?.title ? `${selectedGroup.title} · ` : ''}${selectedId}${selected.effort ? ` ${selected.effort}` : ''}`)}
      </Text>
      {pending ? (
        <Text testID="lead-model-pending" size="note" tone="secondary">
          {m.pending(describe(catalog.current), describe(selected))}
        </Text>
      ) : null}
      {notice ? <Text testID="lead-model-notice" size="note" tone={notice.tone}>{notice.text}</Text> : null}
      {selectedOption && selectedOption.efforts.length ? (
        <Column gap="field">
          <Text size="label" tone="secondary">{m.effort}</Text>
          <Row gap="chips" flexWrap="wrap">
            {[null, ...selectedOption.efforts].map((effort) => (
              <Chip
                key={effort ?? 'default'}
                testID={`lead-model-effort-${effort ?? 'default'}`}
                label={effort ?? m.defaultEffort}
                selected={selected.effort === effort}
                onPress={() => { if (selected.effort !== effort) choose({ model: selected.model, effort }); }}
              />
            ))}
          </Row>
        </Column>
      ) : null}
      <TextField
        testID="lead-model-search"
        accessibilityLabel={m.searchLabel}
        value={search}
        onChangeText={setSearch}
        placeholder={m.searchPlaceholder}
        variant="filled"
        size="sm"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Row gap="inline-item" items="flex-start">
        {/* spacing-exempt: 左栏宽 144，放得下 vibeproxy 这类服务商名 */}
        <Column testID="lead-model-providers" aria-label={m.providers} w={144} gap="nav-item">
          <ProviderButton testID="lead-model-provider-all" label={m.allModels} selected={provider === null} onPress={() => setProvider(null)} />
          {providers.map((entry) => (
            <ProviderButton
              key={entry.provider}
              testID={`lead-model-provider-${entry.provider}`}
              label={entry.provider}
              count={entry.count}
              accessibilityLabel={m.providerLabel(entry.provider, entry.count)}
              selected={provider === entry.provider}
              onPress={() => setProvider(entry.provider)}
            />
          ))}
        </Column>
        <Column flex={1} minW={0} gap="card-section">
          {shown.length === 0 ? <Text testID="lead-model-no-match" size="note" tone="muted">{m.noMatch}</Text> : null}
          {shown.map((group) => (
            <Column key={group.key} gap="group-label" testID={`lead-model-group-${group.title}`}>
              {group.title ? (
                <Row items="center" gap="icon-label">
                  <Text size="eyebrow" tone="muted">{group.title}</Text>
                  <Text size="meta" tone="faint">{group.count}</Text>
                </Row>
              ) : null}
              <Column>
                {group.models.map((model) => (
                  <ModelRow
                    key={model.model}
                    model={model}
                    selected={model.model === selected.model}
                    busy={switching !== null}
                    onPress={() => choose({ model: model.model, effort: effortForModel(model, selected.effort) })}
                  />
                ))}
              </Column>
            </Column>
          ))}
        </Column>
      </Row>
    </Column>
  );
}

function describe(choice: LeadModelChoice): string {
  const id = parseLeadModelSpec(choice.model).id;
  return choice.effort ? `${id} ${choice.effort}` : id;
}

// 左栏的一格：服务商名，右边写它一共几个模型。选中的一格浅灰底、文字用强调色（不只靠颜色：aria-pressed）。
function ProviderButton({ label, count, accessibilityLabel, selected, onPress, testID }: {
  label: string; count?: number; accessibilityLabel?: string; selected: boolean; onPress: () => void; testID: string;
}) {
  return (
    <Pressable
      testID={testID}
      aria-label={accessibilityLabel ?? label}
      aria-pressed={selected}
      feedback="highlight"
      onPress={onPress}
      rounded="md"
      px="row-x"
      py="row-y"
      bg={selected ? 'surface-muted' : 'transparent'}
    >
      <Row items="center" gap="inline-item">
        <Text flex={1} minW={0} size="label" weight={selected ? 'semibold' : 'regular'} tone={selected ? 'accent' : 'secondary'} numberOfLines={1}>{label}</Text>
        {count === undefined ? null : <Text size="meta" tone="muted">{count}</Text>}
      </Row>
    </Pressable>
  );
}

function ModelRow({ model, selected, busy, onPress }: {
  model: LeadModelOption; selected: boolean; busy: boolean; onPress: () => void;
}) {
  const m = useMessages(leadModelMessages);
  // 组名已经写了账号前缀：行里只写模型 id。
  const id = model.prefix ? model.id.slice(model.prefix.length + 1) : model.id;
  const blockedAt = model.blockedUntil ? new Date(model.blockedUntil) : null;
  return (
    <Pressable
      testID={`lead-model-option-${model.model}`}
      aria-label={selected ? m.selectedLabel(model.model) : model.model}
      aria-pressed={selected}
      feedback="highlight"
      disabled={busy}
      onPress={selected ? undefined : onPress}
      rounded="md"
      px="row-x"
      py="row-y"
    >
      <Row items="center" gap="inline-item">
        <Text flex={1} minW={0} size="body" weight={selected ? 'bold' : 'regular'} numberOfLines={1}>{id}</Text>
        {blockedAt ? (
          <Badge
            label={m.quotaUsed(`${String(blockedAt.getHours()).padStart(2, '0')}:${String(blockedAt.getMinutes()).padStart(2, '0')}`)}
            tone="warning"
            size="sm"
          />
        ) : null}
        {/* 几乎每个模型都能看图：只标出不能看的。 */}
        {model.image ? null : <Text size="meta" tone="muted">{m.noImages}</Text>}
        {selected ? <Icon name="check" size={14} color="accent" accessibilityLabel={m.selected} /> : null}
      </Row>
    </Pressable>
  );
}
