import { KeyboardProvider } from 'react-native-keyboard-controller';

import type { KeyboardRootProps } from './KeyboardRoot.types';

export type { KeyboardRootProps } from './KeyboardRoot.types';

// 原生实现：react-native-keyboard-controller 的根。KeyboardArea 靠它拿到键盘的高度和动画。
export function KeyboardRoot({ children }: KeyboardRootProps) {
  return <KeyboardProvider>{children}</KeyboardProvider>;
}
