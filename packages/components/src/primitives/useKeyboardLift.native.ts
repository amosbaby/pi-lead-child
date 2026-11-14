import type { SharedValue } from 'react-native-reanimated';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';

// 原生：键盘的高度跟着键盘的动画走（负数，像素），用 translateY 把悬浮的面板顶到键盘上面（P13.2c）。
export function useKeyboardLift(): SharedValue<number> {
  return useReanimatedKeyboardAnimation().height;
}
