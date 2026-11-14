import BottomSheet from '@expo/ui/community/bottom-sheet';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { palette } from '../theme/tokens';
import type { NativeSheetProps } from './NativeSheet.types';

export type { NativeSheetProps } from './NativeSheet.types';

// 正文最高占屏幕的七成，更多时在面板里滚动。
const MAX_BODY_SHARE = 0.7;

// 系统的底部面板（2026-11-12）：iOS 是 SwiftUI sheet，Android 是 Material 3 ModalBottomSheet（Expo UI）。
// 原来手机上是 React Native 的 Modal 整体滑上来：遮罩跟着面板一起滑，面板不能下拉关闭，也不跟手。
// 系统面板自带遮罩、拖动把手、下拉关闭、返回键和跟手的动画。
// 高度跟着内容走；调用方把 open 改成 false 时，面板先播关闭动画再卸载。
export function NativeSheet({ open, onClose, label, header, children, footer, testID }: NativeSheetProps) {
  const sheet = useRef<BottomSheet>(null);
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // shown：系统面板还在屏幕上。调用方关面板时 open 先变 false，面板播完关闭动画才算关上，
  // 所以 index 在这期间保持 0；直接给 -1 会让面板立刻消失，没有动画。
  const [shown, setShown] = useState(open);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (open) setShown(true);
    else if (shown) sheet.current?.close();
  }, [open, shown]);

  return (
    <BottomSheet
      ref={sheet}
      index={open || shown ? 0 : -1}
      enablePanDownToClose
      backgroundStyle={{ backgroundColor: palette.surface }}
      onClose={() => {
        setShown(false);
        // 调用方自己关的不用再通知一次；下拉、点遮罩、返回键关的要通知。
        if (openRef.current) onClose();
      }}
    >
      <View testID={testID} accessibilityLabel={label} accessibilityViewIsModal style={{ paddingBottom: insets.bottom }}>
        {header}
        <ScrollView style={{ maxHeight: height * MAX_BODY_SHARE }} testID={testID ? `${testID}-body` : undefined}>
          {children}
        </ScrollView>
        {footer}
      </View>
    </BottomSheet>
  );
}
