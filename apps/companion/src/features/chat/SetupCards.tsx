import { Box, Button, Card, Column, Icon, Popover, Pressable, ProgressBar, RecordRow, Row, Text } from '@pi-lead-child/components';
import {
  SETUP_HREFS, setupItemMeta, type SetupChecklistCard, type SetupHintCard, type SetupItem, type SetupItemKey,
} from '@pi-lead-child/protocol';
import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';

import { useLocale, useMessages, type Locale } from '@/i18n';

import { useCompanionRuntime, useControlPlaneStore } from '../../state/CompanionStateProvider';
import { useLeadName } from '../../state/hooks';
import { setupMessages } from './setup.messages';

// 首次启动引导的两种系统卡（2026-10-30，.scratch/onboarding/spec.md，画布 A2、A4）：
//   · 准备清单卡：Lead 第一次上线时一张，列 7 项关键设置。配好一项，原地勾掉一项；全部配好以后收成一行。
//   · 建议卡：之后用户自己的一轮结束时，一次建议一项。「去设置」直接跳到那一页；「以后再说」「不用再提」在「⋯」里（P3.3）。
// 两种卡都是系统画的（P8.1），内容和状态由 daemon 算好，这里不自己推断。文字里的 {lead} 换成用户给 Lead 起的名字。

const withLead = (text: string, leadName: string) => text.replaceAll('{lead}', leadName);

/** 卡上的跳转只认设置页的这几条路由（SETUP_HREFS）。 */
export function setupHref(key: SetupItemKey): Href | null {
  // 路由和语言无关。
  const href = setupItemMeta(key, 'en').href;
  return SETUP_HREFS.includes(href) ? (href as Href) : null;
}

/** 建议卡的标题：「建议连上 Jira」「建议给记忆接上 embedding」。 */
export function setupHintTitle(key: SetupItemKey, locale: Locale): string {
  const m = setupMessages(locale).hint;
  if (key === 'github' || key === 'jira' || key === 'notion') return m.connect(setupItemMeta(key, locale).title);
  if (key === 'memory') return m.memory;
  if (key === 'slack') return m.slack;
  if (key === 'profile') return m.profile;
  return m.brain;
}

/** 建议卡处理过以后的一行。 */
export function setupHintClosedLine(card: SetupHintCard, locale: Locale): string {
  const m = setupMessages(locale);
  const title = setupItemMeta(card.item, locale).title;
  if (card.state === 'ready') return m.ready(title);
  if (card.state === 'snoozed') return m.snoozed(title);
  return m.dismissed(title);
}

// 状态图标（主题 I-5）：同色系的浅底圆加深色符号。没配的画一个虚线空圈。
function SetupStatusMark({ ready }: { ready: boolean }) {
  const m = useMessages(setupMessages);
  return ready ? (
    <Box w={16} h={16} rounded="full" bg="success-soft" items="center" justify="center" shrink={0} aria-label={m.readyMark}>
      <Icon name="check" size={10} color="success-dark" />
    </Box>
  ) : (
    <Box w={16} h={16} rounded="full" borderWidth={1.5} borderStyle="dashed" borderColor="text-faint" shrink={0} aria-label={m.notReadyMark} />
  );
}

function SetupRow({ item, leadName, onOpen }: { item: SetupItem; leadName: string; onOpen: (key: SetupItemKey) => void }) {
  const locale = useLocale();
  const meta = setupItemMeta(item.key, locale);
  const m = setupMessages(locale);
  return (
    <Row testID={`setup-row-${item.key}`} items="center" gap="side-item" py="row-y" borderTopWidth={1} borderTopColor="border-soft">
      <SetupStatusMark ready={item.ready} />
      {/* spacing-exempt: 项名一列对齐的宽度 */}
      <Text w={112} shrink={0} size="label" weight="semibold" tone={item.ready ? 'secondary' : 'default'} numberOfLines={1}>{meta.title}</Text>
      <Text flex={1} minW={0} size="secondary" tone={item.ready ? 'muted' : 'secondary'} numberOfLines={1}>
        {item.ready ? item.detail ?? m.readyMark : withLead(meta.why, leadName)}
      </Text>
      {item.ready ? null : (
        <Pressable testID={`setup-open-${item.key}`} aria-label={m.open(meta.cta, meta.title)} onPress={() => onOpen(item.key)}>
          <Text size="label" weight="semibold" color="accent-strong">{`${meta.cta} ›`}</Text>
        </Pressable>
      )}
    </Row>
  );
}

export function SetupChecklistCardView({
  card,
  leadName,
  onOpen,
}: {
  card: SetupChecklistCard;
  leadName: string;
  onOpen: (key: SetupItemKey) => void;
}) {
  const m = useMessages(setupMessages);
  const done = card.items.filter((item) => item.ready).length;
  if (done === card.items.length) {
    // 全部配好：收成结束行（P9.4）。
    return (
      <Row testID="setup-checklist" w="100%" items="center" gap="icon-label">
        <SetupStatusMark ready />
        <Text testID="setup-checklist-done" size="secondary" tone="secondary">{m.allReady(card.items.length)}</Text>
      </Row>
    );
  }
  return (
    <Card testID="setup-checklist" w="100%" variant="float" px="card" py="card" gap="card-row">
      <Row items="center" gap="inline-item">
        <Text flex={1} size="card-title" weight="semibold">{m.checklistTitle}</Text>
        <Text testID="setup-checklist-count" size="meta" weight="semibold" tone="secondary" font="mono">{`${done}/${card.items.length}`}</Text>
      </Row>
      <Row w="100%"><ProgressBar value={(done / card.items.length) * 100} color="success" track="border-soft" /></Row>
      <Column>
        {card.items.map((item) => <SetupRow key={item.key} item={item} leadName={leadName} onOpen={onOpen} />)}
      </Column>
      <Text size="meta" tone="secondary">{m.checklistOnce(leadName)}</Text>
    </Card>
  );
}

export function SetupHintCardView({
  card,
  leadName,
  pending = null,
  error = null,
  onOpen,
  onAction,
}: {
  card: SetupHintCard;
  leadName: string;
  // 正在做的操作（「以后再说」「不用再提」），做完、新的卡推来之前显示。
  pending?: string | null;
  error?: string | null;
  onOpen: (key: SetupItemKey) => void;
  onAction: (action: SetupHintCard['actions'][number]) => void;
}) {
  const locale = useLocale();
  const meta = setupItemMeta(card.item, locale);
  const m = setupMessages(locale);
  if (card.state !== 'open') {
    return (
      <Row testID={`setup-hint-${card.hintId}`} w="100%" items="center" gap="icon-label">
        {card.state === 'ready' ? <SetupStatusMark ready /> : <Icon name="check" size={13} color="text-muted" />}
        <Text testID="setup-hint-line" flex={1} minW={0} size="secondary" tone="secondary" numberOfLines={1}>{setupHintClosedLine(card, locale)}</Text>
      </Row>
    );
  }
  return (
    <Card testID={`setup-hint-${card.hintId}`} w="100%" variant="float" px="card" py="card" gap="card-row">
      <Row items="center" gap="side-item">
        <Icon name="sparkle" size={16} color="text-secondary" />
        <Column flex={1} minW={0} gap="text-stack">
          <Text testID="setup-hint-title" size="card-title" weight="semibold" numberOfLines={1}>{setupHintTitle(card.item, locale)}</Text>
          <Text size="secondary" tone="secondary" numberOfLines={2}>{withLead(meta.why, leadName)}</Text>
        </Column>
        <Button testID={`setup-hint-${card.hintId}-open`} label={meta.cta} size="xs" variant="outline" tone="neutral" onPress={() => onOpen(card.item)} />
        {card.actions.length ? (
          <Popover
            testID={`setup-hint-${card.hintId}-more`}
            label={m.moreLabel(meta.title)}
            title={meta.title}
            width={240}
            trigger={<Icon name="more" size={16} color="text-secondary" />}
          >
            {(close) => (
              <Column>
                {card.actions.map((action, index) => (
                  <RecordRow
                    key={action.action}
                    divider={index > 0}
                    testID={`setup-hint-${card.hintId}-${action.action}`}
                    title={action.label}
                    detail={action.action === 'snooze' ? m.snoozeDetail : m.dismissDetail}
                    onPress={pending === null ? () => { close(); onAction(action); } : undefined}
                  />
                ))}
              </Column>
            )}
          </Popover>
        ) : null}
      </Row>
      {pending ? <Text size="note" tone="secondary">{pending}</Text> : null}
      {error ? <Text size="note" color="danger-dark">{m.failed(error)}</Text> : null}
    </Card>
  );
}

function useOpenSetting() {
  const router = useRouter();
  return (key: SetupItemKey) => {
    const href = setupHref(key);
    if (href) router.push(href);
  };
}

// 会话时间线里的准备清单卡：从 store 取，推送来了原地更新。
export function SetupChecklistCardItem() {
  const card = useControlPlaneStore((state) => state.leadActivity.setup ?? null);
  const leadName = useLeadName();
  const open = useOpenSetting();
  return card ? <SetupChecklistCardView card={card} leadName={leadName} onOpen={open} /> : null;
}

// 会话时间线里的一张建议卡。「以后再说」「不用再提」走操作层（和 Lead 的 perform_action 同一个函数），
// 卡的新状态靠网关推的 lead-activity 快照，这里只在等待时写一句「正在……」。
export function SetupHintCardItem({ cardKey }: { cardKey: string }) {
  const card = useControlPlaneStore((state) => state.leadActivity.setupHints?.[cardKey]);
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const open = useOpenSetting();
  const m = useMessages(setupMessages);
  const [state, setState] = useState<{ pending: string | null; error: string | null }>({ pending: null, error: null });
  if (!card) return null;
  const onAction = (action: SetupHintCard['actions'][number]) => {
    setState({ pending: m.pending(action.label), error: null });
    runtime.leadActivityCardAction(action).then(
      () => setState({ pending: null, error: null }),
      (error: unknown) => setState({ pending: null, error: error instanceof Error ? error.message : String(error) }),
    );
  };
  return <SetupHintCardView card={card} leadName={leadName} pending={state.pending} error={state.error} onOpen={open} onAction={onAction} />;
}
