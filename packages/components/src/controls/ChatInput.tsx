import { useEffect, useEffectEvent, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { TextInput, type NativeSyntheticEvent, type TextInputKeyPressEventData, type TextStyle } from 'react-native';

import { fontFaces, palette, textLeading, textSizes } from '../theme/tokens';
import type { ChatInputProps } from './ChatInput.types';

export type { ChatInputHandle, ChatInputProps } from './ChatInput.types';

// 规格：文字和会话正文一样（message-body，14/24）。最少一行，最多 8 行（192 像素），再多就在框里滚动。
const LINE = textLeading['message-body'];
const MAX_LINES = 8;
const MAX_HEIGHT = LINE * MAX_LINES;

// 浏览器给获得焦点的输入框画的外框。外框由调用方的卡片表达，所以去掉。RN 的类型里没有这些 web 专有值。
const webOnly = { outlineStyle: 'none', resize: 'none' } as unknown as TextStyle;

// web 实现：react-native-web 的多行 TextInput（一个 textarea）。原生实现见 ChatInput.native.tsx。
export function ChatInput({
  value, onChangeText, placeholder, disabled = false, onSubmit, onPasteFiles, onBlur, autoFocus, large = false, testID, accessibilityLabel, ref,
}: ChatInputProps) {
  const inputRef = useRef<TextInput>(null);
  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

  // 自动长高：在一个看不见的影子 textarea 里量出内容要多高（measureContentHeight），再设给输入框。超过上限时固定在上限，
  // 出现滚动条。窗口宽度变了，折行跟着变，再量一次。
  // 工单 #264：不能把输入框自己的高度先清零再量。清零那一刻输入框变成一行高，会话列表的可视区跟着变高，
  // 浏览器把贴底的 scrollTop 夹小；高度设回去以后 scrollTop 不回来，列表往下掉一截，最后一条被输入框盖住。
  // 高度只在真的变了时才写：变了的那一次，列表在同一帧里跟着贴底（Legend List 的 maintainScrollAtEnd）。
  const shadowRef = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const node = textareaOf(inputRef.current);
    if (!node) return;
    const fit = () => {
      const content = measureContentHeight(node, shadowRef);
      const height = `${Math.min(Math.max(content, LINE), MAX_HEIGHT)}px`;
      if (node.style.height !== height) node.style.height = height;
      const overflow = content > MAX_HEIGHT ? 'auto' : 'hidden';
      if (node.style.overflowY !== overflow) node.style.overflowY = overflow;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [value]);

  useEffect(() => () => {
    shadowRef.current?.remove();
    shadowRef.current = null;
  }, []);

  const paste = useEffectEvent((event: ClipboardEvent) => {
    if (!onPasteFiles || disabled) return;
    const data = event.clipboardData;
    // 剪贴板里有文字（例如从 Excel、Word 复制的内容同时带着一张图）：照常粘贴文字。
    if (!data || data.getData('text/plain')) return;
    const files = imageFiles(data);
    if (!files.length) return;
    event.preventDefault();
    onPasteFiles(files);
  });

  useEffect(() => {
    const node = textareaOf(inputRef.current);
    if (!node) return;
    const listener = (event: ClipboardEvent) => paste(event);
    node.addEventListener('paste', listener);
    return () => node.removeEventListener('paste', listener);
  }, []);

  // Enter 发送，Shift+Enter 换行。输入法正在组字时（isComposing；Safari 在组字结束的那次按键上给 keyCode 229）的 Enter
  // 是确认候选词，不发送。react-native-web 先调 onKeyPress：这里 preventDefault 以后它不再插入换行。
  const keyPress = (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    const key = event.nativeEvent as unknown as KeyboardEvent;
    if (key.key !== 'Enter' || key.shiftKey || key.isComposing || key.keyCode === 229) return;
    (event as unknown as { preventDefault: () => void }).preventDefault();
    if (!disabled) onSubmit?.();
  };

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
      numberOfLines={1}
      autoFocus={autoFocus}
      onKeyPress={keyPress}
      onBlur={onBlur}
      style={{
        width: '100%',
        minHeight: LINE,
        maxHeight: MAX_HEIGHT,
        padding: 0,
        borderWidth: 0,
        backgroundColor: 'transparent',
        ...webOnly,
        color: palette.text,
        fontFamily: fontFaces.regular,
        fontSize: textSizes[large ? 'message-lead' : 'message-body'],
        lineHeight: LINE,
      }}
    />
  );
}

// 影子 textarea 照抄这些决定折行和行高的样式（宽度、字体、内边距、边框）。
const SIZING_STYLES = [
  'boxSizing', 'width', 'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'letterSpacing', 'lineHeight', 'textIndent',
  'textTransform', 'textRendering', 'wordSpacing', 'wordBreak', 'overflowWrap', 'whiteSpace', 'tabSize',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle',
] as const;

// 输入框的内容要多高。在挂在 body 上的一个影子 textarea 里量：它不占位置、看不见，量它不改动页面上任何东西的大小。
// 影子用同样的样式和同样的文字，高度是 0，scrollHeight 就是内容的高度（末尾的空行也算）。
function measureContentHeight(node: HTMLTextAreaElement, shadowRef: { current: HTMLTextAreaElement | null }): number {
  let shadow = shadowRef.current;
  if (!shadow || !shadow.isConnected) {
    shadow = document.createElement('textarea');
    shadow.setAttribute('aria-hidden', 'true');
    shadow.tabIndex = -1;
    shadow.readOnly = true;
    Object.assign(shadow.style, {
      position: 'absolute', top: '0', left: '0', zIndex: '-1000', visibility: 'hidden', pointerEvents: 'none',
      height: '0', minHeight: '0', maxHeight: 'none', overflow: 'hidden', margin: '0', resize: 'none',
    });
    document.body.appendChild(shadow);
    shadowRef.current = shadow;
  }
  const computed = window.getComputedStyle(node);
  for (const name of SIZING_STYLES) shadow.style[name] = computed[name];
  // 空的时候量提示文字：提示折行时输入框也跟着高。不给影子设 placeholder 属性，免得按提示文字找输入框时找到两个。
  shadow.value = node.value || node.placeholder;
  return shadow.scrollHeight;
}

// react-native-web 的 TextInput 的 ref 就是它的 textarea 元素。
function textareaOf(input: TextInput | null): HTMLTextAreaElement | null {
  const node = input as unknown as HTMLTextAreaElement | null;
  return node && typeof node.addEventListener === 'function' && 'scrollHeight' in node ? node : null;
}

function imageFiles(data: DataTransfer): Blob[] {
  const fromItems = Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .flatMap((item) => {
      const file = item.getAsFile();
      return file ? [file] : [];
    });
  if (fromItems.length) return fromItems;
  return Array.from(data.files ?? []).filter((file) => file.type.startsWith('image/'));
}
