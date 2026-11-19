// 引用托盘和手机上的「正在引用」（设计规范 P17.4–P17.6、主题 Q-4、Q-5）。
//   · QuoteTray：输入框卡片的上半截，收起来的引用一条一行：回复图标、原文、说明、×。没有标题行和编号（P17.6）。
//     最多露 3 条，其余写「还有 N 条」。悬停（桌面）时这一行和原文的标记一起加深；点这一行回到编辑（P17.4）并跳回原文。
//   · QuotingSlot（手机）：正在写说明的那一段。点它在输入框里原地展开成整段，拖两端改范围（只读的 TextInput，
//     组件库的 RangeSelectText，不要原生模块）。
import { useState } from 'react';

import { Box, Column, Icon, IconButton, Pressable, RangeSelectText, Row, Text } from '@pi-lead-child/components';

import { useMessages } from '@/i18n';

import { quoteMessages } from './quote.messages';
import { quoteDrafts, useQuoteDrafts } from './quoteDrafts';
import { useQuoteJump } from './quoteNavigation';

const VISIBLE_ROWS = 3;

export function QuoteTray({ compact = false }: { compact?: boolean }) {
  const m = useMessages(quoteMessages);
  const drafts = useQuoteDrafts((state) => state.drafts);
  const activeId = useQuoteDrafts((state) => state.activeId);
  const editingId = useQuoteDrafts((state) => state.pending?.editingId ?? null);
  const jump = useQuoteJump();
  const [showAll, setShowAll] = useState(false);
  // 正在改的那一条在「正在引用」里（手机），托盘里不重复列它。
  const rows = compact && editingId ? drafts.filter((draft) => draft.id !== editingId) : drafts;
  if (!rows.length) return null;
  const visible = showAll ? rows : rows.slice(0, VISIBLE_ROWS);
  const hidden = rows.length - visible.length;
  return (
    <Column
      testID="quote-tray"
      bg="surface-subtle"
      py="pill-y"
      // 桌面：输入框卡片的上半截，卡片把它裁进圆角，下面一条分隔线（Q-4）。
      // 手机：托盘在悬浮输入框的内边距里面，自己带圆角 20（输入框 28 减去内边距 8，同心），没有分隔线（2026-11-19 用户：直角太尖）；
      // 左右只留 6，回复图标离托盘左边 12、× 贴着右边，和视觉稿一样（以前托盘 12 加一行 6，两头都宽了）。
      {...(compact
        ? { rounded: '5xl' as const, pl: 'pill-x' as const, pr: 'pill-x' as const }
        : { borderBottomWidth: 1, borderColor: 'border-soft' as const, pl: 'inset-x' as const, pr: 'inset-x' as const })}
    >
      {visible.map((draft) => {
        const active = draft.id === activeId || draft.id === editingId;
        return (
          <Row
            key={draft.id}
            testID={`quote-tray-row-${draft.id}`}
            items="center"
            gap="icon-label"
            rounded="md"
            pl="pill-x"
            {...(compact ? {} : { pr: 'pill-x' as const })}
            bg={active ? 'accent-soft' : undefined}
            // 悬停（桌面）：这一行和原文的标记一起加深。手机上没有悬停，这两个不会被调用。
            {...{ onHoverIn: () => quoteDrafts.getState().setActive(draft.id), onHoverOut: () => quoteDrafts.getState().setActive(null) }}
          >
            <Pressable
              flex={1}
              minW={0}
              accessibilityRole="button"
              accessibilityLabel={m.editQuote(draft.text)}
              onPress={() => {
                quoteDrafts.getState().edit(draft.id);
                jump?.({ kind: 'quote', id: draft.id, source: draft.source, text: draft.text, ...(draft.anchor ? { anchor: draft.anchor } : {}) });
              }}
            >
              <Row items="center" gap="icon-label" minH={compact ? 30 : 26}>
                <Icon name="reply" size={14} color={active ? 'accent-strong' : 'text-secondary'} />
                <Text size="secondary" tone={active ? 'accent' : 'secondary'} numberOfLines={1} maxW={compact ? 120 : 132} shrink={0}>
                  {draft.text}
                </Text>
                {draft.note ? <Text size="secondary" tone="strong" numberOfLines={1} flex={1} minW={0}>{draft.note}</Text> : null}
              </Row>
            </Pressable>
            <IconButton
              testID={`quote-tray-remove-${draft.id}`}
              icon="close"
              label={m.removeQuote(draft.text)}
              variant="ghost"
              tone="neutral"
              size="xs"
              iconSize={14}
              iconColor="text-secondary"
              onPress={() => quoteDrafts.getState().remove(draft.id)}
            />
          </Row>
        );
      })}
      {hidden > 0 ? (
        <Pressable accessibilityRole="button" onPress={() => setShowAll(true)}>
          <Text size="meta" tone="secondary" px="pill-x">{m.more(hidden)}</Text>
        </Pressable>
      ) : null}
    </Column>
  );
}

// 手机：正在引用的一段（Q-5）。收起时是两行：「正在引用 · 点开改范围」和原文；展开时是整段，用系统选区改范围。
export function QuotingSlot({ onFocusInput }: { onFocusInput: () => void }) {
  const m = useMessages(quoteMessages);
  const pending = useQuoteDrafts((state) => state.pending);
  const [expanded, setExpanded] = useState(false);
  if (!pending) return null;
  const context = pending.context ?? pending.text;
  const start = Math.max(0, context.indexOf(pending.text));
  const label = expanded ? m.quotingExpanded : pending.editingId ? m.editing : m.quoting;
  return (
    <Row testID="quoting-slot" items="flex-start" gap="icon-label" px="inline-item" pt="inline-item">
      <Column flex={1} minW={0} gap="text-stack">
        <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => { setExpanded(!expanded); if (expanded) onFocusInput(); }}>
          <Row items="center" gap="icon-label">
            <Icon name="reply" size={14} color="accent-strong" />
            <Text size="label" weight="semibold" tone="accent">{label}</Text>
          </Row>
        </Pressable>
        {expanded ? (
          <Box bg="surface-subtle" rounded="lg" px="inset-x" py="inset-y">
            <RangeSelectText
              testID="quoting-range"
              text={context}
              start={start}
              end={start + pending.text.length}
              onSelect={(from, to) => quoteDrafts.getState().setPendingText(context.slice(from, to))}
            />
          </Box>
        ) : (
          <Text size="secondary" tone="strong" numberOfLines={2}>{pending.text}</Text>
        )}
      </Column>
      {pending.editingId ? null : (
        <IconButton testID="quoting-cancel" icon="close" label={m.cancelQuote} variant="ghost" tone="neutral" size="xs" iconSize={14}
          iconColor="text-secondary" onPress={() => quoteDrafts.getState().cancel()} />
      )}
    </Row>
  );
}
