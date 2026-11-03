import type { ActivityDto, Locale, TicketDetail, TicketRelation, TicketSummary } from '@pi-lead-child/protocol';

import type { AttemptEntity } from '@/state/types';

import { decisionLabel } from './decisionLabels';
import { timeLabel } from './timeLabels';
import { runOutcome, type RunFacts, type RunOutcomeTone } from './runFacts';
import { runFactsMessages } from './runFacts.messages';
import { ticketHistoryMessages } from './ticketHistory.messages';

export type LifecyclePresentation = {
  id: string;
  title: string;
  createdAt: string;
  actor: string;
  reason: string | null;
  sourceTicketId: number;
  attemptId: number | null;
};

export type AttemptPresentation = {
  id: number;
  runtime: string;
  model: string;
  /** 这次 Run 记下的模型。没记下时是 null（model 那时写「未记录 model」）。 */
  recordedModel: string | null;
  effort: string | null;
  /** runtime、模型和 effort 合成的一行，例如「codex · gpt-6.1-sol · effort high」。 */
  choice: string;
  /** 这次 Run 是做什么的：执行、核查、对话（runFacts）。 */
  purposeLabel: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  /** 按用途写的结果：核查写结论，对话写有没有回答，执行写有没有交付。 */
  result: string;
  resultTone: RunOutcomeTone;
  failurePreview: string | null;
  failureFull: string | null;
  failureTruncated: boolean;
};

// Workbench snapshots may lag behind the attempts collection. Prefer the newest
// live attempt, then the newest known attempt, and only use the workbench hint
// while the execution collection is still empty.
export function selectDisplayedAttemptId(
  attempts: readonly Pick<AttemptEntity, 'id' | 'state'>[],
  workbenchActiveAttemptId: number | null,
): number | null {
  const live = attempts
    .filter((attempt) => attempt.state === 'starting' || attempt.state === 'running')
    .reduce<number | null>((latest, attempt) => latest === null || attempt.id > latest ? attempt.id : latest, null);
  if (live !== null) return live;
  const latest = attempts.reduce<number | null>(
    (current, attempt) => current === null || attempt.id > current ? attempt.id : current,
    null,
  );
  return latest ?? workbenchActiveAttemptId;
}

export type RelationPresentation = TicketRelation & {
  title: string | null;
  relatedStage: TicketSummary['stage'] | null;
  label: string;
  group: 'family' | 'dependency' | 'implementation' | 'replacement' | 'duplicate' | 'related';
  groupLabel: string;
  stateLabel: string;
  meta: string;
  detail: string | null;
};

// leadName 是 Lead 的名字（useLeadName）。
function actorLabel(actor: ActivityDto['actor'], leadName: string, locale: Locale): string {
  return actor === 'lead' ? leadName : ticketHistoryMessages(locale).actor[actor];
}

export function buildLifecyclePresentation(input: {
  ticketId: number;
  detail?: TicketDetail;
  activities: ActivityDto[];
  leadName: string;
  /** 每次 Run 是做什么的（buildRunFacts）。开始、失败的那一行写「核查开始」「执行失败」，不写 Run 的编号（设计规范 P14.6）。 */
  facts?: ReadonlyMap<number, Pick<RunFacts, 'purpose'>>;
  /** 界面语言。不给时按英文。 */
  locale?: Locale;
}): LifecyclePresentation[] {
  const { leadName } = input;
  const locale = input.locale ?? 'en';
  const m = ticketHistoryMessages(locale);
  const purposes = runFactsMessages(locale).purpose;
  const purposeOf = (attemptId: number | null) => purposes[
    (attemptId === null ? undefined : input.facts?.get(attemptId)?.purpose) ?? 'execution'
  ];
  const items: LifecyclePresentation[] = [];
  if (input.detail) {
    items.push({
      id: `ticket:${input.ticketId}:created`,
      title: m.createdTicket,
      createdAt: input.detail.createdAt,
      actor: input.detail.createdBy ? actorLabel(input.detail.createdBy, leadName, locale) : m.notRecorded,
      reason: null,
      sourceTicketId: input.ticketId,
      attemptId: null,
    });
  }
  for (const activity of input.activities) {
    if (activity.kind === 'transition') {
      const from = text(activity.payload.from);
      const to = text(activity.payload.to);
      const label = to ? m.transition[to] ?? m.stateChangedTo(to) : m.stateChanged;
      items.push({
        id: `activity:${activity.id}`,
        title: from && to ? m.transitionTitle(label, from, to) : label,
        createdAt: activity.createdAt,
        actor: actorLabel(activity.actor, leadName, locale),
        reason: text(activity.payload.reason) ?? m.noReason,
        sourceTicketId: activity.ticketId,
        attemptId: activity.attemptId,
      });
    } else if (activity.kind === 'decision') {
      const label = decisionLabel(text(activity.payload.decision), leadName, activity.payload, locale);
      const reason = decisionReason(activity.payload, locale) ?? text(activity.payload.summary);
      items.push({
        id: `activity:${activity.id}`,
        title: label.title,
        createdAt: activity.createdAt,
        actor: actorLabel(activity.actor, leadName, locale),
        // 没收录的机器 id 不当标题，留在说明里方便排查。
        reason: [reason, label.unknownId ? m.recordType(label.unknownId) : null].filter(Boolean).join(' · ') || null,
        sourceTicketId: activity.ticketId,
        attemptId: activity.attemptId,
      });
    } else if (activity.kind === 'attempt_start') {
      const runtime = text(activity.payload.runtime);
      const model = text(activity.payload.model);
      const effort = text(activity.payload.effort);
      items.push({
        id: `activity:${activity.id}`,
        title: m.runStarting(purposeOf(activity.attemptId)),
        createdAt: activity.createdAt,
        actor: actorLabel(activity.actor, leadName, locale),
        reason: [runtime, model, effort ? `effort ${effort}` : null].filter(Boolean).join(' · ') || null,
        sourceTicketId: activity.ticketId,
        attemptId: activity.attemptId,
      });
    } else if (activity.kind === 'crash') {
      items.push({
        id: `activity:${activity.id}`,
        title: m.runFailed(purposeOf(activity.attemptId)),
        createdAt: activity.createdAt,
        actor: actorLabel(activity.actor, leadName, locale),
        reason: decisionReason(activity.payload, locale),
        sourceTicketId: activity.ticketId,
        attemptId: activity.attemptId,
      });
    } else if (activity.kind === 'notification') {
      items.push({
        id: `activity:${activity.id}`,
        title: text(activity.payload.title) ?? m.systemBlock,
        createdAt: activity.createdAt,
        actor: actorLabel(activity.actor, leadName, locale),
        reason: text(activity.payload.summary) ?? decisionReason(activity.payload, locale),
        sourceTicketId: activity.ticketId,
        attemptId: activity.attemptId,
      });
    }
  }
  return items.sort((left, right) => left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id));
}

export function buildAttemptPresentation(
  attempts: AttemptEntity[],
  facts: ReadonlyMap<number, RunFacts> = new Map(),
  locale: Locale = 'en',
): AttemptPresentation[] {
  const m = ticketHistoryMessages(locale);
  return [...attempts].sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id - right.id)
    .map((attempt) => {
      const failure = attempt.errorMessage ?? attempt.errorCode;
      const preview = failure ? truncateText(failure, 240) : null;
      const outcome = runOutcome(attempt, facts.get(attempt.id), locale);
      const runtime = attempt.runtime ?? m.unknownRuntime;
      const model = attempt.model ?? m.modelNotRecorded;
      return {
        id: attempt.id,
        runtime,
        model,
        recordedModel: attempt.model ?? null,
        effort: attempt.effort,
        choice: [runtime, model, attempt.effort ? `effort ${attempt.effort}` : null].filter(Boolean).join(' · '),
        purposeLabel: outcome.purposeLabel,
        startedAt: attempt.startedAt,
        endedAt: attempt.endedAt,
        durationMs: duration(attempt.startedAt, attempt.endedAt),
        result: outcome.result,
        resultTone: outcome.tone,
        failurePreview: preview,
        failureFull: failure ?? null,
        failureTruncated: failure !== null && preview !== failure,
      };
    });
}

export function buildRelationPresentation(
  detail: TicketDetail | undefined,
  tickets: TicketSummary[],
  leadName: string,
  locale: Locale = 'en',
): RelationPresentation[] {
  const m = ticketHistoryMessages(locale);
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  return (detail?.relations ?? []).map((relation) => {
    const related = byId.get(relation.ticketId);
    return ({
    ...relation,
    title: related?.title ?? null,
    relatedStage: related?.stage ?? null,
    label: m.relation[relation.kind],
    group: relationGroup(relation.kind),
    groupLabel: m.relationGroup[relationGroup(relation.kind)],
    stateLabel: relation.active === false ? m.relationRevoked : m.relationActive,
    meta: relationMeta(relation, leadName, locale),
    detail: relationDetail(relation, related?.stage ?? null, locale),
  });
  }).sort((left, right) => relationGroupOrder(left.group) - relationGroupOrder(right.group)
    || Number(left.active === false) - Number(right.active === false)
    || (left.createdAt ?? '').localeCompare(right.createdAt ?? '')
    || left.ticketId - right.ticketId);
}

export function truncateText(value: string, limit: number): string {
  const points = Array.from(value);
  return points.length <= limit ? value : `${points.slice(0, limit).join('')}…`;
}

function decisionReason(payload: Record<string, unknown>, locale: Locale): string | null {
  const m = ticketHistoryMessages(locale);
  const direct = text(payload.reason) ?? text(payload.message) ?? text(payload.text);
  if (direct) return direct;
  const mode = text(payload.mode);
  const restored = integerList(payload.restoredItemIds);
  const retained = integerList(payload.retainedCancelledIds);
  const parts = [
    mode ? m.reasonMode(mode) : null,
    restored.length > 0 ? m.reasonRestored(restored.map((id) => `#${id}`)) : null,
    retained.length > 0 ? m.reasonKeptCancelled(retained.map((id) => `#${id}`)) : null,
  ].filter((part): part is string => part !== null);
  return m.joinParts(parts) || null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function integerList(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => Number.isSafeInteger(item) && item > 0)
    : [];
}

function duration(startedAt: string, endedAt: string | null): number | null {
  if (!endedAt) return null;
  const value = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

function relationGroup(kind: TicketRelation['kind']): RelationPresentation['group'] {
  if (kind === 'parent_of' || kind === 'child_of') return 'family';
  if (kind === 'depends_on' || kind === 'blocks') return 'dependency';
  if (kind === 'implements' || kind === 'implemented_by') return 'implementation';
  if (kind === 'supersedes' || kind === 'superseded_by') return 'replacement';
  if (kind === 'duplicates' || kind === 'duplicated_by') return 'duplicate';
  return 'related';
}

function relationGroupOrder(group: RelationPresentation['group']): number {
  return {
    family: 0,
    dependency: 1,
    implementation: 2,
    replacement: 3,
    duplicate: 4,
    related: 5,
  }[group];
}

function relationMeta(relation: TicketRelation, leadName: string, locale: Locale): string {
  const m = ticketHistoryMessages(locale);
  const source = relation.source === 'tree' ? m.relationSource.tree : m.relationSource.ledger;
  const actor = relation.createdBy ? actorLabel(relation.createdBy, leadName, locale) : source;
  const created = relation.createdAt ? timeLabel(relation.createdAt, undefined, locale) : m.existingStructure;
  const revoked = relation.revokedAt ? m.revokedAt(timeLabel(relation.revokedAt, undefined, locale)) : '';
  return `${source} · ${actor} · ${created}${revoked}`;
}

function relationDetail(relation: TicketRelation, relatedStage: TicketSummary['stage'] | null, locale: Locale): string | null {
  const m = ticketHistoryMessages(locale);
  const gate = relation.executionGate === 'target_done'
    ? relation.kind === 'implements'
      ? relatedStage === 'done'
        ? m.gateMet(relation.ticketId)
        : m.gateWaiting(relation.ticketId)
      : relation.kind === 'implemented_by'
        ? relatedStage === 'done'
          ? m.relatedDone(relation.ticketId)
          : m.relatedStartsAfter(relation.ticketId)
        : null
    : null;
  const parts = [
    gate,
    relation.reason ? m.reason(relation.reason) : null,
    relation.revokeReason ? m.revokeReason(relation.revokeReason) : null,
  ].filter((part): part is string => part !== null);
  return m.joinParts(parts) || null;
}
