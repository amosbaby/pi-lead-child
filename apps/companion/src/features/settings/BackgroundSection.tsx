import { Card, Column, Dot, Icon, Popover, RecordRow, Row, Text } from '@pi-lead-child/components';
import { BACKGROUND_MODEL_SOURCES, type BackgroundJobState, type BackgroundModelReadResult } from '@pi-lead-child/protocol';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { useLocale } from '@/i18n';
import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useLeadName } from '@/state/hooks';

import { BACKGROUND_JOBS, backgroundMessages } from './background.messages';
import { memoryErrorText } from './memoryModel';

// 设置 → 模型的「后台工作」卡（2026-11-20，.scratch/background-models/spec.md，主题 11.25）。
// - 后台模型：表单的下拉（主题 11.19 表单）。第一项「自动：最便宜的合适模型（现在是哪个）」，然后是现在便宜的模型，
//   再下面是目录里其他的模型（不便宜，只有你能选）。选了马上保存（操作层的 background_model.set，和 Lead 同一个函数）；
//   保存期间写「正在保存…」，没保存成功时写原因，下拉退回保存着的值。
// - 每个后台任务一行：今天的调用和失败次数，状态（正常，或者从什么时候起一直失败、原因、系统已经做了什么）。
//   状态用主题的状态点加同色文字：正常是「完成」类（C-13），一直失败是「失败」类（C-15）。暂停的模型写到什么时候。
// - 打开时读一次（background_model.read），每次保存以后再读一次。不轮询。
// - 旧 daemon 没有这个操作（not_found）时只写一行「daemon 太旧」。
const AUTO = '__auto__';

type Load =
  | { state: 'loading' }
  | { state: 'unsupported' }
  | { state: 'error'; reason: unknown }
  | { state: 'ready'; read: BackgroundModelReadResult };

export function BackgroundSection() {
  const runtime = useCompanionRuntime();
  const locale = useLocale();
  const m = backgroundMessages(locale);
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  // 失败时只记原因，文字在画的时候按当前语言取。
  const reload = useCallback(async () => {
    try {
      const read = backgroundRead(await runtime.readBackgroundModel());
      setLoad(read ? { state: 'ready', read } : { state: 'error', reason: null });
    } catch (reason) {
      setLoad(isUnknownOperation(reason) ? { state: 'unsupported' } : { state: 'error', reason });
    }
  }, [runtime]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (load.state === 'unsupported') {
    return <Text testID="background-unsupported" size="note" tone="muted">{m.unsupported}</Text>;
  }
  if (load.state !== 'ready') {
    return (
      <Text testID="background-loading" size="note" tone={load.state === 'error' ? 'danger-dark' : 'muted'}>
        {load.state === 'error' ? m.loadFailed(memoryErrorText(load.reason, locale)) : m.loading}
      </Text>
    );
  }
  return <BackgroundCard read={load.read} reload={reload} />;
}

function BackgroundCard({ read, reload }: { read: BackgroundModelReadResult; reload: () => Promise<void> }) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const locale = useLocale();
  const m = backgroundMessages(locale);
  // 正在保存的选择（AUTO 是自动）。保存完以后重读 daemon 的值；没保存成功时退回。
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = (model: string | null) => {
    if (pending !== null || model === read.setting) return;
    setPending(model ?? AUTO);
    setError(null);
    runtime.setBackgroundModel(model)
      .then(() => reload())
      .catch((reason: unknown) => setError(m.failed(memoryErrorText(reason, locale))))
      .finally(() => setPending(null));
  };

  const shown = pending === null ? read.setting : pending === AUTO ? null : pending;
  return (
    <Card testID="background-section" rounded="xl" p="page-card" gap="form-field">
      <Column gap="text-stack">
        <Text size="card-title" weight="extrabold">{m.title}</Text>
        <Text size="note" tone="muted">{m.intro(leadName)}</Text>
      </Column>
      <Field testID="background-model" label={m.modelLabel} note={m.rule(leadName, read.main)}>
        <ModelSelect read={read} value={shown} disabled={pending !== null} onPick={save} />
        <Text testID="background-model-source" size="note" tone="secondary">{m.source[read.source](read.resolved, leadName)}</Text>
      </Field>
      <Field testID="background-jobs" label={m.jobsLabel}>
        {read.jobs.length === 0 ? <Text size="note" tone="muted">{m.noJobs}</Text> : read.jobs.map((job) => <JobRow key={job.job} job={job} />)}
      </Field>
      {read.broken.length ? (
        <Field testID="background-broken" label={m.brokenLabel}>
          {read.broken.map((entry) => (
            <Column key={entry.model} testID={`background-broken-${entry.model}`} gap="text-stack">
              <Text size="body" weight="semibold" numberOfLines={1}>{entry.model}</Text>
              <Text size="note" tone="secondary">{m.broken(shortTime(entry.until), entry.reason)}</Text>
            </Column>
          ))}
        </Field>
      ) : null}
      {error ? <Text testID="background-error" size="note" tone="danger-dark">{error}</Text> : null}
      <Text testID="background-footnote" size="meta" tone="muted">{pending !== null ? m.saving : m.footnote}</Text>
    </Card>
  );
}

// 一个后台任务：状态点和名字，右边是状态词；下面一行今天的次数；一直失败时再写原因和系统做了什么。
function JobRow({ job }: { job: BackgroundJobState }) {
  const locale = useLocale();
  const m = backgroundMessages(locale);
  const failing = job.state === 'failing';
  const name = BACKGROUND_JOBS.find((known) => known === job.job);
  return (
    <Column testID={`background-job-${job.job}`} gap="text-stack">
      <Row items="center" gap="icon-label">
        <Dot color={failing ? 'danger' : 'success'} size={7} />
        <Text flex={1} minW={0} size="body" weight="semibold" numberOfLines={1}>{name ? m.jobs[name] : job.job}</Text>
        <Text testID={`background-job-${job.job}-state`} size="label" weight="semibold" tone={failing ? 'danger-dark' : 'success-dark'}>
          {failing ? (job.since ? m.failingSince(shortTime(job.since)) : m.failing) : m.ok}
        </Text>
      </Row>
      <Text size="meta" tone="muted">{m.today(job.callsToday, job.failuresToday)}</Text>
      {failing && job.reason ? <Text size="note" tone="secondary">{m.reason(job.reason)}</Text> : null}
      {failing && job.action ? <Text size="note" tone="secondary">{m.action(job.action)}</Text> : null}
    </Column>
  );
}

// 表单字段的写法（主题 11.19 表单）：标签、控件、说明。
function Field({ testID, label, note, children }: { testID: string; label: string; note?: string; children: ReactNode }) {
  return (
    <Column testID={testID} gap="field">
      <Text size="label" weight="bold" tone="secondary">{label}</Text>
      {children}
      {note ? <Text size="note" tone="muted">{note}</Text> : null}
    </Column>
  );
}

// 后台模型的下拉（主题 11.19 表单的单选下拉）：第一项自动，然后现在便宜的模型，再下面是目录里其他的模型。
// 目录取不到时，只有自动、便宜的模型和现在设的模型。
function ModelSelect({ read, value, disabled, onPick }: {
  read: BackgroundModelReadResult; value: string | null; disabled: boolean; onPick: (model: string | null) => void;
}) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const locale = useLocale();
  const m = backgroundMessages(locale);
  const [catalog, setCatalog] = useState<string[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    runtime.loadLeadModels()
      .then((models) => { if (live) setCatalog(models.models.map((option) => option.model)); })
      .catch((reason: unknown) => { if (live) setFailed(memoryErrorText(reason, locale)); });
    return () => { live = false; };
  }, [runtime, locale]);

  const paused = new Map(read.broken.map((entry) => [entry.model, entry.until]));
  const cheap = read.cheap;
  const others = [...new Set([...(value && !cheap.includes(value) ? [value] : []), ...catalog])].filter((model) => !cheap.includes(model));
  // 自动现在会用哪个：没有选时就是 daemon 算出来的；选了别的时是第一个没暂停的便宜模型。
  const automatic = read.setting === null ? read.resolved : cheap.find((model) => !paused.has(model)) ?? null;
  const autoLabel = m.automatic(automatic);
  const current = value ?? AUTO;

  const trigger = (
    // 和 sm 的输入框同高（TextField.shared 的 sm 是 32），和表单的下拉一样。
    <Row items="center" gap="inline-item" px="inset-x" h={32} rounded="md" bg="surface-subtle" borderWidth={1} borderColor="border">
      <Text testID="background-model-value" flex={1} minW={0} size="body" tone={disabled ? 'muted' : 'default'} numberOfLines={1}>
        {value === null ? autoLabel : value}
      </Text>
      <Icon name="chevron-down" size={14} color="text-secondary" />
    </Row>
  );
  const row = (model: string, detail: string, divider: boolean, close: () => void) => {
    const until = paused.get(model);
    return (
      <RecordRow
        key={model}
        testID={`background-model-${model}`}
        divider={divider}
        title={model}
        detail={until ? `${detail} · ${m.pausedTag(shortTime(until))}` : detail}
        trailing={model === current ? <Icon name="check" size={16} color="accent" /> : undefined}
        onPress={() => { close(); onPick(model); }}
      />
    );
  };
  return (
    <Column gap="field">
      {disabled ? trigger : (
        <Popover testID="background-model-input" label={m.modelLabel} title={m.modelLabel} width={360} trigger={trigger}>
          {(close) => (
            <Column>
              <RecordRow
                testID="background-model-auto"
                title={autoLabel}
                trailing={current === AUTO ? <Icon name="check" size={16} color="accent" /> : undefined}
                onPress={() => { close(); onPick(null); }}
              />
              {cheap.length ? <GroupLabel testID="background-model-cheap-group" label={m.cheapGroup} /> : null}
              {cheap.map((model, index) => row(model, m.cheapTag, index > 0, close))}
              {others.length ? <GroupLabel testID="background-model-other-group" label={m.otherGroup} divider /> : null}
              {others.map((model, index) => row(model, m.notCheapTag(leadName), index > 0, close))}
            </Column>
          )}
        </Popover>
      )}
      {failed ? <Text size="note" tone="danger-dark">{m.modelsFailed(failed)}</Text> : null}
    </Column>
  );
}

// 下拉里一组的名字（主题 11.18 的组名：meta、600、text-faint）。「不便宜的」一组上面一条分隔线。
function GroupLabel({ testID, label, divider = false }: { testID: string; label: string; divider?: boolean }) {
  return (
    <Column testID={testID} px="row-x" pt="row-y" borderTopWidth={divider ? 1 : 0} borderColor="border-soft">
      <Text size="meta" weight="semibold" tone="faint">{label}</Text>
    </Column>
  );
}

// 旧 daemon 不认识 background_model 这个目标或者 read 这个操作：操作层回 not_found。
function isUnknownOperation(reason: unknown): boolean {
  const code = reason !== null && typeof reason === 'object' ? (reason as { code?: unknown }).code : undefined;
  return code === 'not_found';
}

// read 的结果：只检查卡片要用的字段。daemon 以后多给的字段不影响。
function backgroundRead(value: unknown): BackgroundModelReadResult | null {
  if (value === null || typeof value !== 'object') return null;
  const read = value as Partial<BackgroundModelReadResult>;
  const source = BACKGROUND_MODEL_SOURCES.find((known) => known === read.source);
  if (!source || !Array.isArray(read.cheap)) return null;
  const text = (field: unknown) => (typeof field === 'string' ? field : null);
  return {
    setting: text(read.setting),
    resolved: text(read.resolved),
    source,
    main: text(read.main),
    cheap: read.cheap.filter((model): model is string => typeof model === 'string'),
    broken: Array.isArray(read.broken) ? read.broken.filter((entry) => entry && typeof entry.model === 'string') : [],
    jobs: Array.isArray(read.jobs) ? read.jobs.filter((job) => job && typeof job.job === 'string') : [],
  };
}

// 短时间（P14.2）：「11-20 14:05」。
function shortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
