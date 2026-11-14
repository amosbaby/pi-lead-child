import { useImperativeHandle, useRef } from 'react';
import { TextInput } from 'react-native';

import { fontFaces, palette, textLeading, textSizes } from '../theme/tokens';
import type { ChatInputProps } from './ChatInput.types';

export type { ChatInputHandle, ChatInputProps } from './ChatInput.types';

// 和 web 一样：文字是 message-body（14/24），最少一行，最多 8 行，再多就在框里滚动。
const LINE = textLeading['message-body'];
const MAX_HEIGHT = LINE * 8;

// Android 实现：React Native 的多行 TextInput（系统的 EditText），随内容长高。iOS 见 ChatInput.native.tsx。
// 不用 Compose 的输入框（2026-11-13）：它不认 style 里的尺寸，和外面卡片的内边距对不齐。
// 键盘的回车换行，发送用旁边的按钮，所以不接 onSubmit；原生上也没有粘贴图片（onPasteFiles 不调）。
export function ChatInput({ value, onChangeText, placeholder, disabled = false, onBlur, autoFocus, testID, accessibilityLabel, ref }: ChatInputProps) {
  const inputRef = useRef<TextInput>(null);
  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);
  return (
    <TextInput
      ref={inputRef}
      testID={testID}
      aria-label={accessibilityLabel ?? placeholder}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={palette['text-muted']}
      editable={!disabled}
      multiline
      autoFocus={autoFocus}
      onBlur={onBlur}
      style={{
        alignSelf: 'stretch',
        minHeight: LINE,
        maxHeight: MAX_HEIGHT,
        padding: 0,
        backgroundColor: 'transparent',
        fontFamily: fontFaces.regular,
        fontSize: textSizes['message-body'],
        lineHeight: LINE,
        color: palette.text,
        textAlignVertical: 'top',
        includeFontPadding: false,
      }}
    />
  );
}
