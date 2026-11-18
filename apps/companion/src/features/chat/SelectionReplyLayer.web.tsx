// web（桌面）：选字回复（设计规范 P17、主题 Q-1–Q-3）。挂在 Lead 的会话上，画在页面最上层（portal 到 body），
// 不占会话列表的位置，列表不变高（P1、P17.3）。
//   · 选中可以引用的一段字（QuoteSource 里、确实在原文里），松开 170ms 后选区上方出「回复」（Q-1），快捷键 R。
//   · 点「回复」：同一个位置撑开引用浮层（Q-2），选区保持高亮。Enter 加上（进托盘），⌘Enter 或发送钮直接发送，Esc 取消。
//   · 托盘里的引用在原文上留标记（Q-3，CSS Custom Highlight API，不改 DOM）：悬停时标记和托盘那一行一起加深，
//     点标记回到同一个浮层改这一条（P17.4），按钮换成「保存」和「删掉」。
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import { Button, Column, Icon, IconButton, Row, Text, TextField, elevation, palette, radius } from '@pi-lead-child/components';

import { useMessages } from '@/i18n';

import { quoteMessages } from './quote.messages';
import { quoteDrafts, useQuoteDrafts, type PendingQuote } from './quoteDrafts';
import { anchorOfOccurrence, findQuoteRange, occurrenceOfAnchor, occurrenceOfRange } from './quoteRanges';
import { canQuote, quoteSourceKey, quoteSourceOf } from './quoteSources';

// 浮层和按钮的位置（视口坐标），跟着选区或标记算，列表滚动时重算（P2.6）。
interface Spot {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface Picked {
  key: string;
  text: string;
  anchor: string;
  spot: Spot;
  range: Range;
}

// 正在写说明的新的一段在原文上的位置：浮层里的输入框拿到焦点以后，浏览器的选区就没了，
// 这一段改用加深的标记画出来（Q-2「选区保持高亮」）。
let pendingRange: Range | null = null;

const QUOTE_TEXT_LIMIT = 4000;
const REPLY_DELAY_MS = 170;
const PANEL_WIDTH = 340;
const GAP_FROM_TEXT = 12;
const PILL_HEIGHT = 32;
const VIEWPORT_MARGIN = 12;

const spotOf = (rect: DOMRect): Spot => ({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right });

function containerOf(node: Node | null): Element | null {
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  return element?.closest('[data-quote-key]') ?? null;
}

function containerFor(key: string): Element | null {
  return document.querySelector(`[data-quote-key="${CSS.escape(key)}"]`);
}

// 读当前的选区：在同一个来源里、字在原文里，才算能引用。
function readSelection(): Picked | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const container = containerOf(range.startContainer);
  if (!container || container !== containerOf(range.endContainer)) return null;
  const key = container.getAttribute('data-quote-key') ?? '';
  const text = selection.toString().trim().slice(0, QUOTE_TEXT_LIMIT);
  if (!text || !canQuote(key, text)) return null;
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  return { key, text, anchor: anchorOfOccurrence(occurrenceOfRange(container, range, text)), spot: spotOf(rect), range: range.cloneRange() };
}

// ── 原文上的标记（Q-3）──────────────────────────────────────────────────────────────────────────
const HIGHLIGHT_PENDING = 'quote-pending';
const HIGHLIGHT_ACTIVE = 'quote-active';
const HIGHLIGHT_STYLE_ID = 'quote-highlight-style';

type HighlightRegistry = { set(name: string, value: unknown): void; delete(name: string): void };
type HighlightConstructor = new (...ranges: Range[]) => unknown;

function highlightApi(): { registry: HighlightRegistry; Highlight: HighlightConstructor } | null {
  const registry = (globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights;
  const Highlight = (globalThis as unknown as { Highlight?: HighlightConstructor }).Highlight;
  return registry && Highlight ? { registry, Highlight } : null;
}

function ensureHighlightStyle() {
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = [
    `::highlight(${HIGHLIGHT_PENDING}) { background-color: ${palette['accent-wash']}; text-decoration: underline dashed ${palette.accent} 1.5px; text-underline-offset: 3px; }`,
    `::highlight(${HIGHLIGHT_ACTIVE}) { background-color: ${palette['accent-soft']}; text-decoration: underline solid ${palette.accent} 1.5px; text-underline-offset: 3px; }`,
  ].join('\n');
  document.head.appendChild(style);
}

// 每条引用现在在页面上的位置。会话重画、虚拟列表卸掉又画回来以后重新找。
function rangesOfDrafts(drafts: readonly { id: string; source: PendingQuote['source']; text: string; anchor?: string }[]) {
  const ranges = new Map<string, Range>();
  for (const draft of drafts) {
    const container = containerFor(quoteSourceKey(draft.source));
    const range = container ? findQuoteRange(container, draft.text, occurrenceOfAnchor(draft.anchor)) : null;
    if (range) ranges.set(draft.id, range);
  }
  return ranges;
}

export function SelectionReplyLayer({ enabled, onSendNow }: { enabled: boolean; onSendNow: () => void }) {
  const m = useMessages(quoteMessages);
  const drafts = useQuoteDrafts((state) => state.drafts);
  const pending = useQuoteDrafts((state) => state.pending);
  const activeId = useQuoteDrafts((state) => state.activeId);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [panelSpot, setPanelSpot] = useState<Spot | null>(null);
  const [hoverSpot, setHoverSpot] = useState<Spot | null>(null);
  const ranges = useRef(new Map<string, Range>());
  const [, setTick] = useState(0);

  // 松开鼠标、改选区：等 170ms 再看选区（Q-1），拖着选的时候不闪。
  useEffect(() => {
    if (!enabled) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setPicked(quoteDrafts.getState().pending ? null : readSelection()), REPLY_DELAY_MS);
    };
    document.addEventListener('mouseup', check);
    document.addEventListener('keyup', check);
    document.addEventListener('selectionchange', check);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('mouseup', check);
      document.removeEventListener('keyup', check);
      document.removeEventListener('selectionchange', check);
    };
  }, [enabled]);

  const open = useCallback((choice: Picked) => {
    const source = quoteSourceOf(choice.key);
    if (!source) return;
    pendingRange = choice.range;
    quoteDrafts.getState().begin({ source, text: choice.text, anchor: choice.anchor });
    setPanelSpot(choice.spot);
    setPicked(null);
  }, []);

  // 快捷键 R：选区上有「回复」时打开浮层。输入框里打字时不算。
  useEffect(() => {
    if (!picked) return undefined;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA)$/u.test(target.tagName))) return;
      if (event.key.toLowerCase() !== 'r' || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      open(picked);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, picked]);

  // 原文上的标记：托盘里的、手上正在写的（新的一段保持选区的样子，所以不算）。悬停或正在改的一条用加深的样子。
  useEffect(() => {
    const api = highlightApi();
    if (!enabled || !api) return undefined;
    ensureHighlightStyle();
    let frame = 0;
    const paint = () => {
      frame = 0;
      const state = quoteDrafts.getState();
      ranges.current = rangesOfDrafts(state.drafts);
      const focusId = state.pending?.editingId ?? state.activeId;
      const pendingRanges = [...ranges.current].filter(([id]) => id !== focusId).map(([, range]) => range);
      if (!state.pending || state.pending.editingId) pendingRange = null;
      const activeRange = focusId ? ranges.current.get(focusId) : pendingRange ?? undefined;
      api.registry.set(HIGHLIGHT_PENDING, new api.Highlight(...pendingRanges));
      api.registry.set(HIGHLIGHT_ACTIVE, new api.Highlight(...(activeRange ? [activeRange] : [])));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
    paint();
    const unsubscribe = quoteDrafts.subscribe(schedule);
    // 会话重画（流式输出、虚拟列表卸掉又画回来）：DOM 变了，原来的 Range 失效，重新找。
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      unsubscribe();
      observer.disconnect();
      api.registry.delete(HIGHLIGHT_PENDING);
      api.registry.delete(HIGHLIGHT_ACTIVE);
    };
  }, [enabled]);

  // 鼠标在标记上：加深它和托盘里那一行（setActive），上面出提示；点它回到浮层改这一条（P17.4）。
  useEffect(() => {
    if (!enabled) return undefined;
    const hit = (event: MouseEvent): [string, Range] | null => {
      if (!containerOf(event.target as Node | null)) return null;
      const position = document.caretRangeFromPoint?.(event.clientX, event.clientY);
      if (!position) return null;
      for (const [id, range] of ranges.current) {
        try {
          if (range.isPointInRange(position.startContainer, position.startOffset)) return [id, range];
        } catch {
          // 节点已经不在页面上：下一次重画会重新找。
        }
      }
      return null;
    };
    const onMove = (event: MouseEvent) => {
      if (quoteDrafts.getState().pending) return;
      const found = hit(event);
      quoteDrafts.getState().setActive(found?.[0] ?? null);
      setHoverSpot(found ? spotOf(found[1].getBoundingClientRect()) : null);
    };
    const onClick = (event: MouseEvent) => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const found = hit(event);
      if (!found) return;
      quoteDrafts.getState().edit(found[0]);
      setPanelSpot(spotOf(found[1].getBoundingClientRect()));
      setHoverSpot(null);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('click', onClick);
    };
  }, [enabled]);

  // 托盘里点了一行（编辑这一条）：浮层开在原文的标记下面。
  useEffect(() => {
    if (!pending || panelSpot) return;
    if (pending.editingId) {
      const range = ranges.current.get(pending.editingId);
      if (range) setPanelSpot(spotOf(range.getBoundingClientRect()));
    }
  }, [panelSpot, pending]);

  // 列表滚动、窗口变大小：按钮和浮层跟着原文走（P2.6）。
  useEffect(() => {
    if (!picked && !panelSpot) return undefined;
    const follow = () => {
      if (picked) setPicked(readSelection());
      const editing = quoteDrafts.getState().pending;
      if (panelSpot && editing) {
        const range = editing.editingId ? ranges.current.get(editing.editingId) : pendingRange;
        if (range) setPanelSpot(spotOf(range.getBoundingClientRect()));
      }
      setTick((tick) => tick + 1);
    };
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    return () => {
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
    };
  }, [panelSpot, picked]);

  const close = useCallback(() => {
    setPanelSpot(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  if (!enabled || typeof document === 'undefined') return null;
  const panelOpen = Boolean(pending && panelSpot);
  return createPortal(
    <>
      {picked && !panelOpen ? <ReplyPill spot={picked.spot} label={m.reply} onPress={() => open(picked)} /> : null}
      {hoverSpot && !panelOpen && activeId ? <HoverHint spot={hoverSpot} label={m.editHint} /> : null}
      {panelOpen && pending && panelSpot ? (
        <QuotePanel
          spot={panelSpot}
          pending={pending}
          onCommit={() => { quoteDrafts.getState().commit(); close(); }}
          onSendNow={() => { onSendNow(); close(); }}
          onCancel={() => { quoteDrafts.getState().cancel(); close(); }}
          onRemove={() => { if (pending.editingId) quoteDrafts.getState().remove(pending.editingId); close(); }}
        />
      ) : null}
    </>,
    document.body,
  );
}

function clampLeft(center: number, width: number): number {
  return Math.max(VIEWPORT_MARGIN, Math.min(center - width / 2, window.innerWidth - width - VIEWPORT_MARGIN));
}

// Q-1：选区上方正中，放不下时放在下方。
function ReplyPill({ spot, label, onPress }: { spot: Spot; label: string; onPress: () => void }) {
  const above = spot.top - GAP_FROM_TEXT - PILL_HEIGHT;
  const top = above >= VIEWPORT_MARGIN ? above : spot.bottom + GAP_FROM_TEXT;
  const center = (spot.left + spot.right) / 2;
  return (
    <div style={{ position: 'fixed', top, left: center, transform: 'translateX(-50%)', zIndex: 1000 }} onMouseDown={(event) => event.preventDefault()}>
      <Button testID="quote-reply-button" label={label} icon="reply" size="sm" variant="outline" tone="neutral" onPress={onPress} />
    </div>
  );
}

function HoverHint({ spot, label }: { spot: Spot; label: string }) {
  const center = (spot.left + spot.right) / 2;
  return (
    <div style={{ position: 'fixed', top: spot.top - GAP_FROM_TEXT - PILL_HEIGHT / 2, left: center, transform: 'translateX(-50%)', zIndex: 1000, pointerEvents: 'none' }}>
      <Row bg="text" rounded="sm" px="pill-x" py="pill-y"><Text size="meta" tone="inverse">{label}</Text></Row>
    </div>
  );
}

// Q-2：引用浮层。新的一段：Enter 加上，⌘Enter 或发送钮直接发送；改托盘里的一条：Enter 保存，「删掉」去掉这一条。
function QuotePanel({ spot, pending, onCommit, onSendNow, onCancel, onRemove }: {
  spot: Spot;
  pending: PendingQuote;
  onCommit: () => void;
  onSendNow: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  const m = useMessages(quoteMessages);
  const editing = pending.editingId !== null;
  const top = spot.bottom + GAP_FROM_TEXT;
  const left = clampLeft(spot.left + PANEL_WIDTH / 2, PANEL_WIDTH);
  const panel = useRef<HTMLDivElement | null>(null);

  // 点浮层外面：写了说明的收进托盘（不丢字），没写的取消（P2.4）。
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (panel.current?.contains(event.target as Node)) return;
      if (quoteDrafts.getState().pending?.note.trim() && !editing) onCommit();
      else onCancel();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [editing, onCancel, onCommit]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !editing) {
      event.preventDefault();
      onSendNow();
    } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onCommit();
    }
  };

  return (
    <div
      ref={panel}
      role="dialog"
      aria-label={editing ? m.editPanelLabel : m.panelLabel}
      data-testid="quote-panel"
      onKeyDownCapture={onKeyDown}
      // 浮起的一档阴影（E-2，主题 Q-2）。
      style={{ position: 'fixed', top, left, width: PANEL_WIDTH, zIndex: 1000, boxShadow: elevation.raised, borderRadius: radius.xl }}
    >
      <Column bg="surface" rounded="xl" p="card" gap="card-row">
        <Row gap="icon-label" items="flex-start">
          <Icon name="reply" size={14} color="text-secondary" />
          <Text size="secondary" tone="secondary" numberOfLines={2} flex={1} minW={0}>{pending.text}</Text>
        </Row>
        <TextField
          testID="quote-note"
          accessibilityLabel={m.noteLabel}
          value={pending.note}
          onChangeText={(note) => quoteDrafts.getState().setPendingNote(note)}
          placeholder={m.notePlaceholder}
          multiline
          autoFocus
          fontSize="message-body"
        />
        <Row items="center" gap="actions">
          <Text size="meta" tone="secondary" flex={1} minW={0} numberOfLines={1}>{editing ? m.editHintKeys : m.hintKeys}</Text>
          {editing ? (
            <Button testID="quote-remove" label={m.remove} variant="ghost" tone="neutral" size="sm" onPress={onRemove} />
          ) : (
            <IconButton testID="quote-send-now" icon="arrow-up" label={m.sendNow} variant="soft" tone="neutral" size="sm" onPress={onSendNow} />
          )}
          <Button testID="quote-commit" label={editing ? m.save : m.add} tone="accent" size="sm" onPress={onCommit} />
        </Row>
      </Column>
    </div>
  );
}
