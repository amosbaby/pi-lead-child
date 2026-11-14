import { useContext, type Ref } from 'react';
import { ScrollView } from 'react-native';
import { KeyboardAwareScrollView, type KeyboardAwareScrollViewRef } from 'react-native-keyboard-controller';

import { InsideKeyboardArea } from './keyboardContext';
import type { KeyboardScrollViewProps } from './KeyboardScrollView.types';

// 原生实现：竖向滚动区里的输入框获得焦点时，滚到键盘上面（2026-11-13，设置页的表单被键盘盖住）。
// Android 从 Expo SDK 54 起是 edge-to-edge，系统不再缩小窗口，滚动区要自己让开键盘。
// 横向、嵌套的滚动区，以及外层已经有 KeyboardArea 的滚动区，保持普通的 ScrollView，不重复给键盘留位置。
export function KeyboardScrollView({ ref, ...props }: KeyboardScrollViewProps) {
  const insideKeyboardArea = useContext(InsideKeyboardArea);
  if (insideKeyboardArea || props.horizontal || props.nestedScrollEnabled) return <ScrollView ref={ref} {...props} />;
  // spacing-exempt: 输入框和键盘之间留的距离
  // 它的 ref 就是 ScrollView 实例，再加一个方法，所以调用方拿到的 ScrollView 类型成立。
  return <KeyboardAwareScrollView ref={ref as Ref<KeyboardAwareScrollViewRef>} bottomOffset={16} {...props} />;
}
