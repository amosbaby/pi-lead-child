import {
  Badge, Box, Button, Card, Column, Divider, Dot, Pressable, ProgressBar, Row, SegmentedControl, Text, TextField,
} from '@pi-lead-child/components';
import {
  parseLeadModelSpec, SUMMARY_MODEL_SLOTS,
  type MemoryDownload, type MemoryHindsightDto, type MemorySettingsDto, type MemorySettingsRequest, type MemoryTestResponse, type SummaryModelSlot,
  type SummaryModelSlotDto,
} from '@pi-lead-child/protocol';
import { useRouter, type Href } from 'expo-router';
import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';

import { useLocale, useMessages } from '@/i18n';
import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useDecisionModel, useMemoryHindsight, useMemorySettings, useModelSettings } from '@/state/hooks';

import {
  bankStatsLabel, decisionRerankDescription, downloadLabel, downloadPercent, embeddingInUse, embeddingWaits, hostOf, keyDroppedNote, keyHostChange,
  keyHostChangeNote, keyHostMismatchNote, localEmbeddingHint, memoryErrorText, memoryNeedsUser, memoryStatus,
  rerankerFallbackNote, plaintextNote, remoteFormProblem, remotePrivacyNote, remoteRequest, summarySlotLabel, summarySlotNote,
  summarySourceLabel, testResultLabel, writesFailedNote, writesLabel, type RemoteForm,
} from './memoryModel';
import { memoryMessages } from './memory.messages';
import { InvalidatedFacts, MemoryGroup as Section, MemoryPreferences } from './MemoryPreferences';
import { brainPickerGroups, Slot, SlotFace, SlotGrid, type PickerGroup } from './ModelPicker';
import { brainIndex, brainModelName } from './modelSettingsModel';
import { useServerForm } from './useServerForm';

type EmbeddingTab = 'local' | 'remote';

const DOT_COLOR = { success: 'success', warning: 'warning', danger: 'danger', muted: 'text-faint' } as const;

// 设置 → Lead → 记忆。最上面是要你确认的切换，然后是现状、常驻偏好、Hindsight（摘要模型、写入、最近失效的事实）、embedding、重排。
// 契约：packages/protocol/src/memory.ts。改动都走 POST /v1/memory/settings，daemon 只重启记忆服务。
// Hindsight 那一块是另一份契约（memory-hindsight.ts），改动走操作层的 memory_settings。
export function MemorySection() {
  const { memory, resource } = useMemorySettings();
  const locale = useLocale();
  const m = memoryMessages(locale);
  if (!memory) {
    return (
      <Text testID="memory-loading" size="body" tone={resource?.state === 'error' ? 'danger-dark' : 'muted'}>
        {resource?.state === 'error' ? m.loadFailed(resource.error ? memoryErrorText(resource.error, locale) : m.controlNotStarted) : m.loading}
      </Text>
    );
  }
  return (
    <Column testID="memory-section" gap="page-section">
      <PendingSwitchBanner memory={memory} />
      <ServiceStatus memory={memory} />
      <MemoryPreferences />
      <HindsightSettings />
      <EmbeddingSettings memory={memory} />
      <RerankerSettings memory={memory} />
      <Column gap="text-stack">
        <Text size="note" tone="muted">{m.reloadNote}</Text>
        <Text testID="memory-off-note" size="note" tone="muted">{m.offNote}</Text>
      </Column>
    </Column>
  );
}

// 要你确认的切换。和会话里的 MemorySwitchConfirm 卡是同一个：在哪边点都行。
// 往外发数据（dataFlows）只能在这里或会话卡上同意：确认时 daemon 按切换的 id 重新算一遍，主机变了就作废，再出一张新卡。
// reason 是 daemon 写的，已经包括每条外发和怎样停止，这里不再重复，只在标题里列出主机。
export function PendingSwitchBanner({ memory }: { memory: MemorySettingsDto }) {
  const runtime = useCompanionRuntime();
  const locale = useLocale();
  const m = memoryMessages(locale);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<ComponentRef<typeof Card>>(null);
  const pending = memory.pendingSwitch;
  const visible = Boolean(pending && memoryNeedsUser(memory));
  const pendingId = visible ? pending!.id : null;
  const seen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    // 页面打开以后才出现的切换卡拿到焦点，用键盘和读屏的人能马上读到它。
    // 不抢焦点：打开页面时已经有的卡不拿；用户正在输入框里打字（例如粘贴 key）时也不拿。
    // 用户点了「保存」等按钮、这张卡因此出现时，焦点在按钮上：这时卡要拿到焦点。原生端没有 document，跳过。
    if (seen.current !== undefined && pendingId && pendingId !== seen.current && !typingSomewhere()) {
      (cardRef.current as { focus?: () => void } | null)?.focus?.();
    }
    seen.current = pendingId;
  }, [pendingId]);
  if (!pending || !visible) return null;
  const hosts = [...new Set(pending.dataFlows.map((flow) => flow.host))];
  const decide = (approve: boolean) => {
    setSubmitting(true);
    setError(null);
    runtime.confirmMemorySwitch(pending.id, approve)
      .catch((reason: unknown) => setError(memoryErrorText(reason, locale)))
      .finally(() => setSubmitting(false));
  };
  return (
    <Card
      ref={cardRef}
      testID="memory-pending-switch"
      role="region"
      tabIndex={-1}
      aria-label={m.confirmLabel(pending.summary)}
      tone={hosts.length ? 'danger' : 'warning'}
      rounded="xl"
      px="banner-x" py="banner-y"
      gap="card-row"
    >
      <Row items="center" gap="inline-item">
        <Text flex={1} size="card-title" weight="extrabold">{pending.summary}</Text>
        <Badge label={m.needsConfirm} tone="warning" dot size="sm" />
      </Row>
      {hosts.length ? (
        <Text testID="memory-switch-hosts" size="label" weight="bold" tone="danger-dark">{m.dataLeaves(hosts.join(m.hostsJoin))}</Text>
      ) : null}
      <Text testID="memory-switch-reason" size="body" tone="secondary">{pending.reason}</Text>
      <Row gap="actions" flexWrap="wrap">
        <Button testID="memory-switch-approve" label={hosts.length ? m.approveAndSwitch : m.switch} disabled={submitting} onPress={() => decide(true)} />
        <Button testID="memory-switch-reject" label={m.notNow} variant="outline" tone="neutral" disabled={submitting} onPress={() => decide(false)} />
      </Row>
      {error ? <Text testID="memory-switch-error" size="note" tone="danger-dark">{error}</Text> : null}
    </Card>
  );
}

function typingSomewhere(): boolean {
  if (typeof document === 'undefined') return true;
  const active = document.activeElement as HTMLElement | null;
  if (!active) return false;
  return active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable;
}

function ServiceStatus({ memory }: { memory: MemorySettingsDto }) {
  const status = memoryStatus(memory, useLocale());
  const { notes, indexed } = memory.service.index;
  return (
    <Card testID="memory-status" rounded="xl" p="page-card" gap="card-row">
      <Row items="center" gap="icon-label">
        <Dot color={DOT_COLOR[status.tone]} size={8} />
        <Text flex={1} size="card-title" weight="bold">{status.title}</Text>
      </Row>
      <Text size="secondary" tone="secondary">{status.detail}</Text>
      {memory.service.state === 'healthy' && notes > 0 && indexed < notes ? (
        <Row><ProgressBar value={(indexed / notes) * 100} color="success" height={5} /></Row>
      ) : null}
    </Card>
  );
}

// 设置 → 记忆的 Hindsight 部分（2026-10-29，.scratch/hindsight-primary-memory/spec.md D3、D13、D16）：摘要模型、写入情况。
// 契约：packages/protocol/src/memory-hindsight.ts。改动都是操作层的 memory_settings 操作（runtime.memorySettingsAction），
// 和 Lead 的 perform_action 同一个函数。daemon 比网页旧、还没有这条路由时，整块不显示。
function HindsightSettings() {
  const { memoryHindsight: hindsight, resource } = useMemoryHindsight();
  const locale = useLocale();
  const m = memoryMessages(locale);
  if (!hindsight) {
    if (resource?.state === 'error') {
      return (
        <Text testID="memory-hindsight-error" size="note" tone="danger-dark">
          {m.hindsightLoadFailed(resource.error ? memoryErrorText(resource.error, locale) : m.controlNotStarted)}
        </Text>
      );
    }
    if (!resource || resource.state === 'unsupported') return null;
    return <Text testID="memory-hindsight-loading" size="note" tone="muted">{m.hindsightLoading}</Text>;
  }
  return (
    <Section title="Hindsight" hint={m.hindsightHint}>
      <Card testID="memory-hindsight" rounded="xl">
        <SummaryModels hindsight={hindsight} />
        {hindsight.enabled ? (
          <>
            <Divider />
            <HindsightWrites hindsight={hindsight} />
          </>
        ) : null}
        {hindsight.invalidated?.length ? (
          <>
            <Divider />
            <InvalidatedFacts facts={hindsight.invalidated} />
          </>
        ) : null}
      </Card>
    </Section>
  );
}

type SlotMessage = { slot: SummaryModelSlot; text: string; tone: 'secondary' | 'success-dark' | 'danger-dark' };

// 摘要模型的两个槽。选模型用设置 → 模型的同一个下拉和同一个目录；第一项是「自动」（缺省槽）或「跟缺省一样」（整理观察槽）。
// 选了马上保存。测试是低频操作，放在下拉的底部。
function SummaryModels({ hindsight }: { hindsight: MemoryHindsightDto }) {
  const runtime = useCompanionRuntime();
  const locale = useLocale();
  const m = memoryMessages(locale);
  const { modelSettings } = useModelSettings();
  const [open, setOpen] = useState<SummaryModelSlot | null>(null);
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<SlotMessage | null>(null);
  const index = modelSettings ? brainIndex(modelSettings) : null;
  const entries = SUMMARY_MODEL_SLOTS.flatMap((slot) => hindsight.summaryModels.filter((entry) => entry.slot === slot));
  const defaultModel = entries.find((entry) => entry.slot === 'default')?.model ?? null;
  const modelName = (spec: string | null) => spec ? brainModelName(spec, index?.get(parseLeadModelSpec(spec).model)) : m.noModel;

  const openSlot = (slot: SummaryModelSlot) => {
    setOpen(slot);
    setSearch('');
    setShowAll(new Set());
  };
  const close = () => setOpen(null);
  const run = async (slot: SummaryModelSlot, pending: string, action: string, input: Record<string, unknown>, done: (result: unknown) => Omit<SlotMessage, 'slot'>) => {
    close();
    setBusy(true);
    setMessage({ slot, text: pending, tone: 'secondary' });
    try {
      setMessage({ slot, ...done(await runtime.memorySettingsAction(action, input)) });
    } catch (reason) {
      setMessage({ slot, text: memoryErrorText(reason, locale), tone: 'danger-dark' });
    } finally {
      setBusy(false);
    }
  };
  const choose = (entry: SummaryModelSlotDto, model: string | null) => {
    if (entry.setting === model) {
      close();
      return;
    }
    void run(entry.slot, m.saving, 'set_summary_model', { slot: entry.slot, model }, (result) => {
      const note = (result as { note?: string | null } | null)?.note;
      return { text: note ? m.savedWithNote(note) : m.saved, tone: 'secondary' };
    });
  };
  const test = (entry: SummaryModelSlotDto) => void run(entry.slot, m.testing, 'test_summary_model', { slot: entry.slot }, (result) => {
    const tested = result as MemoryTestResponse;
    return { text: testResultLabel(tested, locale), tone: tested.ok ? 'success-dark' : 'danger-dark' };
  });
  const groups = (entry: SummaryModelSlotDto): PickerGroup[] => [
    {
      key: 'system', title: m.system, count: 1, hidden: 0,
      options: [{
        key: 'system',
        title: entry.slot === 'default' ? m.auto : m.sameAsDefault,
        sub: entry.slot === 'default' ? m.autoSub : m.nowIs(modelName(defaultModel)),
        date: null, selected: entry.setting === null, disabledReason: null,
        onPick: () => choose(entry, null),
      }],
    },
    ...(modelSettings ? brainPickerGroups(modelSettings, {
      search, showAll, slot: -1, selected: entry.setting, onPick: (model) => choose(entry, model),
    }) : []),
  ];

  const slots = entries.map((entry) => {
    const isOpen = open === entry.slot;
    const provider = entry.model ? parseLeadModelSpec(entry.model).provider : '';
    const note = summarySlotNote(entry, locale);
    const said = message?.slot === entry.slot ? message : null;
    return (
      <Slot
        key={entry.slot}
        testID={`memory-summary-picker-${entry.slot}`}
        label={summarySlotLabel(entry.slot, locale)}
        face={(
          <SlotFace
            testID={`memory-summary-slot-${entry.slot}`}
            title={modelName(entry.model)}
            sub={[provider, summarySourceLabel(entry, locale)].filter(Boolean).join(' · ')}
            subTone={entry.source === 'none' ? 'danger-dark' : 'secondary'}
            focused={isOpen}
          />
        )}
        open={isOpen}
        onOpen={() => openSlot(entry.slot)}
        onClose={close}
        groups={isOpen ? groups(entry) : []}
        search={search}
        onSearch={setSearch}
        onShowAll={(group) => setShowAll((previous) => new Set([...previous, group]))}
        footer={(
          <>
            <Button testID={`memory-summary-test-${entry.slot}`} label={m.testCurrentModel} variant="ghost" tone="neutral" size="xs"
              disabled={busy || !entry.model} onPress={() => test(entry)} />
            <Column flex={1} minW={0} gap="text-stack">
              <Text testID={`memory-summary-restart-${entry.slot}`} size="meta" tone="muted">{m.summaryRestartNote}</Text>
              {modelSettings ? null : <Text size="meta" tone="muted">{m.noCatalog}</Text>}
            </Column>
          </>
        )}
        below={note || said ? (
          <Column gap="text-stack">
            {note ? <Text testID={`memory-summary-note-${entry.slot}`} size="note" tone="warning-dark">{note}</Text> : null}
            {said ? <Text testID={`memory-summary-message-${entry.slot}`} size="note" tone={said.tone}>{said.text}</Text> : null}
          </Column>
        ) : null}
      />
    );
  });

  return (
    <Column testID="memory-summary-models" p="page-card" gap="card-section">
      <Row items="baseline" gap="inline-item" flexWrap="wrap">
        <Text size="card-title" weight="semibold">{m.summaryModels}</Text>
        <Text size="meta" tone="muted">{m.summaryModelsHint}</Text>
        <Text ml="auto" size="meta" tone="muted">{hindsight.enabled ? m.effectNow : m.effectAfterHindsight}</Text>
      </Row>
      {hindsight.enabled ? null : <Text testID="memory-hindsight-off" size="secondary" tone="secondary">{m.hindsightOffNote}</Text>}
      <SlotGrid>{slots}</SlotGrid>
    </Column>
  );
}

// 笔记写进 Hindsight 的情况和记忆库的统计。有失败时给出最近的原因和「重试失败的写入」。
function HindsightWrites({ hindsight }: { hindsight: MemoryHindsightDto }) {
  const runtime = useCompanionRuntime();
  const locale = useLocale();
  const m = memoryMessages(locale);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const { writes, stats } = hindsight;
  const failed = writesFailedNote(writes, locale);
  const statsLine = bankStatsLabel(stats, locale);
  const retry = () => {
    setBusy(true);
    setMessage(null);
    runtime.memorySettingsAction('retry_failed_writes', {})
      .then((result) => {
        const change = result as { summary?: string; note?: string | null } | null;
        setMessage({ text: [change?.summary, change?.note].filter(Boolean).map((part) => `${part}${locale === 'zh' ? '。' : '.'}`).join(locale === 'zh' ? '' : ' ') || m.requeued, error: false });
      })
      .catch((reason: unknown) => setMessage({ text: memoryErrorText(reason, locale), error: true }))
      .finally(() => setBusy(false));
  };
  return (
    <Column testID="memory-writes" p="page-card" gap="card-row">
      <Column gap="text-stack">
        <Text testID="memory-writes-counts" size="body" weight="semibold">{writesLabel(writes, locale)}</Text>
        {statsLine ? <Text testID="memory-bank-stats" size="meta" tone="secondary">{statsLine}</Text> : null}
      </Column>
      {failed ? (
        <Column gap="card-row">
          <Text testID="memory-writes-failed" size="note" tone="danger-dark">{failed}</Text>
          <Row>
            <Button testID="memory-writes-retry" label={busy ? m.retrying : m.retryFailed} variant="outline" tone="neutral" size="sm" disabled={busy} onPress={retry} />
          </Row>
        </Column>
      ) : null}
      {message ? <Text testID="memory-writes-message" size="note" tone={message.error ? 'danger-dark' : 'secondary'}>{message.text}</Text> : null}
    </Column>
  );
}

function EmbeddingSettings({ memory }: { memory: MemorySettingsDto }) {
  const { embedding } = memory;
  // 没选过时，有远程配置就停在远程（daemon 这时在用它），否则停在本地。
  const initial: EmbeddingTab = embedding.mode === 'unset' ? (embedding.remote.baseUrl ? 'remote' : 'local') : embedding.mode;
  const [tab, setTab] = useState<EmbeddingTab>(initial);
  const m = useMessages(memoryMessages);
  const tabs: { value: EmbeddingTab; label: string }[] = [
    { value: 'local', label: m.tabLocal },
    { value: 'remote', label: m.tabRemote },
  ];
  return (
    <Section title="Embedding" hint={m.embeddingHint}>
      <Card rounded="xl" p="page-card" gap="card-section">
        <Row>
          <SegmentedControl
            testID="memory-embedding-tabs"
            options={tabs}
            value={tab}
            onChange={setTab}
            size="sm"
            optionTestID={(value) => `memory-embedding-tab-${value}`}
          />
        </Row>
        {tab === 'local' ? <LocalEmbedding memory={memory} /> : <RemoteEmbedding memory={memory} />}
      </Card>
    </Section>
  );
}

// 「正在用」只说实际在跑的那一个。选了但还没生效的写「已选」。
function InUse({ inUse, chosen }: { inUse: boolean; chosen: string | null }) {
  const m = useMessages(memoryMessages);
  if (inUse) return <Badge testID="memory-in-use" label={m.inUse} tone="success" dot size="sm" />;
  if (chosen) return <Badge testID="memory-chosen" label={chosen} tone="accent" size="sm" />;
  return null;
}

function DownloadProgress({ download, testID }: { download: MemoryDownload; testID: string }) {
  const label = downloadLabel(download, useLocale());
  if (!label) return null;
  return (
    <Column testID={testID} gap="text-stack">
      {download.state === 'downloading' ? <Row><ProgressBar value={downloadPercent(download)} color="accent" height={5} /></Row> : null}
      <Text size="secondary" tone={download.state === 'failed' ? 'danger-dark' : download.state === 'ready' ? 'success-dark' : 'secondary'}>{label}</Text>
    </Column>
  );
}

function useSave() {
  const runtime = useCompanionRuntime();
  const locale = useLocale();
  const m = memoryMessages(locale);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  // done 可以按 daemon 回的设置来写（例如旧 key 是不是删掉了）。
  const save = (request: MemorySettingsRequest, done: string | ((memory: MemorySettingsDto) => string), onSuccess?: () => void) => {
    setSaving(true);
    setMessage(null);
    runtime.updateMemorySettings(request)
      .then((memory) => {
        onSuccess?.();
        setMessage({ text: memoryNeedsUser(memory) ? m.confirmAbove : typeof done === 'function' ? done(memory) : done, error: false });
      })
      .catch((reason: unknown) => setMessage({ text: memoryErrorText(reason, locale), error: true }))
      .finally(() => setSaving(false));
  };
  return { saving, message, save };
}

function LocalEmbedding({ memory }: { memory: MemorySettingsDto }) {
  const { local } = memory.embedding;
  const locale = useLocale();
  const m = memoryMessages(locale);
  const active = memory.embedding.mode === 'local';
  const inUse = embeddingInUse(memory) === 'local';
  const { saving, message, save } = useSave();
  const download = local.download;
  const retry = active && download.state === 'failed';
  // PLC_MEMORY_BACKEND=sqlite 时 daemon 不跑记忆，也不接着下载：不说「在后台下载」「下载好后切换」。
  const turnedOff = memory.service.backend === 'sqlite';
  return (
    <Column testID="memory-embedding-local" gap="card-row">
      <Row items="center" gap="inline-item">
        <Text flex={1} size="card-title" weight="bold" mono>{local.model}</Text>
        <InUse
          inUse={inUse}
          chosen={!active || inUse ? null : turnedOff ? m.chosenOff : embeddingWaits(memory) ? m.chosenWaits
            : download.state === 'failed' ? m.chosenFailed : m.chosenAfterDownload}
        />
      </Row>
      <Text size="secondary" tone="secondary">{localEmbeddingHint(local.model, locale)}</Text>
      <DownloadProgress download={download} testID="memory-embedding-download" />
      {active && download.state === 'downloading' && !turnedOff ? (
        <Text size="secondary" tone="secondary">{m.backgroundDownload}</Text>
      ) : null}
      {!active || retry ? (
        <Row>
          <Button
            testID="memory-use-local"
            label={retry ? m.retryDownload : m.useLocal}
            size="sm"
            disabled={saving}
            onPress={() => save({ embedding: { mode: 'local' } }, m.savedDownloading)}
          />
        </Row>
      ) : null}
      {message ? <Text size="note" tone={message.error ? 'danger-dark' : 'secondary'}>{message.text}</Text> : null}
    </Column>
  );
}

function RemoteEmbedding({ memory }: { memory: MemorySettingsDto }) {
  const runtime = useCompanionRuntime();
  const locale = useLocale();
  const m = memoryMessages(locale);
  const { remote } = memory.embedding;
  const inUse = embeddingInUse(memory) === 'remote';
  const { form, setForm, field } = useServerForm<RemoteForm>({
    baseUrl: remote.baseUrl ?? '',
    model: remote.model ?? '',
    dimensions: remote.dimensions === null ? '' : String(remote.dimensions),
    apiKey: '',
  });
  const [problem, setProblem] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<{ text: string; ok: boolean } | null>(null);
  const { saving, message, save } = useSave();
  const hostChange = keyHostChange(remote.apiKeyHost, form.baseUrl, remote.apiKeySet);
  const plaintext = plaintextNote(form.baseUrl, locale);
  const mismatch = keyHostMismatchNote(remote.apiKeyHost, remote.baseUrl, remote.apiKeySet, locale);
  const submit = () => {
    const issue = remoteFormProblem(form, remote.apiKeySet, locale);
    setProblem(issue);
    if (issue) return;
    // key 在保存成功后才清空：失败时用户不用再粘贴一次。
    const dropped = hostChange && !form.apiKey.trim() ? hostChange : null;
    save(
      { embedding: remoteRequest(form) },
      (next) => (dropped && !next.embedding.remote.apiKeySet ? m.savedRestartedWith(keyDroppedNote(dropped, 'settings', locale)) : m.savedRestarted),
      () => setForm((current) => ({ ...current, apiKey: '' })),
    );
  };
  const test = () => {
    setTesting(true);
    setTested(null);
    runtime.testMemoryEmbedding()
      .then((result) => setTested({ text: testResultLabel(result, locale), ok: result.ok }))
      .catch((reason: unknown) => setTested({ text: memoryErrorText(reason, locale), ok: false }))
      .finally(() => setTesting(false));
  };
  return (
    <Column testID="memory-embedding-remote" gap="form-field">
      <Row items="center" gap="inline-item">
        <Text flex={1} size="card-title" weight="bold">{m.remoteTitle}</Text>
        <InUse inUse={inUse} chosen={null} />
      </Row>
      <Field label={m.address}>
        <TextField testID="memory-remote-base-url" value={form.baseUrl} onChangeText={field('baseUrl')} placeholder="https://api.openai.com/v1" variant="filled" size="sm" mono keyboardType="url" autoComplete="off" autoCapitalize="none" autoCorrect={false} />
      </Field>
      {plaintext ? <Text testID="memory-remote-plaintext" size="note" tone="warning-dark">{plaintext}</Text> : null}
      <Field label="API key">
        <TextField
          testID="memory-remote-api-key"
          value={form.apiKey}
          onChangeText={field('apiKey')}
          placeholder={hostChange ? m.pasteKeyFor(hostChange.to) : remote.apiKeySet ? m.keySet : m.pasteKey}
          variant="filled"
          size="sm"
          secure
          autoComplete="new-password"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>
      {hostChange ? <Text testID="memory-remote-host-change" size="note" tone="warning-dark">{keyHostChangeNote(hostChange, 'settings', locale)}</Text> : null}
      {!hostChange && mismatch ? <Text testID="memory-remote-key-mismatch" size="note" tone="warning-dark">{mismatch}</Text> : null}
      <Field label={m.model}>
        <TextField testID="memory-remote-model" value={form.model} onChangeText={field('model')} placeholder="text-embedding-3-small" variant="filled" size="sm" mono autoCapitalize="none" autoCorrect={false} />
      </Field>
      <Field label={m.dimensions}>
        <TextField testID="memory-remote-dimensions" value={form.dimensions} onChangeText={field('dimensions')} placeholder={m.dimensionsPlaceholder} variant="filled" size="sm" keyboardType="number-pad" />
      </Field>
      <Card tone="danger" rounded="lg" px="inset-x" py="inset-y" gap="card-row">
        <Text size="label" weight="bold" tone="danger-dark">{m.dataLeavesTitle}</Text>
        <Text testID="memory-remote-privacy" size="secondary" tone="secondary">{remotePrivacyNote(form.baseUrl || remote.baseUrl, locale)}</Text>
      </Card>
      {problem ? <Text size="note" tone="danger-dark">{problem}</Text> : null}
      <Row items="center" gap="actions" flexWrap="wrap">
        <Button testID="memory-remote-save" label={m.save} size="sm" disabled={saving} onPress={submit} />
        {/* 测试用的是已保存的配置（POST /v1/memory/test），所以没保存过地址时不能测。 */}
        <Button testID="memory-remote-test" label={m.testSaved} variant="outline" tone="neutral" size="sm" disabled={testing || !remote.baseUrl} onPress={test} />
        {tested ? <Text size="note" weight="bold" tone={tested.ok ? 'success-dark' : 'danger-dark'}>{tested.text}</Text> : null}
      </Row>
      {message ? <Text size="note" tone={message.error ? 'danger-dark' : 'secondary'}>{message.text}</Text> : null}
    </Column>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Column gap="field">
      <Text size="label" tone="secondary">{label}</Text>
      {children}
    </Column>
  );
}

function RerankerSettings({ memory }: { memory: MemorySettingsDto }) {
  const router = useRouter();
  const locale = useLocale();
  const m = memoryMessages(locale);
  const { decisionModel } = useDecisionModel();
  const { reranker } = memory;
  const { saving, message, save } = useSave();
  const decision = decisionModel ? { host: hostOf(decisionModel.baseUrl), apiKeySet: decisionModel.apiKeySet } : null;
  const fallback = rerankerFallbackNote(memory, decision, locale);
  const describe = (mode: MemorySettingsDto['reranker']['mode']) => mode === 'decision'
    ? decisionRerankDescription(memory, decision, locale)
    : mode === 'local' ? m.rerankLocal : m.rerankNone;
  // 选决策模型只是保存选择：要往外发时，daemon 先出一张待确认的切换卡（见最上面），用户同意了才开始。
  const choose = (mode: MemorySettingsDto['reranker']['mode']) => {
    if (reranker.mode !== mode) save({ reranker: { mode } }, m.savedRestarted);
  };
  return (
    <Section title={m.reranking} hint={m.rerankingHint}>
      {/* spacing-exempt: 行自带分隔线；行自带内边距 */}
      <Card role="radiogroup" aria-label={m.reranking} rounded="xl" p={4} gap={0}>
        {(['decision', 'local', 'none'] as const).map((mode, index) => (
          <Pressable
            key={mode}
            testID={`memory-reranker-${mode}`}
            role="radio"
            aria-label={m.rerankWith(m.rerankerLabels[mode])}
            aria-checked={reranker.mode === mode}
            disabled={saving}
            onPress={() => choose(mode)}
            px="row-x"
            py="row-y"
            borderTopWidth={index === 0 ? 0 : 1}
            borderTopColor="border-soft"
          >
            <Row items="flex-start" gap="side-item">
              <Radio selected={reranker.mode === mode} />
              <Column flex={1} minW={0} gap="text-stack">
                <Row items="center" gap="inline-item">
                  <Text size="card-title" weight="bold">{m.rerankerLabels[mode]}</Text>
                  {mode === 'decision' ? <Text size="meta" tone="muted">{m.defaultTag}</Text> : null}
                </Row>
                <Text testID={`memory-reranker-${mode}-description`} size="secondary" tone="secondary">{describe(mode)}</Text>
                {mode === 'local' ? <DownloadProgress download={reranker.local.download} testID="memory-reranker-download" /> : null}
              </Column>
            </Row>
          </Pressable>
        ))}
      </Card>
      {fallback ? (
        <Card testID="memory-reranker-fallback" tone="warning" rounded="lg" px="banner-x" py="banner-y" gap="card-row">
          <Text size="body">{fallback.text}</Text>
          {fallback.setUpKey ? (
            <Row><Button label={m.setUpDecision} variant="outline" tone="neutral" size="sm" onPress={() => router.push('/settings/model' as Href)} /></Row>
          ) : null}
        </Card>
      ) : null}
      {message ? <Text testID="memory-reranker-message" size="note" tone={message.error ? 'danger-dark' : 'secondary'}>{message.text}</Text> : null}
    </Section>
  );
}

// 单选的圆圈：选中时是粗的强调色描边。
function Radio({ selected }: { selected: boolean }) {
  return (
    <Box
      testID={selected ? 'memory-radio-selected' : undefined}
      w={16}
      h={16}
      mt={1} // spacing-exempt: 光学对齐
      shrink={0}
      rounded="full"
      borderWidth={selected ? 5 : 1.5}
      borderColor={selected ? 'accent' : 'border-strong'}
    />
  );
}
