import { useSharedValue, type SharedValue } from 'react-native-reanimated';

// 软键盘把内容往上推多少（负数，像素）。web 上没有软键盘遮挡，一直是 0。原生见 useKeyboardLift.native.ts。
export function useKeyboardLift(): SharedValue<number> {
  return useSharedValue(0);
}
