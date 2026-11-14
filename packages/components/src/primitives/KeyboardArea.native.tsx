import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { palette } from '../theme/tokens';
import type { KeyboardAreaProps } from './KeyboardArea.types';
import { InsideKeyboardArea } from './keyboardContext';

export type { KeyboardAreaProps } from './KeyboardArea.types';

// 原生实现：键盘弹出时把内容顶上去，底部的输入框贴着键盘，跟着键盘的动画一起移动。
// iOS 和 Android 都要（2026-11-12）：Expo SDK 54 起 Android 强制 edge-to-edge，系统不再缩小窗口，
// 键盘直接盖住输入框。用 react-native-keyboard-controller（Expo Go 自带），它在两个平台上按同一套方式算键盘高度。
export function KeyboardArea({ children, bg, testID }: KeyboardAreaProps) {
  return (
    <KeyboardAvoidingView
      testID={testID}
      behavior="padding"
      style={{ flex: 1, minWidth: 0, backgroundColor: bg ? palette[bg] : undefined }}
    >
      <InsideKeyboardArea.Provider value>{children}</InsideKeyboardArea.Provider>
    </KeyboardAvoidingView>
  );
}
