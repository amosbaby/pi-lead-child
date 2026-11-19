import { Card, ChoiceGroup, Column, Icon, Popover, RecordRow, Row, SegmentedControl, Text } from '@pi-lead-child/components';
import {
  LEAD_SHADOW_MODES, LEAD_SHADOW_SETTINGS_CAPABILITY, LEAD_SHADOW_SOURCES,
  type LeadShadowDto, type SetLeadShadowRequest,
} from '@pi-lead-child/protocol';
import { useEffect, useState, type ReactNode } from 'react';

import { useLocale } from '@/i18n';
import { useCompanionRuntime, useControlPlaneStore } from '@/state/CompanionStateProvider';
import { useLeadName, useLeadShadow } from '@/state/hooks';

import { memoryErrorText } from './memoryModel';
import { shadowMessages } from './shadow.messages';

// 设置 → Shadow（2026-11-19，用户：「在 UI 上开设置功能」）。Lead 的分身 shadow 的设置，和 Lead 的 lead_shadow.set 是同一个操作。
// 两张卡（主题 11.24）：
// - 模式：和「Lead 忙时你发的消息」（11.19）同一种写法，一组单选卡（关、试运行、开），每个选项一句说明。
// - 交给 shadow 的事：表单字段的写法（11.19 表单）。每类来源一行分段选择（0、25、50、100%），模型一个下拉，合批等待一行分段选择。
// 每个控件改了马上保存，只写改的那个字段。保存期间写「正在保存…」，控件不接受点击；没保存成功时写原因，控件退回保存着的值。
// 旧 daemon 没有宣布 lead.shadow-settings.v1 时不给改。
const SHARE_STEPS = [0, 25, 50, 100] as const;
const GATHER_STEPS = [0, 10, 20, 60] as const;
const SAME_MODEL = '__same__';

export function ShadowSection() {
  const supported = useControlPlaneStore((state) => state.capabilities.includes(LEAD_SHADOW_SETTINGS_CAPABILITY));
  const locale = useLocale();
  if (!supported) {
    return <Text testID="shadow-unsupported" size="note" tone="muted">{shadowMessages(locale).unsupported}</Text>;
  }
  return <ShadowCards />;
}

function ShadowCards() {
  const { leadShadow, resource } = useLeadShadow();
  const locale = useLocale();
  const m = shadowMessages(locale);
  if (!leadShadow) {
    return (
      <Text testID="shadow-loading" size="note" tone={resource?.state === 'error' ? 'danger-dark' : 'muted'}>
        {resource?.state === 'error' ? m.loadFailed(memoryErrorText(resource.error, locale)) : m.loading}
      </Text>
    );
  }
  return <ShadowForm saved={leadShadow} />;
}

function ShadowForm({ saved }: { saved: LeadShadowDto }) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const locale = useLocale();
  const m = shadowMessages(locale);
  // 正在保存的改动：保存完以后读 daemon 的值，没保存成功时退回。
  const [pending, setPending] = useState<SetLeadShadowRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown: LeadShadowDto = {
    ...saved,
    ...pending,
    shares: { ...saved.shares, ...pending?.shares },
  };

  const save = (change: SetLeadShadowRequest) => {
    if (pending !== null) return;
    setPending(change);
    setError(null);
    runtime.setLeadShadow(change)
      .catch((reason: unknown) => setError(m.failed(memoryErrorText(reason, locale))))
      .finally(() => setPending(null));
  };

  const footnote = pending !== null ? m.saving : m.footnote(leadName);
  return (
    <Column gap="page-section">
      <Card testID="shadow-mode-section" rounded="xl" p="page-card" gap="form-field">
        <Text size="card-title" weight="extrabold">{m.title(leadName)}</Text>
        <Text size="note" tone="muted">{m.intro(leadName)}</Text>
        <ChoiceGroup
          variant="radio"
          testID="shadow-mode"
          optionTestID={(option) => `shadow-mode-${option}`}
          accessibilityLabel={m.title(leadName)}
          value={shown.mode}
          disabled={pending !== null}
          onSelect={(next) => {
            const mode = LEAD_SHADOW_MODES.find((option) => option === next);
            if (mode && mode !== saved.mode) save({ mode });
          }}
          options={LEAD_SHADOW_MODES.map((option) => ({ id: option, label: m.options[option], description: m.notes[option](leadName) }))}
        />
        <Text size="note" tone="muted">{m.alwaysMain(leadName)}</Text>
      </Card>
      <Card testID="shadow-routing-section" rounded="xl" p="page-card" gap="form-field">
        <Text size="card-title" weight="extrabold">{m.routingTitle}</Text>
        {LEAD_SHADOW_SOURCES.map((source) => (
          <Field key={source} testID={`shadow-share-${source}`} label={m.shareLabels[source]}
            note={SHARE_STEPS.some((step) => step === shown.shares[source]) ? m.shareNotes[source] : `${m.shareNotes[source]} ${m.otherValue(shown.shares[source])}`}>
            <SegmentedControl
              testID={`shadow-share-${source}-input`}
              size="sm"
              options={SHARE_STEPS.map((step) => ({ value: String(step), label: m.percent(step) }))}
              value={String(shown.shares[source])}
              optionTestID={(value) => `shadow-share-${source}-${value}`}
              onChange={(value) => {
                const share = Number(value);
                if (share !== saved.shares[source]) save({ shares: { [source]: share } });
              }}
            />
          </Field>
        ))}
        <Field testID="shadow-model" label={m.modelLabel} note={m.modelNote(leadName)}>
          <ModelSelect value={shown.model} disabled={pending !== null} onPick={(model) => { if (model !== saved.model) save({ model }); }} />
        </Field>
        <Field testID="shadow-gather" label={m.gatherLabel} note={m.gatherNote}>
          <SegmentedControl
            testID="shadow-gather-input"
            size="sm"
            options={GATHER_STEPS.map((step) => ({ value: String(step), label: m.gatherValue(step) }))}
            value={String(shown.gatherSeconds)}
            optionTestID={(value) => `shadow-gather-${value}`}
            onChange={(value) => {
              const gatherSeconds = Number(value);
              if (gatherSeconds !== saved.gatherSeconds) save({ gatherSeconds });
            }}
          />
        </Field>
        {error ? <Text testID="shadow-error" size="note" tone="danger-dark">{error}</Text> : null}
        <Text testID="shadow-footnote" size="meta" tone="muted">{footnote}</Text>
      </Card>
    </Column>
  );
}

// 表单字段的写法（主题 11.19 表单）：标签、控件、说明。
function Field({ testID, label, note, children }: { testID: string; label: string; note: string; children: ReactNode }) {
  return (
    <Column testID={testID} gap="field">
      <Text size="label" weight="bold" tone="secondary">{label}</Text>
      {children}
      <Text size="note" tone="muted">{note}</Text>
    </Column>
  );
}

// 模型的下拉（主题 11.19 表单的单选下拉）：第一项「和会话相同」，下面是 Lead 的模型目录。目录取不到时只有第一项和现在设的模型。
function ModelSelect({ value, disabled, onPick }: { value: string | null; disabled: boolean; onPick: (model: string | null) => void }) {
  const runtime = useCompanionRuntime();
  const locale = useLocale();
  const m = shadowMessages(locale);
  const [models, setModels] = useState<string[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    runtime.loadLeadModels()
      .then((catalog) => { if (live) setModels(catalog.models.map((option) => option.model)); })
      .catch((reason: unknown) => { if (live) setFailed(memoryErrorText(reason, locale)); });
    return () => { live = false; };
  }, [runtime, locale]);
  const options = [
    { value: SAME_MODEL, label: m.modelSame },
    ...[...new Set([...(value ? [value] : []), ...models])].map((model) => ({ value: model, label: model })),
  ];
  const current = value ?? SAME_MODEL;
  const selected = options.find((option) => option.value === current);
  const trigger = (
    // 和 sm 的输入框同高（TextField.shared 的 sm 是 32），和表单的下拉一样。
    <Row items="center" gap="inline-item" px="inset-x" h={32} rounded="md" bg="surface-subtle" borderWidth={1} borderColor="border">
      <Text flex={1} minW={0} size="body" tone={disabled ? 'muted' : 'default'} numberOfLines={1}>{selected?.label ?? current}</Text>
      <Icon name="chevron-down" size={14} color="text-secondary" />
    </Row>
  );
  return (
    <Column gap="field">
      {disabled ? trigger : (
        <Popover testID="shadow-model-input" label={m.modelLabel} title={m.modelLabel} width={320} trigger={trigger}>
          {(close) => (
            <Column>
              {options.map((option, index) => (
                <RecordRow
                  key={option.value}
                  testID={`shadow-model-${option.value === SAME_MODEL ? 'same' : option.value}`}
                  divider={index > 0}
                  title={option.label}
                  trailing={option.value === current ? <Icon name="check" size={16} color="accent" /> : undefined}
                  onPress={() => { close(); onPick(option.value === SAME_MODEL ? null : option.value); }}
                />
              ))}
            </Column>
          )}
        </Popover>
      )}
      {failed ? <Text size="note" tone="danger-dark">{m.modelsFailed(failed)}</Text> : null}
    </Column>
  );
}
