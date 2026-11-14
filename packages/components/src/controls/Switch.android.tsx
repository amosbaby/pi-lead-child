import { Host, Switch as ExpoSwitch } from '@expo/ui';
import { View } from '@tamagui/core';

import { Text } from '../primitives/Text';
import { palette } from '../theme/tokens';
import type { SwitchProps } from './Switch.types';

export type { SwitchProps } from './Switch.types';

// Android 实现：Compose Switch（Expo UI），标签由我们自己的 Text 画在旁边。
// 不能把 label 交给 Expo UI（2026-11-14，打开消息渠道页 app 直接退出）：Expo UI 57.0.25 带标签的 Switch 用 width(IntrinsicSize.Max)
// 包一层 Row，传给原生的是字符串 'max'，而 Expo Go 里原生的 width 修饰符只收整数，抛 ClassCastException，整个 app 退出。
export function Switch({ value, onValueChange, label, disabled = false, testID }: SwitchProps) {
  const toggle = (
    <Host matchContents seedColor={palette.accent}>
      <ExpoSwitch value={value} onValueChange={onValueChange} disabled={disabled} testID={testID} />
    </Host>
  );
  if (!label) return toggle;
  return (
    <View flexDirection="row" items="center" gap="side-item" opacity={disabled ? 0.5 : 1}>
      {toggle}
      <Text size="label" weight="medium">{label}</Text>
    </View>
  );
}
