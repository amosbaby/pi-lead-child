import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal, PanResponder, Platform, StatusBar, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Pressable } from '../primitives/Pressable';
import { elevation, palette } from '../theme/tokens';
import { useMessages } from '../i18n';
import { displayMessages } from './display.messages';
import { registerOverlay } from './overlayPresence';

export type DrawerProps = {
  open: boolean;
  /** 点遮罩、往左滑、按返回键（Android）或 Esc（web）时调用。 */
  onClose: () => void;
  /** 读屏的说法，例如「菜单」。 */
  label: string;
  children: ReactNode;
  testID?: string;
};

// 从左边滑出的抽屉（主题 H-5、H-9，2026-11-14 方案 F，画板 FDrawer3）。手机首页点左上角的 Lead 形象打开。
// 贴着左边、顶部和底部，宽 324（窄屏时最多占屏幕的 88%），浅底 page，E-2 阴影，只有右边两个角是 28 的圆角；
// 后面压一层 0.28 的遮罩。内容自己排（安全区由抽屉加上）。
// 打开 260、收回 220，遮罩同时淡入淡出；减弱动态效果时不滑动，只淡入淡出。
// 用透明的 Modal：盖住状态栏、输入框和一切，Android 的返回键由 Modal 交给 onClose。收回的动画播完才卸载。
// 手势用 React Native 自带的 PanResponder，三端都能用，不依赖 gesture-handler 的根视图。
const OPEN_MS = 260;
const CLOSE_MS = 220;
const SCRIM_OPACITY = 0.28;
const MAX_WIDTH = 324; // 组件规格
const WIDTH_SHARE = 0.88;
const easing = Easing.bezier(0.2, 0, 0, 1);

// 关着的时候什么都不挂（2026-11-14）：会话里每张能展开的卡片在手机上都带一个面板，关着时也注册键盘、手势和窗口尺寸的监听，
// 几十张卡片一起挂着，点按和滚动都卡。打开时才挂上里面那一层，收起的动画播完再卸载。
export function Drawer(props: DrawerProps) {
  const [mounted, setMounted] = useState(props.open);
  if (props.open && !mounted) setMounted(true);
  if (!mounted) return null;
  return <DrawerBody {...props} onExited={() => setMounted(false)} />;
}

function DrawerBody({ onExited, open, onClose, label, children, testID }: DrawerProps & { onExited: () => void }) {
  const m = useMessages(displayMessages);
  const { width: screenWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // Android 上透明 Modal 盖住状态栏时，Modal 里读到的安全区可能是 0（2026-11-14 真机上头像压到了状态栏上），用状态栏的高度兜底。
  const top = Math.max(insets.top, Platform.OS === 'android' ? StatusBar.currentHeight ?? 0 : 0);
  const reduced = useReducedMotion();
  const width = Math.min(MAX_WIDTH, Math.round(screenWidth * WIDTH_SHARE));
  // mounted：Modal 还在屏幕上。open 变成 false 以后，等收回的动画播完才卸载。
  const progress = useSharedValue(0);
  // 开着的时候登记一个浮层：FairyEye 被盖住时暂停（overlayPresence）。
  useEffect(() => registerOverlay(), []);
  // 手指往左拖的距离（负数），松手时决定关上还是弹回。
  const drag = useSharedValue(0);

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

  // 往左滑关上：横向移动明显大于纵向时才接手，不抢抽屉里列表的竖向滚动。拖过三分之一或者甩得快就关，否则弹回。
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_, gesture) => gesture.dx < -12 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
    onPanResponderMove: (_, gesture) => { drag.value = Math.min(0, gesture.dx); },
    onPanResponderRelease: (_, gesture) => {
      if (gesture.dx < -width / 3 || gesture.vx < -0.6) closeRef.current();
      else drag.value = withTiming(0, { duration: CLOSE_MS, easing });
    },
    onPanResponderTerminate: () => { drag.value = withTiming(0, { duration: CLOSE_MS, easing }); },
  }), [drag, width]);

  const scrimStyle = useAnimatedStyle(() => ({
    opacity: progress.value * SCRIM_OPACITY * (1 + drag.value / width),
  }));
  const panelStyle = useAnimatedStyle(() => (reduced
    ? { opacity: progress.value, transform: [{ translateX: 0 }] }
    : { opacity: 1, transform: [{ translateX: (progress.value - 1) * width + drag.value * progress.value }] }));

  return (
    <Modal transparent visible animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <View style={StyleSheet.absoluteFill}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: palette.text }, scrimStyle]}>
          <Pressable testID={testID ? `${testID}-scrim` : undefined} aria-label={m.close} feedback="none" cursor="default" onPress={onClose} style={StyleSheet.absoluteFill} />
        </Animated.View>
          <Animated.View
            {...pan.panHandlers}
            testID={testID}
            role="dialog"
            aria-modal
            aria-label={label}
            accessibilityViewIsModal
            style={[
              styles.panel,
              { width, paddingTop: top, paddingBottom: insets.bottom, backgroundColor: palette.page, boxShadow: elevation.raised },
              panelStyle,
            ]}
          >
            {children}
          </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // 右边两个角是 28（组件规格）。
  panel: { position: 'absolute', left: 0, top: 0, bottom: 0, borderTopRightRadius: 28, borderBottomRightRadius: 28, overflow: 'hidden' },
});
