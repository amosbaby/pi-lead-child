import { Box, Button, Card, Column, Dot, Row, Text, TextField } from '@pi-lead-child/components';
import type { TicketRelationKind } from '@pi-lead-child/protocol';
import { useState } from 'react';

import { useLocale, useMessages } from '@/i18n';
import type { ResourceLoadState } from '@/state/types';

import type { AttemptPresentation, LifecyclePresentation, RelationPresentation } from './ticketHistory';
import { ticketRecordsMessages } from './ticketRecords.messages';
import { timeLabel, timeRangeLabel } from './timeLabels';

type HistoryMessages = ReturnType<typeof ticketRecordsMessages>['history'];

export type TicketHistorySection = 'lifecycle' | 'attempts' | 'relations';

type Props = {
  currentTicketId?: string;
  /** 只画这几块。概览只放工单关系，证据与记录里生命周期和执行尝试各占一个页签。缺省三块都画。 */
  sections?: readonly TicketHistorySection[];
  /** 不留外边距：放进已经有边距的容器时用。 */
  flush?: boolean;
  lifecycle: LifecyclePresentation[];
  attempts: AttemptPresentation[];
  relations: RelationPresentation[];
  executionResource?: ResourceLoadState;
  relationActionState?: TicketRelationActionState;
  onOpenTicket?: (ticketId: string) => void;
  onLinkRelation?: (input: TicketRelationCreateInput) => void;
  onRevokeRelation?: (relationId: number, reason: string) => void;
  onRetry?: () => void;
};

export type TicketRelationCreateType = Extract<
  TicketRelationKind,
  'depends_on' | 'implements' | 'duplicates' | 'supersedes' | 'relates_to'
>;

export type TicketRelationCreateInput = {
  targetTicketId: number;
  relationType: TicketRelationCreateType;
  reason: string;
};

export type TicketRelationActionState = {
  pending: boolean;
  error?: string | null;
  message?: string | null;
};

// 建立关系的选项：名字和说明在文案的 history.relationOptions 里。
const CREATE_RELATION_TYPES: { type: TicketRelationCreateType; highImpact?: boolean }[] = [
  { type: 'depends_on', highImpact: true },
  { type: 'implements' },
  { type: 'duplicates', highImpact: true },
  { type: 'supersedes', highImpact: true },
  { type: 'relates_to' },
];

type RelationOption = { type: TicketRelationCreateType; label: string; description: string; highImpact?: boolean };

function relationOptions(m: HistoryMessages): RelationOption[] {
  return CREATE_RELATION_TYPES.map((option) => ({ ...option, ...m.relationOptions[option.type] }));
}

// 工单详情的"日志"页签里的历史：生命周期、执行尝试和工单关系（可以建立和撤销关系）。
export function TicketHistorySections({
  currentTicketId,
  sections = ['lifecycle', 'attempts', 'relations'],
  flush = false,
  lifecycle,
  attempts,
  relations,
  executionResource,
  relationActionState,
  onOpenTicket,
  onLinkRelation,
  onRevokeRelation,
  onRetry,
}: Props) {
  const locale = useLocale();
  const messages = useMessages(ticketRecordsMessages);
  const m = messages.history;
  const options = relationOptions(m);
  const [expandedFailures, setExpandedFailures] = useState<Record<number, boolean>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [targetTicketText, setTargetTicketText] = useState('');
  const [relationType, setRelationType] = useState<TicketRelationCreateType>('depends_on');
  const [relationReason, setRelationReason] = useState('');
  const [confirmingHighImpact, setConfirmingHighImpact] = useState(false);
  const [revokingRelationId, setRevokingRelationId] = useState<number | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const executionError = executionResource?.state === 'error' ? executionResource.error : null;
  const show = (section: TicketHistorySection) => sections.includes(section);
  const relationTicketGroups = groupRelationsByTicket(relations);
  const selectedRelation = options.find((option) => option.type === relationType) ?? options[0]!;
  const targetTicketId = Number(targetTicketText.trim().replace(/^#/, ''));
  const createDisabled = !onLinkRelation || relationActionState?.pending
    || !Number.isSafeInteger(targetTicketId) || targetTicketId <= 0
    || String(targetTicketId) === currentTicketId
    || !relationReason.trim();
  const revokeDisabled = !onRevokeRelation || relationActionState?.pending || !revokeReason.trim();
  const submitRelation = () => {
    if (createDisabled) return;
    if (selectedRelation.highImpact && !confirmingHighImpact) {
      setConfirmingHighImpact(true);
      return;
    }
    onLinkRelation?.({
      targetTicketId,
      relationType,
      reason: relationReason,
    });
    setConfirmingHighImpact(false);
  };
  const submitRevoke = () => {
    if (revokingRelationId === null || revokeDisabled) return;
    onRevokeRelation?.(revokingRelationId, revokeReason);
    setRevokingRelationId(null);
    setRevokeReason('');
  };
  const createPanel = createOpen ? (
    <RelationCreatePanel
      showEmptyNote={relations.length === 0}
      relationType={relationType}
      onRelationType={(type) => {
        setRelationType(type);
        setConfirmingHighImpact(false);
      }}
      targetTicketText={targetTicketText}
      onTargetTicketText={(value) => {
        setTargetTicketText(value);
        setConfirmingHighImpact(false);
      }}
      relationReason={relationReason}
      onRelationReason={(value) => {
        setRelationReason(value);
        setConfirmingHighImpact(false);
      }}
      selfReference={String(targetTicketId) === currentTicketId && Boolean(targetTicketText.trim())}
      confirmingHighImpact={confirmingHighImpact}
      actionState={relationActionState}
      submitDisabled={createDisabled}
      onSubmit={submitRelation}
      options={options}
      m={m}
    />
  ) : null;

  return (
    <Column testID="ticket-history" mx={flush ? 0 : 20} mt={flush ? 0 : 14} gap="card-section">
      {executionError ? (
        <Column role="alert" gap="card-row" px="banner-x" py="banner-y" borderWidth={1} borderColor="danger" rounded="md" bg="danger-soft">
          <Text size="card-title" weight="bold" tone="danger-dark">{m.readFailed}</Text>
          <FailureText>{executionError}</FailureText>
          <Box self="flex-start">
            <Button disabled={!onRetry} label={m.retryRead} onPress={onRetry} testID="ticket-history-retry" variant="outline" tone="neutral" size="sm" />
          </Box>
        </Column>
      ) : null}
      {show('lifecycle') ? (
        <>
      <SectionTitle title={m.lifecycle} />
      <Column gap="stacked-card">
        {lifecycle.length > 0 ? lifecycle.map((entry) => (
          <Row key={entry.id} testID={`lifecycle-${entry.id}`} gap="timeline">
            {/* spacing-exempt: 光学对齐 */}
            <Box mt={5}><Dot color="accent" size={7} /></Box>
            <Column minW={0} flex={1} pb="timeline-event" borderBottomWidth={1} borderBottomColor="border-soft">
              <EntryTitle>{entry.title}</EntryTitle>
              <MetaText>{m.lifecycleMeta(timeLabel(entry.createdAt, undefined, locale), entry.actor, String(entry.sourceTicketId))}</MetaText>
              {entry.reason ? <DetailText>{entry.reason}</DetailText> : null}
            </Column>
          </Row>
        )) : <EmptyText>{executionError ? m.lifecycleUnavailable : m.lifecycleLoading}</EmptyText>}
      </Column>
        </>
      ) : null}

      {show('attempts') ? (
        <>
      <SectionTitle title={m.attempts} />
      {executionResource?.state === 'loading' && attempts.length === 0 ? (
        <EmptyText>{m.attemptsLoading}</EmptyText>
      ) : attempts.length === 0 ? (
        <Card testID="attempts-empty" p="card" borderColor="border-soft" rounded="md">
          <Text size="secondary" weight="bold" tone="secondary">{m.notRun}</Text>
        </Card>
      ) : (
        <Column gap="stacked-card">
          {attempts.map((attempt) => {
            const expanded = Boolean(expandedFailures[attempt.id]);
            const failure = expanded ? attempt.failureFull : attempt.failurePreview;
            return (
              <Card key={attempt.id} testID={`attempt-${attempt.id}`} p="card" borderColor="border-soft" rounded="md">
                <Row flexWrap="wrap" justify="space-between" gap="inline-item">
                  <EntryTitle>{`${attempt.purposeLabel} · ${attempt.result}`}</EntryTitle>
                  <Text size="meta" mono tone="accent">{attempt.choice}</Text>
                </Row>
                <MetaText>{`${timeRangeLabel(attempt.startedAt, attempt.endedAt, undefined, locale)}${attempt.durationMs === null ? '' : ` · ${formatDuration(attempt.durationMs)}`}`}</MetaText>
                {failure ? <FailureText>{failure}</FailureText> : null}
                {attempt.failureTruncated ? (
                  <Box self="flex-start">
                    <Button
                      label={expanded ? m.hideFailure : m.showFailure}
                      onPress={() => setExpandedFailures((current) => ({ ...current, [attempt.id]: !expanded }))}
                      testID={`attempt-failure-toggle-${attempt.id}`}
                      variant="link"
                      size="xs"
                    />
                  </Box>
                ) : null}
              </Card>
            );
          })}
        </Column>
      )}
        </>
      ) : null}

      {show('relations') && (relations.length > 0 || onLinkRelation) ? (
        <>
          <SectionTitle title={m.relations} />
          <Row justify="flex-start" mb="text-stack">
            <Button
              disabled={!onLinkRelation}
              label={createOpen && relations.length > 0 ? m.hideCreate : m.create}
              onPress={() => {
                setCreateOpen((open) => (relations.length > 0 ? !open : true));
                setConfirmingHighImpact(false);
              }}
              testID="ticket-relation-create-toggle"
              variant="outline"
              tone="neutral"
              size="sm"
            />
          </Row>
          {createPanel}
          {relations.length > 0 ? (
            <Column gap="stacked-card">
              {relationTicketGroups.map((group) => (
                <Card
                  key={group.ticketId}
                  testID={`ticket-relation-ticket-${group.ticketId}`}
                  gap="card-section"
                  p="card"
                  borderColor="border-soft"
                  rounded="md"
                  bg="transparent"
                  opacity={group.active ? 1 : 0.68}
                  borderStyle={group.active ? 'solid' : 'dashed'}
                >
                  <Row items="center" gap="side-item">
                    <Column minW={0} flex={1}>
                      <EntryTitle>{`#${group.ticketId}${group.title ? ` · ${group.title}` : ''}`}</EntryTitle>
                      <StateTag active={group.active}>{group.active ? m.activeRelation : m.historyOnly}</StateTag>
                    </Column>
                    <Button label={m.open} onPress={() => onOpenTicket?.(String(group.ticketId))} variant="outline" tone="neutral" size="sm" />
                  </Row>
                  <Column gap="stacked-card" pt="card-section" borderTopWidth={1} borderTopColor="border-soft">
                    {group.items.map((relation, index) => (
                      <Row
                        key={`${relation.ticketId}:${relation.kind}:${relation.sourceTicketId}:${relation.relationId ?? 'tree'}:${index}`}
                        items="center"
                        gap="side-item"
                        opacity={relation.active === false ? 0.58 : 1}
                      >
                        <Column minW={0} flex={1}>
                          <Row items="center" flexWrap="wrap" gap="inline-item">
                            <EntryTitle>{relation.active === false ? m.historical(relation.label) : relation.label}</EntryTitle>
                            <StateTag active={relation.active !== false}>{relation.stateLabel}</StateTag>
                          </Row>
                          <MetaText>{relation.meta}</MetaText>
                          {relation.detail ? <DetailText>{relation.detail}</DetailText> : null}
                        </Column>
                        {relation.relationId !== undefined && relation.relationId !== null
                          && relation.source === 'ticket_relations' && relation.active !== false ? (
                          <Button
                            label={m.revoke}
                            onPress={() => {
                              setRevokingRelationId(relation.relationId ?? null);
                              setRevokeReason('');
                            }}
                            testID={`ticket-relation-revoke-${relation.relationId}`}
                            variant="outline"
                            tone="danger"
                            size="sm"
                          />
                        ) : null}
                      </Row>
                    ))}
                  </Column>
                </Card>
              ))}
            </Column>
          ) : null}
          {revokingRelationId !== null ? (
            <Card testID="ticket-relation-revoke-panel" gap="card-row" p="card" borderColor="border-soft" rounded="md" bg="surface-subtle">
              <RiskText>{m.revokeNote(revokingRelationId)}</RiskText>
              <TextField
                testID="ticket-relation-revoke-reason"
                value={revokeReason}
                onChangeText={setRevokeReason}
                placeholder={m.revokeReason}
                multiline
                height={78}
                size="sm"
                fontSize="12"
              />
              {relationActionState?.error ? <ErrorText>{relationActionState.error}</ErrorText> : null}
              <Row justify="flex-end" gap="actions">
                <Button
                  label={messages.cancel}
                  onPress={() => {
                    setRevokingRelationId(null);
                    setRevokeReason('');
                  }}
                  variant="outline"
                  tone="neutral"
                  size="sm"
                />
                <Button
                  disabled={revokeDisabled}
                  label={relationActionState?.pending ? m.revoking : m.confirmRevoke}
                  onPress={submitRevoke}
                  testID="ticket-relation-revoke-submit"
                  tone="danger"
                  size="sm"
                />
              </Row>
            </Card>
          ) : null}
        </>
      ) : null}
    </Column>
  );
}

// 建立关系的编辑面板：关系类型、目标工单、原因。高影响的关系要确认两次。
function RelationCreatePanel({
  showEmptyNote,
  relationType,
  onRelationType,
  targetTicketText,
  onTargetTicketText,
  relationReason,
  onRelationReason,
  selfReference,
  confirmingHighImpact,
  actionState,
  submitDisabled,
  onSubmit,
  options,
  m,
}: {
  showEmptyNote: boolean;
  relationType: TicketRelationCreateType;
  onRelationType: (type: TicketRelationCreateType) => void;
  targetTicketText: string;
  onTargetTicketText: (value: string) => void;
  relationReason: string;
  onRelationReason: (value: string) => void;
  selfReference: boolean;
  confirmingHighImpact: boolean;
  actionState?: TicketRelationActionState;
  submitDisabled: boolean | undefined;
  onSubmit: () => void;
  options: RelationOption[];
  m: HistoryMessages;
}) {
  const selected = options.find((option) => option.type === relationType) ?? options[0]!;
  return (
    <Card testID="ticket-relation-create-panel" gap="card-row" p="card" borderColor="border-soft" rounded="md" bg="surface-subtle">
      {showEmptyNote ? <EmptyText>{m.noRelations}</EmptyText> : null}
      <Row flexWrap="wrap" gap="actions">
        {options.map((option) => (
          <Button
            key={option.type}
            label={option.label}
            onPress={() => onRelationType(option.type)}
            testID={`ticket-relation-type-${option.type}`}
            variant={relationType === option.type ? 'solid' : 'outline'}
            tone={option.highImpact ? 'danger' : relationType === option.type ? 'accent' : 'neutral'}
            size="sm"
          />
        ))}
      </Row>
      {selected.highImpact ? <RiskText>{selected.description}</RiskText> : <DetailText>{selected.description}</DetailText>}
      <TextField
        testID="ticket-relation-target"
        value={targetTicketText}
        onChangeText={onTargetTicketText}
        placeholder={m.targetId}
        size="sm"
        fontSize="12"
      />
      <TextField
        testID="ticket-relation-reason"
        value={relationReason}
        onChangeText={onRelationReason}
        placeholder={m.createReason}
        multiline
        height={78}
        size="sm"
        fontSize="12"
      />
      {selfReference ? <ErrorText>{m.selfReference}</ErrorText> : null}
      {confirmingHighImpact ? <RiskText>{m.highImpact}</RiskText> : null}
      {actionState?.error ? <ErrorText>{actionState.error}</ErrorText> : null}
      {actionState?.message ? <Text size="note" weight="medium" tone="success-dark">{actionState.message}</Text> : null}
      <Row justify="flex-end" gap="actions">
        <Button
          disabled={submitDisabled}
          label={actionState?.pending ? m.creating : selected.highImpact && !confirmingHighImpact ? m.checkHighImpact : m.confirmCreate}
          onPress={onSubmit}
          testID="ticket-relation-create-submit"
          size="sm"
        />
      </Row>
    </Card>
  );
}

function SectionTitle({ title }: { title: string }) {
  return <Text mt="page-section" size="section-title" weight="extrabold">{title}</Text>;
}

function EntryTitle({ children }: { children: string }) {
  return <Text size="card-title" weight="bold">{children}</Text>;
}

function MetaText({ children }: { children: string }) {
  return <Text size="meta" mono tone="muted">{children}</Text>;
}

function DetailText({ children }: { children: string }) {
  return <Text mt="text-stack" size="secondary" tone="secondary">{children}</Text>;
}

function EmptyText({ children }: { children: string }) {
  return <Text size="secondary" tone="muted">{children}</Text>;
}

function FailureText({ children }: { children: string }) {
  return <Text mt="card-row" px="inset-x" py="inset-y" size="code" mono tone="danger-dark" bg="danger-soft">{children}</Text>;
}

function RiskText({ children }: { children: string }) {
  return <Text size="note" weight="medium" tone="danger-dark">{children}</Text>;
}

function ErrorText({ children }: { children: string }) {
  return <Text size="note" weight="bold" tone="danger-dark">{children}</Text>;
}

function StateTag({ active, children }: { active: boolean; children: string }) {
  return <Text size="label" weight="bold" tone={active ? 'success' : 'muted'}>{children}</Text>;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function groupRelationsByTicket(relations: RelationPresentation[]): {
  ticketId: number;
  title: string | null;
  active: boolean;
  items: RelationPresentation[];
}[] {
  const groups: {
    ticketId: number;
    title: string | null;
    active: boolean;
    items: RelationPresentation[];
  }[] = [];
  for (const relation of relations) {
    let group = groups.find((item) => item.ticketId === relation.ticketId);
    if (!group) {
      group = {
        ticketId: relation.ticketId,
        title: relation.title,
        active: relation.active !== false,
        items: [],
      };
      groups.push(group);
    }
    group.items.push(relation);
    group.active ||= relation.active !== false;
  }
  return groups.sort((left, right) => Number(right.active) - Number(left.active) || left.ticketId - right.ticketId);
}
