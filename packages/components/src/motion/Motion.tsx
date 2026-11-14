import { useLayoutEffect, useRef, type PropsWithChildren } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
  FadeInLeft,
  FadeInRight,
  FadeOutLeft,
  FadeOutRight,
  LinearTransition,
  ReduceMotion,
  SlideInLeft,
  SlideInRight,
  SlideOutLeft,
  SlideOutRight,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { Box, type BoxProps } from '../primitives/layout';

// 动效组件。三个平台都用 Reanimated，系统设置了"减弱动态效果"时不播放。

const panelEasing = Easing.bezier(0.2, 0, 0, 1);
const contentEasing = Easing.bezier(0.33, 1, 0.68, 1);

const panelEntering = {
  left: SlideInLeft.duration(260).easing(panelEasing).reduceMotion(ReduceMotion.System),
  right: SlideInRight.duration(260).easing(panelEasing).reduceMotion(ReduceMotion.System),
};
const panelExiting = {
  left: SlideOutLeft.duration(220).easing(panelEasing).reduceMotion(ReduceMotion.System),
  right: SlideOutRight.duration(220).easing(panelEasing).reduceMotion(ReduceMotion.System),
};
const contentEntering = {
  forward: FadeInRight.duration(170).easing(contentEasing).reduceMotion(ReduceMotion.System),
  backward: FadeInLeft.duration(170).easing(contentEasing).reduceMotion(ReduceMotion.System),
};
const contentExiting = {
  forward: FadeOutLeft.duration(130).easing(contentEasing).reduceMotion(ReduceMotion.System),
  backward: FadeOutRight.duration(130).easing(contentEasing).reduceMotion(ReduceMotion.System),
};
const layoutTransition = LinearTransition.duration(260).easing(panelEasing).reduceMotion(ReduceMotion.System);

// 动画容器在父级 flex 布局里的尺寸。它们作用在动画容器上，样式属性作用在里面的 Box 上。
export type MotionLayout = {
  grow?: number;
  basis?: number;
  minWidth?: number;
  maxWidth?: number;
};

function layoutStyle({ grow, basis, minWidth, maxWidth }: MotionLayout): ViewStyle {
  return { flexGrow: grow, flexBasis: basis, minWidth, maxWidth };
}

export type SlidePanelProps = MotionLayout & Omit<BoxProps, 'children'> & PropsWithChildren<{
  // 从哪一边滑入、滑出。
  edge: 'left' | 'right';
  // 盖在同级内容上（铺满父容器），并作为对话框暴露给无障碍服务。
  modal?: boolean;
}>;

// 从左边或右边滑入的面板，例如工作台的侧栏和工单详情。
export function SlidePanel({ edge, modal = false, grow, basis, minWidth, maxWidth, children, ...box }: SlidePanelProps) {
  return (
    <Animated.View
      role={modal ? 'dialog' : undefined}
      accessibilityViewIsModal={modal}
      collapsable={false}
      entering={panelEntering[edge]}
      exiting={panelExiting[edge]}
      style={modal ? styles.modal : layoutStyle({ grow, basis, minWidth, maxWidth })}
    >
      <Box flex={1} {...box}>{children}</Box>
    </Animated.View>
  );
}

export type LayoutTransitionProps = MotionLayout & Omit<BoxProps, 'children'> & PropsWithChildren;

// 兄弟元素出现或消失时，平滑地调整自己的尺寸和位置。
export function LayoutTransition({ grow, basis, minWidth, maxWidth, children, testID, ...box }: LayoutTransitionProps) {
  return (
    <Animated.View testID={testID} layout={layoutTransition} style={layoutStyle({ grow, basis, minWidth, maxWidth })}>
      <Box flex={1} {...box}>{children}</Box>
    </Animated.View>
  );
}

export type SwitchTransitionProps = PropsWithChildren<{
  // 内容的身份。它变化时，旧内容淡出，新内容淡入。
  transitionKey: string;
  // forward 从右侧进入，backward 从左侧进入，none 不做动画。
  direction: 'forward' | 'backward' | 'none';
}>;

// 在同一块区域里切换不同的内容，例如侧栏的收件箱、工单、项目和日程。
export function SwitchTransition({ transitionKey, direction, children }: SwitchTransitionProps) {
  return (
    <View style={styles.viewport}>
      <Animated.View
        key={transitionKey}
        collapsable={false}
        entering={direction === 'none' ? undefined : contentEntering[direction]}
        exiting={direction === 'none' ? undefined : contentExiting[direction]}
        style={StyleSheet.absoluteFill}
      >
        {children}
      </Animated.View>
    </View>
  );
}

// 卡片原地换成另一种样子（主题 H-9，2026-11-14 方案 F）：例如决定卡做完以后收成一行结束行。
//   旧内容用 130 淡出；外框的高度用 220 从旧高度过渡到新内容的高度，下面的内容跟着平滑移动，不跳（P1）；
//   新内容延后 60，用 170 淡入、上移 4（Reveal）。减弱动态效果时高度直接到位，只留透明度变化。
// 只在 swapKey 变了的那一次播：第一次挂上、内容自己变高变矮时都不动画。会话列表是虚拟列表，
// 行高一直在动画里变，列表就一直重新排版、调整滚动位置（2026-11-14，用 Reanimated 的 layout 过渡时出现过）。
const SWAP_MS = 220;
const swapEntering = FadeInDown.duration(170).delay(60).withInitialValues({ transform: [{ translateY: 4 }] }).easing(contentEasing).reduceMotion(ReduceMotion.System);
const swapExiting = FadeOut.duration(130).reduceMotion(ReduceMotion.System);
const appearEntering = FadeIn.duration(170).delay(60).reduceMotion(ReduceMotion.System);
const AUTO = -1;

export type ContentSwapProps = PropsWithChildren<{
  /** 内容的身份，例如卡片的状态（waiting、done）。它变了才播过渡。 */
  swapKey: string;
  testID?: string;
}>;

export function ContentSwap({ swapKey, children, testID }: ContentSwapProps) {
  const reduced = useReducedMotion();
  // 外框的高度：AUTO 时跟着内容走；过渡时是动画里的数值。
  const height = useSharedValue(AUTO);
  const measured = useRef(0);
  const firstKey = useRef(swapKey);
  const pending = useRef(false);
  const swapped = firstKey.current !== swapKey;

  useLayoutEffect(() => {
    if (firstKey.current === swapKey && !pending.current) return;
    // 换内容的这一刻把外框定在旧高度，等新内容量出高度再过渡过去。
    pending.current = true;
    if (!reduced) height.value = measured.current;
  }, [swapKey, height, reduced]);

  const onLayout = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.height;
    measured.current = next;
    if (!pending.current) return;
    pending.current = false;
    if (reduced) return;
    height.value = withTiming(next, { duration: SWAP_MS, easing: panelEasing }, (finished) => {
      if (finished) height.value = AUTO;
    });
  };

  const frameStyle = useAnimatedStyle(() => (height.value === AUTO ? {} : { height: height.value, overflow: 'hidden' }));

  return (
    <Animated.View testID={testID} style={frameStyle}>
      <Animated.View
        key={swapKey}
        onLayout={onLayout}
        entering={swapped ? swapEntering : undefined}
        exiting={swapExiting}
      >
        {children}
      </Animated.View>
    </Animated.View>
  );
}

// 新内容出现时淡入（Reveal，170，延后 60）。例如新卡片进入会话。
export function Appear({ children, testID }: PropsWithChildren<{ testID?: string }>) {
  return <Animated.View testID={testID} entering={appearEntering}>{children}</Animated.View>;
}

const styles = StyleSheet.create({
  modal: { ...StyleSheet.absoluteFill, zIndex: 20 },
  viewport: { flex: 1, overflow: 'hidden' },
});
