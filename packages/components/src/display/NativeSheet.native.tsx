import { View } from 'react-native';

import { FloatingSheet } from './FloatingSheet';
import type { NativeSheetProps } from './NativeSheet.types';

export type { NativeSheetProps } from './NativeSheet.types';

// 手机上从会话里点开的面板（P13.2，2026-11-14 用户定）：iOS 和 Android 用同一种悬浮底部面板（FloatingSheet），
// 不再用系统的贴边面板。Sheet、Popover、AnchoredPanel 在手机宽度时都走这里，所以会话里点开的卡片都是这一种。
// 标题行和正文一起在内容区里；footer 是钉在底部的操作条。
export function NativeSheet({ open, onClose, label, header, children, footer, tall, testID }: NativeSheetProps) {
  return (
    <FloatingSheet testID={testID} open={open} onClose={onClose} label={label} footer={footer} tall={tall} inset="menu">
      <View accessibilityLabel={label}>
        {header}
        {children}
      </View>
    </FloatingSheet>
  );
}
