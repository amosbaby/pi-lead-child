import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal, PanResponder, Platform, ScrollView, StatusBar, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useBreakpoint } from '../platform';
import { Pressable } from '../primitives/Pressable';
import { useKeyboardLift } from '../primitives/useKeyboardLift';
import { elevation, palette } from '../theme/tokens';
import { useMessages } from '../i18n';
import { displayMessages } from './display.messages';
import { registerOverlay } from './overlayPresence';

export type FloatingSheetProps = {
  open: boolean;
  /** 点遮罩、往下拖、按返回键（Android）或 Esc（web）时调用。 */
  onClose: () => void;
  /** 读屏的说法，例如「添加」。面板上不写标题，标题由内容自己画。 */
  label: string;
  children: ReactNode;
  /** 钉在底部的操作条（P13.2b）：最多一个主按钮、一个次按钮，其余进「⋯」。不跟内容滚动。 */
  footer?: ReactNode;
  /** 高的一档（P13.2a）：长文类的卡片（验收证据、日志、完整的差异说明）一打开就是这一档。 */
  tall?: boolean;
  /** 内容区的内边距：content 是卡片的 12/20/16；menu 是加号面板这类菜单的 0/12/12，内容自己排。 */
  inset?: 'content' | 'menu';
  testID?: string;
};

// 手机上的悬浮底部面板（主题 H-7，P13.2 到 P13.2c，2026-11-14 用户定）。加号、换模型和会话里点开的卡片都用它。
// 不贴边：左右离屏幕 12、离底 20（加安全区），四角圆角 28，白底，面板阴影；顶上一条 36×4 的小横杠。
// 高度三档，由内容决定：贴合内容；超过屏幕的六成时停在六成，内容在面板里滚动；tall 时顶部离屏幕顶 80。
// 从中间那一档往上拖小横杠，也能到高的一档。往下拖小横杠、点遮罩或按返回键收起。
// 升起 260、收下 220，遮罩（text 色、0.28）同时淡入淡出；减弱动态效果时只淡入淡出。键盘弹出时整块跟着上移。
// 用透明的 Modal 盖住一切，收下的动画播完才卸载。
const OPEN_MS = 260;
const CLOSE_MS = 220;
const SCRIM_OPACITY = 0.28;
const easing = Easing.bezier(0.2, 0, 0, 1);
// 组件规格：离边的距离、圆角、高的一档离顶的距离、中间一档占屏幕的比例、升起时的位移。
const EDGE = 12;
const BOTTOM = 20;
const RADIUS = 28;
const TALL_TOP = 80;
const MEDIUM_SHARE = 0.6;
const RISE = 48;

// 关着的时候什么都不挂（2026-11-14）：会话里每张能展开的卡片在手机上都带一个面板，关着时也注册键盘、手势和窗口尺寸的监听，
// 几十张卡片一起挂着，点按和滚动都卡。打开时才挂上里面那一层，收起的动画播完再卸载。
export function FloatingSheet(props: FloatingSheetProps) {
  const [mounted, setMounted] = useState(props.open);
  if (props.open && !mounted) setMounted(true);
  if (!mounted) return null;
  return <FloatingSheetBody {...props} onExited={() => setMounted(false)} />;
}

function FloatingSheetBody({ onExited, open, onClose, label, children, footer, tall: tallProp = false, inset = 'content', testID }: FloatingSheetProps & { onExited: () => void }) {
  const m = useMessages(displayMessages);
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useBreakpoint();
  const reduced = useReducedMotion();
  const keyboard = useKeyboardLift();
  // 用户往上拖到了高的一档。收起以后回到原来那一档。
  const [expanded, setExpanded] = useState(false);
  const tall = tallProp || expanded;
  const progress = useSharedValue(0);
  // 开着的时候登记一个浮层：FairyEye 被盖住时暂停（overlayPresence）。
  useEffect(() => registerOverlay(), []);
  const drag = useSharedValue(0);
  const panelHeight = useRef(0);

  useEffect(() => {
    if (open) {
      drag.value = 0;
      progress.value = withTiming(1, { duration: OPEN_MS, easing });
    } else {
      progress.value = withTiming(0, { duration: CLOSE_MS, easing }, (finished) => {
        if (finished) runOnJS(onExited)();
      });
    }
  }, [open, progress, drag]);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // 手势只放在小横杠那一条上：内容区自己滚动，不和关闭的手势抢。
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dy) > 4,
    onPanResponderMove: (_, gesture) => { drag.value = Math.max(0, gesture.dy); },
    onPanResponderRelease: (_, gesture) => {
      if (gesture.dy < -40 || gesture.vy < -0.6) setExpanded(true);
      if (gesture.dy > panelHeight.current / 3 || gesture.vy > 0.6) closeRef.current();
      else drag.value = withTiming(0, { duration: CLOSE_MS, easing });
    },
    onPanResponderTerminate: () => { drag.value = withTiming(0, { duration: CLOSE_MS, easing }); },
  }), [drag]);

  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value * SCRIM_OPACITY }));
  const panelStyle = useAnimatedStyle(() => (reduced
    ? { opacity: progress.value, transform: [{ translateY: keyboard.value }] }
    : { opacity: progress.value, transform: [{ translateY: (1 - progress.value) * RISE + drag.value + keyboard.value }] }));

  const bottom = BOTTOM + insets.bottom;
  const statusTop = Math.max(insets.top, Platform.OS === 'android' ? StatusBar.currentHeight ?? 0 : 0);
  const top = Math.max(TALL_TOP, statusTop + EDGE);
  const sizing = tall ? { top } : { maxHeight: Math.round(screenHeight * MEDIUM_SHARE) };

  return (
    <Modal transparent visible animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <View style={StyleSheet.absoluteFill}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: palette.text }, scrimStyle]}>
          <Pressable testID={testID ? `${testID}-scrim` : undefined} aria-label={m.close} feedback="none" cursor="default" onPress={onClose} style={StyleSheet.absoluteFill} />
        </Animated.View>
        <Animated.View
          testID={testID}
          role="dialog"
          aria-modal
          aria-label={label}
          accessibilityViewIsModal
          onLayout={(event) => { panelHeight.current = event.nativeEvent.layout.height; }}
          style={[styles.panel, { bottom, backgroundColor: palette.surface, boxShadow: elevation.raised }, sizing, panelStyle]}
        >
          <View {...pan.panHandlers} style={styles.grabber} testID={testID ? `${testID}-grabber` : undefined}>
            <View style={[styles.handle, { backgroundColor: palette['border-strong'] }]} />
          </View>
          <ScrollView
            style={[styles.body, tall ? styles.bodyFill : null]}
            contentContainerStyle={inset === 'content' ? styles.contentInset : styles.menuInset}
            overScrollMode="never"
            bounces={false}
            keyboardShouldPersistTaps="handled"
            testID={testID ? `${testID}-body` : undefined}
          >
            {children}
          </ScrollView>
          {footer ? (
            <View style={[styles.footer, { borderTopColor: palette['border-soft'] }]} testID={testID ? `${testID}-footer` : undefined}>
              {footer}
            </View>
          ) : null}
        </Animated.View>
      </View>
    </Modal>
  );
}

// 组件规格：内容区 12/20/16，菜单 0/12/12，操作条 12/16/16（P13.2b，画板 SheetRules）。
const styles = StyleSheet.create({
  panel: { position: 'absolute', left: EDGE, right: EDGE, borderRadius: RADIUS, overflow: 'hidden' },
  grabber: { alignItems: 'center', paddingTop: 8, paddingBottom: 8 },
  handle: { width: 36, height: 4, borderRadius: 2 },
  body: { flexGrow: 0, flexShrink: 1, flexBasis: 'auto' },
  // 高的一档：面板从离顶 80 到离底 20，内容区占满中间，操作条贴底。
  bodyFill: { flexGrow: 1 },
  contentInset: { paddingTop: 4, paddingHorizontal: 20, paddingBottom: 16 },
  menuInset: { paddingHorizontal: 12, paddingBottom: 12, gap: 8 },
  footer: { borderTopWidth: 1, paddingTop: 12, paddingHorizontal: 16, paddingBottom: 16, flexDirection: 'row', alignItems: 'center', gap: 8 },
});
