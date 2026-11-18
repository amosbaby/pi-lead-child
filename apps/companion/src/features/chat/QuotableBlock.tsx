// 手机：Lead 回答里的一段（设计规范 P17.10、主题 Q-7）。往右滑过 44 时轻震一下，松手就引用这一段；长按也开始引用这一段。
// 开始以后输入框自动聚焦、键盘弹起（QuoteGesturesContext 的 onBegin），不弹带遮罩的面板。
// 不在手势打开的会话里（桌面、工单对话、daemon 不收引用）时原样画出这一段。
import { useContext, useMemo, useRef, type ReactNode } from 'react';
import { Animated, PanResponder, Platform, Pressable, Vibration } from 'react-native';

import { Box, Icon } from '@pi-lead-child/components';

import { useMessages } from '@/i18n';

import { quoteMessages } from './quote.messages';
import { quoteDrafts } from './quoteDrafts';
import { QuoteGesturesContext, QuoteSourceContext } from './quoteSources';

// Q-7：最多跟手 56，过 44 算数，回弹 220。
const MAX_SHIFT = 56;
const THRESHOLD = 44;
const SPRING_BACK_MS = 220;

export function QuotableBlock({ text, children }: { text: string; children: ReactNode }) {
  const source = useContext(QuoteSourceContext);
  const gestures = useContext(QuoteGesturesContext);
  const m = useMessages(quoteMessages);
  const shift = useRef(new Animated.Value(0)).current;
  const passed = useRef(false);
  const begin = () => {
    if (!source || !gestures) return;
    quoteDrafts.getState().begin({ source, text, context: text });
    gestures.onBegin();
  };
  const beginRef = useRef(begin);
  beginRef.current = begin;
  const responder = useMemo(() => PanResponder.create({
    // 只接横向往右、明显比竖向大的拖动：竖着滚会话不受影响。
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
      if (passed.current) beginRef.current();
      Animated.timing(shift, { toValue: 0, duration: SPRING_BACK_MS, useNativeDriver: Platform.OS !== 'web' }).start();
    },
    onPanResponderTerminate: () => {
      Animated.timing(shift, { toValue: 0, duration: SPRING_BACK_MS, useNativeDriver: Platform.OS !== 'web' }).start();
    },
  }), [shift]);

  if (!source || !gestures || !text.trim()) return <>{children}</>;
  const iconScale = shift.interpolate({ inputRange: [0, MAX_SHIFT], outputRange: [0.6, 1], extrapolate: 'clamp' });
  const iconOpacity = shift.interpolate({ inputRange: [0, 12, MAX_SHIFT], outputRange: [0, 1, 1], extrapolate: 'clamp' });
  return (
    <Box position="relative" testID="quotable-block">
      <Animated.View
        pointerEvents="none"
        style={{ position: 'absolute', left: 0, top: 0, opacity: iconOpacity, transform: [{ scale: iconScale }] }}
      >
        {/* Q-7 的组件规格：32 的圆底回复图标。 */}
        <Box w={32} h={32} rounded="full" bg="accent-soft" items="center" justify="center">
          <Icon name="reply" size={16} color="accent-strong" />
        </Box>
      </Animated.View>
      <Animated.View
        {...responder.panHandlers}
        accessible
        accessibilityHint={m.quoteSwipeHint}
        accessibilityActions={[{ name: 'quote', label: m.quoteParagraph }]}
        onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === 'quote') begin(); }}
        style={{ transform: [{ translateX: shift }] }}
      >
        <LongPress onLongPress={begin}>{children}</LongPress>
      </Animated.View>
    </Box>
  );
}

// 长按开始引用。用 Pressable 的 onLongPress：短按什么都不做，链接和按钮照常响应（它们在里面先接住点按）。
function LongPress({ onLongPress, children }: { onLongPress: () => void; children: ReactNode }) {
  return (
    <Pressable onLongPress={onLongPress} delayLongPress={400}>
      {children}
    </Pressable>
  );
}
