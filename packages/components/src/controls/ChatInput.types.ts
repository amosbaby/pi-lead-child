// 会话输入框里的多行文字输入。缺省一行高，内容多了自动长高，到上限以后在框里滚动。
// web 上：Enter 调 onSubmit，Shift+Enter 换行，输入法正在组字时按 Enter 不调（确认候选词）；粘贴剪贴板里的图片调 onPasteFiles。
// iOS 上是 Expo UI 的多行输入框，Android 上是 React Native 的多行 TextInput：键盘的回车换行，发送用旁边的按钮；没有粘贴图片。
// 外框（底色、描边、圆角）由调用方画，这里只有文字。
import type { Ref } from 'react';

// 调用方拿来把焦点放回输入框（例如点发送按钮以后，2026-11-02）。原生实现不接 ref，调用时什么也不做。
export type ChatInputHandle = { focus: () => void };

export type ChatInputProps = {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  disabled?: boolean;
  onSubmit?: () => void;
  // 剪贴板里有图片、没有文字时，粘贴调它，图片不插进文字里。剪贴板里有文字时照常粘贴文字。
  onPasteFiles?: (files: Blob[]) => void;
  onBlur?: () => void;
  autoFocus?: boolean;
  // 大一号的字：手机首页悬浮的输入框（主题 H-6）用 message-lead（16/24），其余用 message-body（14/24）。
  large?: boolean;
  testID?: string;
  accessibilityLabel?: string;
  ref?: Ref<ChatInputHandle>;
};
