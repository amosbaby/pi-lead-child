import {
  Box, Button, Column, DetailHeader, Density, Icon, Popover, Pressable, RecordRow, Row, ScrollArea, SegmentedControl, Text,
} from '@pi-lead-child/components';
import { viewLabel, WIDGET_SURFACE_RULES, widgetViews, type WidgetDto } from '@pi-lead-child/protocol';
import { useState } from 'react';

import { SurfaceView } from '@/features/genui/SurfaceView';
import { useLocale, useMessages } from '@/i18n';
import { useCompanionRuntime, useWorkspaceStore } from '@/state/CompanionStateProvider';
import { useLeadName, useWidgets } from '@/state/hooks';
import { DAEMON_OLDER_THAN_WEB, type ResourceState } from '@/state/types';

import { useFoldedWidgets } from './useFoldedWidgets';
import { viewsMessages } from './views.messages';
import { currentView, movedOrder, widgetErrorText, widgetMetaLine, widgetsEmptyNote, widgetSourceProblem } from './widgetsModel';

// 右侧的「自定义视图」面板（2026-10-30，用户 2026-10-30 定名，.scratch/custom-views/spec.md D2，patterns P16）：用户让 Lead 做的常驻控件，从上到下。
// 每个控件是一块 genui 的 surface，用会话里同一个 SurfaceView 画。建和改由 Lead 做（用户在会话里说）；
// 面板上能做的是低频操作，收在每个控件标题右边的「⋯」里：立即刷新（有数据源时）、上移、下移、移到别的视图、删掉。
// 有数据源的控件由 daemon 定时跑脚本更新（第二期），标题下面写多久更新一次；出错和暂停时写原因，内容是上一次成功的。
// 删了不能恢复，所以删掉在菜单里就地确认一次（P5.3），不弹窗。
// 点控件的标题行能把它折叠成只剩标题行（工单 #54，用户 2026-11-05），哪些折叠了记在这台设备上，刷新后不变。
// 视图是控件的一个属性（用户 2026-10-30）：只有一个视图时不显示 tab；用户让 Lead 按类别分了以后才有 tab。
// 控件用会话区域的密度：它们和会话里的 genui 卡片是同一种东西。
export function ViewsPanel({ onClose, standalone = false }: { onClose: () => void; standalone?: boolean }) {
  const { widgets, resource } = useWidgets();
  const leadName = useLeadName();
  const locale = useLocale();
  const m = useMessages(viewsMessages);
  const selectedView = useWorkspaceStore((state) => state.selectedView);
  const selectView = useWorkspaceStore((state) => state.selectView);
  const views = widgets ? widgetViews(widgets) : [];
  const view = currentView(views, selectedView);
  const shown = widgets?.filter((widget) => widget.view === view) ?? [];
  return (
    <Column testID="views-panel" flex={1} minH={0} bg="surface">
      <DetailHeader
        testID="views-panel-header"
        title={m.title}
        onClose={standalone ? undefined : onClose}
        closeLabel={m.close}
        onBack={standalone ? onClose : undefined}
        dense={standalone}
      />
      {/* tab 在头部下面，不跟着控件滚走。只有一个视图时不画。 */}
      {views.length > 1 ? (
        <Density zone="conversation">
          <Box testID="views-tabs" px="page-x" pt="card-section">
            <SegmentedControl
              options={views.map((value) => ({ value, label: viewLabel(value, locale) }))}
              value={view}
              onChange={selectView}
              optionTestID={(value) => `views-tab-${value}`}
            />
          </Box>
        </Density>
      ) : null}
      <ScrollArea testID="views-panel-scroll" fillContent>
        <Density zone="conversation">
          <Column px="page-x" pt="page-top" pb="page-bottom" gap="conversation-block">
            {widgets === null ? (
              <WidgetsNotLoaded state={resource?.state ?? 'idle'} error={resource?.error ?? null} />
            ) : widgets.length === 0 ? (
              <Column testID="views-empty" gap="text-stack">
                <Text size="card-title" weight="semibold">{m.empty}</Text>
                <Text size="body" tone="secondary">{widgetsEmptyNote(leadName, locale)}</Text>
              </Column>
            ) : (
              shown.map((widget) => (
                <WidgetBlock key={widget.id} widget={widget} widgets={widgets} views={views} leadName={leadName} />
              ))
            )}
          </Column>
        </Density>
      </ScrollArea>
    </Column>
  );
}

// 还没取到控件：在取、取不到，或者 daemon 比网页旧（还没有 GET /v1/widgets）。
function WidgetsNotLoaded({ state, error }: { state: ResourceState; error: string | null }) {
  const m = useMessages(viewsMessages);
  if (state === 'unsupported' && error === DAEMON_OLDER_THAN_WEB) {
    return <Text testID="views-daemon-older" size="note" tone="muted">{m.daemonOlder}</Text>;
  }
  if (state === 'error') return <Text testID="views-error" size="note" tone="danger-dark">{m.loadFailed(error ?? m.tryLater)}</Text>;
  return <Text testID="views-loading" size="note" tone="muted">{m.loading}</Text>;
}

function WidgetBlock({ widget, widgets, views, leadName }: {
  widget: WidgetDto;
  widgets: readonly WidgetDto[];
  views: readonly string[];
  leadName: string;
}) {
  const runtime = useCompanionRuntime();
  const locale = useLocale();
  const m = useMessages(viewsMessages);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (label: string, action: () => Promise<unknown>) => {
    setPending(label);
    setError(null);
    action()
      .catch((reason: unknown) => setError(widgetErrorText(reason, locale)))
      .finally(() => setPending(null));
  };
  const up = movedOrder(widgets, widget.id, -1);
  const down = movedOrder(widgets, widget.id, 1);
  const reorder = (ids: number[]) => run(m.moving, () => runtime.widgetAction('widget_board', 'widgets', 'reorder', { ids }));
  const moveTo = (view: string) => run(m.moving, () => runtime.widgetAction('widget', String(widget.id), 'update', { view }));
  const remove = () => run(m.deleting, () => runtime.widgetAction('widget', String(widget.id), 'delete', { confirm: true }));
  const refresh = () => run(m.refreshing, () => runtime.widgetAction('widget', String(widget.id), 'refresh'));
  const problem = widgetSourceProblem(widget, locale);
  const [foldedIds, setFolded] = useFoldedWidgets();
  const folded = foldedIds.includes(widget.id);
  return (
    <Column testID={`widget-${widget.id}`} gap="card-row">
      {/* 箭头和「⋯」都和标题、更新说明这两行垂直居中，和 RecordRow 的行尾内容、行尾动作一样（P16.8）。 */}
      <Row testID={`widget-head-${widget.id}`} items="center" gap="side-item">
        {/* 标题和箭头一起点：和工单详情里能折叠的块（Section）同一种箭头和读屏说法。「⋯」不在可点的范围里。 */}
        <Pressable
          testID={`widget-toggle-${widget.id}`}
          aria-expanded={!folded}
          aria-label={m.foldToggle(widget.title, folded)}
          onPress={() => setFolded(widget.id, !folded)}
          feedback="opacity"
          flex={1}
          minW={0}
        >
          <Row items="flex-start" gap="inline-item">
            <Column flex={1} minW={0} gap="text-stack">
              <Text testID={`widget-title-${widget.id}`} size="card-title" weight="semibold" numberOfLines={1}>{widget.title}</Text>
              <Text testID={`widget-meta-${widget.id}`} size="meta" tone="secondary">{widgetMetaLine(widget, leadName, locale)}</Text>
            </Column>
            <Row self="center" shrink={0}>
              <Icon name={folded ? 'chevron-right' : 'chevron-down'} size={12} color="text-secondary" weight="semibold" />
            </Row>
          </Row>
        </Pressable>
        <WidgetMenu
          widget={widget}
          otherViews={views.filter((view) => view !== widget.view)}
          disabled={pending !== null}
          onUp={up ? () => reorder(up) : null}
          onDown={down ? () => reorder(down) : null}
          onMoveTo={moveTo}
          onRefresh={widget.source ? refresh : null}
          onDelete={remove}
        />
      </Row>
      {/* 折叠时内容不画；数据源出错的提示照样显示，不能因为折叠就看不到更新停了。 */}
      {problem ? <Text testID={`widget-source-problem-${widget.id}`} size="note" tone="danger-dark">{problem}</Text> : null}
      {folded ? null : <SurfaceView surface={widget.surface} rules={WIDGET_SURFACE_RULES} />}
      {pending ? <Text testID={`widget-pending-${widget.id}`} size="note" tone="secondary">{pending}</Text> : null}
      {error ? <Text testID={`widget-error-${widget.id}`} size="note" tone="danger-dark">{error}</Text> : null}
    </Column>
  );
}

function WidgetMenu({ widget, otherViews, disabled, onUp, onDown, onMoveTo, onRefresh, onDelete }: {
  widget: WidgetDto;
  otherViews: readonly string[];
  disabled: boolean;
  onUp: (() => void) | null;
  onDown: (() => void) | null;
  onMoveTo: (view: string) => void;
  // 有数据源时：马上跑一次；暂停了的也接着跑。
  onRefresh: (() => void) | null;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const locale = useLocale();
  const m = useMessages(viewsMessages);
  return (
    <Popover
      testID={`widget-more-${widget.id}`}
      label={m.menuLabel(widget.title, Boolean(onRefresh), otherViews.map((view) => viewLabel(view, locale)))}
      title={widget.title}
      width={300}
      trigger={<Icon name="more" size={16} color="text-secondary" />}
    >
      {(close) => {
        const done = () => { setConfirming(false); close(); };
        // 就地确认（P5.3）：确认行替换原来的操作行。
        if (confirming) {
          return (
            <Column testID={`widget-delete-confirm-${widget.id}`} gap="card-row">
              <Text size="body">{m.deleteConfirm(widget.title)}</Text>
              <Row gap="actions">
                <Button testID={`widget-delete-confirm-yes-${widget.id}`} label={m.delete} size="sm" tone="danger" onPress={() => { done(); onDelete(); }} />
                <Button label={m.cancel} size="sm" variant="ghost" tone="neutral" onPress={() => setConfirming(false)} />
              </Row>
            </Column>
          );
        }
        return (
          <Column>
            {onRefresh ? (
              <RecordRow
                testID={`widget-refresh-${widget.id}`}
                title={widget.source?.paused ? m.resume : m.refreshNow}
                detail={widget.source?.paused ? m.resumeDetail : undefined}
                onPress={disabled ? undefined : () => { done(); onRefresh(); }}
              />
            ) : null}
            <RecordRow
              divider={Boolean(onRefresh)}
              testID={`widget-move-up-${widget.id}`}
              title={m.moveUp}
              detail={onUp ? undefined : m.atTop}
              onPress={onUp && !disabled ? () => { done(); onUp(); } : undefined}
            />
            <RecordRow
              divider
              testID={`widget-move-down-${widget.id}`}
              title={m.moveDown}
              detail={onDown ? undefined : m.atBottom}
              onPress={onDown && !disabled ? () => { done(); onDown(); } : undefined}
            />
            {/* 只有一个视图时没有「移到」：分视图由 Lead 在用户要求时做（用户 2026-10-30）。 */}
            {otherViews.map((view) => (
              <RecordRow
                key={view}
                divider
                testID={`widget-move-to-${widget.id}-${view}`}
                title={m.moveTo(viewLabel(view, locale))}
                onPress={disabled ? undefined : () => { done(); onMoveTo(view); }}
              />
            ))}
            <RecordRow
              divider
              testID={`widget-delete-${widget.id}`}
              title={m.delete}
              detail={m.deleteDetail}
              onPress={disabled ? undefined : () => setConfirming(true)}
            />
          </Column>
        );
      }}
    </Popover>
  );
}
