import { useMemo, useRef, type ReactNode } from 'react';
import { Animated, PanResponder, Platform, Pressable as RNPressable, Vibration } from 'react-native';
import { View } from '@tamagui/core';

import { Icon } from './Icon';
import type { IconName } from './icons';

// 往右滑一段触发一个操作（像聊天软件的「滑动回复」）：跟手最多 56，过 44 时轻震一下，松手就触发；回弹 220。
// 长按也可以触发（onLongPress）。只接横向往右、明显比竖向大的拖动，竖着滚列表不受影响。
// 读屏：这一段有一个自定义操作（actionLabel），提示是 hint。会话里引用一段（设计规范 P17.10、主题 Q-7）用它。
export type SwipeActionProps = {
  icon: IconName;
  actionLabel: string;
  hint?: string;
  onAction: () => void;
  onLongPress?: () => void;
  // 淡淡标出这一段（accent-wash 底），例如它正被引用。
  highlighted?: boolean;
  testID?: string;
  children: ReactNode;
};

// 组件规格（主题 Q-7）：跟手的最大距离、触发的距离、回弹的时长、左边露出的图标圆的大小、长按的时长。
const MAX_SHIFT = 56;
const THRESHOLD = 44;
const SPRING_BACK_MS = 220;
const BADGE = 32;
const LONG_PRESS_MS = 400;

export function SwipeAction({ icon, actionLabel, hint, onAction, onLongPress, highlighted = false, testID, children }: SwipeActionProps) {
  const shift = useRef(new Animated.Value(0)).current;
  const passed = useRef(false);
  const actionRef = useRef(onAction);
  actionRef.current = onAction;
  const responder = useMemo(() => {
    const springBack = () => Animated.timing(shift, { toValue: 0, duration: SPRING_BACK_MS, useNativeDriver: Platform.OS !== 'web' }).start();
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_event, move) => move.dx > 8 && Math.abs(move.dx) > Math.abs(move.dy) * 2,
      onPanResponderGrant: () => { passed.current = false; },
      onPanResponderMove: (_event, move) => {
        const value = Math.max(0, Math.min(MAX_SHIFT, move.dx));
        shift.setValue(value);
        if (!passed.current && value >= THRESHOLD) {
          passed.current = true;
          if (Platform.OS !== 'web') Vibration.vibrate(10);
        }
      },
      onPanResponderRelease: () => {
        if (passed.current) actionRef.current();
        springBack();
      },
      onPanResponderTerminate: springBack,
    });
  }, [shift]);
  const iconScale = shift.interpolate({ inputRange: [0, MAX_SHIFT], outputRange: [0.6, 1], extrapolate: 'clamp' });
  const iconOpacity = shift.interpolate({ inputRange: [0, 12, MAX_SHIFT], outputRange: [0, 1, 1], extrapolate: 'clamp' });
  return (
    <View position="relative" testID={testID} rounded="sm" {...(highlighted ? { bg: 'accent-wash' } as const : {})}>
      <Animated.View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, opacity: iconOpacity, transform: [{ scale: iconScale }] }}>
        <View w={BADGE} h={BADGE} rounded="full" bg="accent-soft" items="center" justify="center">
          <Icon name={icon} size={16} color="accent-strong" />
        </View>
      </Animated.View>
      <Animated.View
        {...responder.panHandlers}
        accessible
        accessibilityHint={hint}
        accessibilityActions={[{ name: 'swipe-action', label: actionLabel }]}
        onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === 'swipe-action') onAction(); }}
        style={{ transform: [{ translateX: shift }] }}
      >
        {/* 长按用 RN 的 Pressable：短按什么都不做，里面的链接和按钮照常先接住点按。 */}
        <RNPressable onLongPress={onLongPress} delayLongPress={LONG_PRESS_MS}>{children}</RNPressable>
      </Animated.View>
    </View>
  );
}
