import { useCallback, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import { Modal, Platform, ScrollView, StyleSheet, View } from 'react-native';

import { IconButton } from '../controls/Button';
import { useBreakpoint } from '../platform';
import { Pressable } from '../primitives/Pressable';
import { Box, Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';
import { palette } from '../theme/tokens';
import { useMessages } from '../i18n';
import { displayMessages } from './display.messages';
import { NativeSheet } from './NativeSheet';

export type PopoverProps = {
  /** 触发按钮给读屏的说法，例如「依据：系统通知，查看来源」。 */
  label: string;
  /** 触发按钮里的内容（文字、图标）。整块是一个按钮，有悬停和焦点样式。 */
  trigger: ReactNode;
  /** 浮层顶部的标题。 */
  title?: string;
  /** 浮层的内容。传函数时拿到 close：例如点了一行要跳转时，先关浮层。 */
  children: ReactNode | ((close: () => void) => ReactNode);
  /** 宽屏时浮层的宽度。 */
  width?: number;
  testID?: string;
};

// 浮层对着的位置（窗口坐标）：触发它的那个东西的方框。
export type PopoverAnchor = { x: number; y: number; width: number; height: number };

export type PopoverPanelProps = {
  /** 浮层对着的位置。null 时浮层关着。 */
  anchor: PopoverAnchor | null;
  onClose: () => void;
  /** 读屏的说法；没有 title 时也是标题。 */
  label: string;
  title?: string;
  children: ReactNode | ((close: () => void) => ReactNode);
  width?: number;
  /** 代替标题那一行的头（例如会话里换模型的浮层：正在用的模型和推理强度）。不跟正文滚动。给了它时正文不加内边距，由内容自己排。 */
  header?: ReactNode;
  /** 钉在底部的操作条，上边一条细线，不跟正文滚动（P13.2b）。 */
  footer?: ReactNode;
  /** 宽屏时浮层最高多少。缺省 420。 */
  maxHeight?: number;
  testID?: string;
};

const GAP = 6;
const EDGE = 8;
const MAX_HEIGHT = 420;

// 点开以后看详情的小浮层。宽屏时浮在触发按钮下面（下面放不下就放上面）；手机宽度时是从底部升起的面板。
// 点外面、按 Esc（web）或返回键（Android）关闭。用 React Native 的 Modal：web 上渲染到 body，不被滚动区裁掉。
export function Popover({ label, trigger, title, children, width = 360, testID }: PopoverProps) {
  const anchorRef = useRef<View>(null);
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);
  const open = anchor !== null;
  const close = useCallback(() => setAnchor(null), []);
  const show = useCallback(() => {
    const node = anchorRef.current as (View & { measureInWindow?: View['measureInWindow'] }) | null;
    if (node?.measureInWindow) {
      node.measureInWindow((x, y, measuredWidth, height) => setAnchor({ x, y, width: measuredWidth, height }));
    } else {
      setAnchor({ x: EDGE, y: EDGE, width: 0, height: 0 });
    }
  }, []);

  return (
    <>
      <View ref={anchorRef} collapsable={false} style={styles.anchor}>
        <Pressable
          testID={testID}
          aria-label={label}
          aria-expanded={open}
          onPress={show}
          feedback="highlight"
          rounded="sm"
          // 键盘聚焦时一圈强调色的描边。
          outline={{ 'focus-visible': `2px solid ${palette.accent}` }}
        >
          {trigger}
        </Pressable>
      </View>
      <PopoverPanel anchor={anchor} onClose={close} label={label} title={title} width={width} testID={testID}>
        {children}
      </PopoverPanel>
    </>
  );
}

// Popover 的浮层本身，由调用方决定什么时候打开、对着哪里。文字里的链接用它（MarkdownMessage 的对象链接，P14.7）：
// 触发它的是一段文字，不是一个按钮。
export function PopoverPanel({
  anchor, onClose, label, title, children, width = 360, header, footer, maxHeight: maxHeightProp = MAX_HEIGHT, testID,
}: PopoverPanelProps) {
  const m = useMessages(displayMessages);
  const breakpoint = useBreakpoint();
  const sheet = !breakpoint.tablet;
  const open = anchor !== null;
  const close = onClose;
  const panelWidth = Math.min(width, breakpoint.width - EDGE * 2);
  const below = anchor ? breakpoint.height - (anchor.y + anchor.height + GAP) - EDGE : 0;
  const above = anchor ? anchor.y - GAP - EDGE : 0;
  const placeBelow = below >= Math.min(maxHeightProp, 240) || below >= above;
  const maxHeight = Math.max(160, Math.min(maxHeightProp, placeBelow ? below : above));
  const left = anchor ? Math.max(EDGE, Math.min(anchor.x, breakpoint.width - panelWidth - EDGE)) : EDGE;
  const position = sheet || !anchor
    ? styles.sheet
    : placeBelow
      ? { position: 'absolute' as const, left, top: anchor.y + anchor.height + GAP, width: panelWidth }
      : { position: 'absolute' as const, left, bottom: breakpoint.height - anchor.y + GAP, width: panelWidth };

  const body = typeof children === 'function' ? children(close) : children;
  const titleRow = header !== undefined ? (
    <Box shrink={0} borderBottomWidth={1} borderBottomColor="border-soft">{header}</Box>
  ) : (
    <Row items="center" gap="inline-item" pl="card" pr="card" py="card" borderBottomWidth={1} borderBottomColor="border-soft">
      <Text flex={1} minW={0} size="section-title" weight="extrabold" numberOfLines={1} pt={sheet && Platform.OS === 'web' ? 6 : 0}>{title ?? label}</Text>
      <IconButton icon="close" label={m.close} onPress={close} size="sm" />
    </Row>
  );
  const footerRow = footer !== undefined ? (
    <Box shrink={0} borderTopWidth={1} borderTopColor="border-soft">{footer}</Box>
  ) : null;

  // 手机宽度的原生端：系统的底部面板（2026-11-12）。它自带遮罩、把手、下拉关闭和跟手的动画。
  if (sheet && Platform.OS !== 'web') {
    return (
      <NativeSheet open={open} onClose={close} label={title ?? label} header={titleRow} testID={testID ? `${testID}-panel` : undefined}>
        <View style={styles.bodyContent}>{body}</View>
        {footerRow}
      </NativeSheet>
    );
  }

  return (
    <>
      {/* web 上不播动画：浮层点开就出现（react-native-web 的 Modal 要等动画结束事件才卸载）。 */}
      <Modal
        transparent
        visible={open}
        onRequestClose={close}
        animationType={Platform.OS === 'web' ? 'none' : sheet ? 'slide' : 'fade'}
      >
        <Pressable
          aria-label={m.close}
          feedback="none"
          cursor="default"
          onPress={close}
          style={[StyleSheet.absoluteFill, sheet ? styles.dim : null]}
        />
        <View style={position} pointerEvents="box-none">
          <Column
            testID={testID ? `${testID}-panel` : undefined}
            role="dialog"
            aria-label={title ?? label}
            bg="surface"
            borderWidth={1}
            borderColor="border"
            rounded="lg"
            {...(sheet ? { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 } : {})}
            boxShadow="0 12px 32px rgba(16,24,40,0.18)"
            overflow="hidden"
            maxH={sheet ? breakpoint.height * 0.7 : maxHeight}
          >
            {titleRow}
            {sheet ? <Box position="absolute" t={5} l={0} r={0} items="center"><Box w={36} h={4} rounded="full" bg="border-strong" /></Box> : null}
            <ScrollView style={styles.body} contentContainerStyle={header !== undefined ? null : styles.bodyContent}>{body}</ScrollView>
            {footerRow}
          </Column>
        </View>
      </Modal>
    </>
  );
}

// 一块能量出位置的内容：调用方自己决定什么时候打开 PopoverPanel、对着它（例如回答头上的模型名、整个输入框）。
// layout：start 按内容宽、靠左（和 Popover 的触发按钮一样）；shrink 在一行里可以被挤窄；block 占满一行。
export type PopoverAnchorHandle = { measure: (done: (anchor: PopoverAnchor) => void) => void };

export function PopoverAnchorView({ children, layout = 'start', ref }: {
  children: ReactNode;
  layout?: 'start' | 'shrink' | 'block';
  ref?: Ref<PopoverAnchorHandle>;
}) {
  const node = useRef<View>(null);
  useImperativeHandle(ref, () => ({
    measure: (done) => {
      const target = node.current as (View & { measureInWindow?: View['measureInWindow'] }) | null;
      if (target?.measureInWindow) target.measureInWindow((x, y, width, height) => done({ x, y, width, height }));
      else done({ x: EDGE, y: EDGE, width: 0, height: 0 });
    },
  }), []);
  return (
    <View ref={node} collapsable={false} style={layout === 'start' ? styles.anchor : layout === 'shrink' ? styles.shrink : null}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: { alignSelf: 'flex-start' },
  shrink: { flexShrink: 1, minWidth: 0 },
  dim: { backgroundColor: 'rgba(16,24,40,0.32)' },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  body: { flexGrow: 0, flexShrink: 1, flexBasis: 'auto' },
  bodyContent: { padding: 12, gap: 8 },
});
