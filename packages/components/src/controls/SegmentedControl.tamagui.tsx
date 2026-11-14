import { View } from '@tamagui/core';

import { Text } from '../primitives/Text';
import type { SegmentedControlProps } from './SegmentedControl.types';

// Tamagui 实现：浅灰轨道上的白色选中块。web（SegmentedControl.tsx）和 Android（SegmentedControl.android.tsx）都用它；
// iOS 用 UISegmentedControl（SegmentedControl.native.tsx）。Android 不用 Compose SegmentedButton（2026-11-12）：
// 它按系统字号和对勾排版，放进固定高度时英文标签被折成两行。
export function TamaguiSegmentedControl<T extends string>({
  options, value, onChange, size = 'md', testID, optionTestID,
}: SegmentedControlProps<T>) {
  const height = size === 'md' ? 32 : 28;
  return (
    // spacing-exempt: 轨道内边距和段间距是控件自己的规格
    <View testID={testID} role="tablist" flexDirection="row" gap={2} p={3} rounded="lg" bg="surface-muted">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <View
            key={option.value}
            testID={optionTestID?.(option.value)}
            role="tab"
            aria-selected={selected}
            // 每一段从自己文字的宽度起长，平分剩下的宽度（2026-11-01）：英文的标签长短不一，等宽会把长的截断。
            grow={1}
            shrink={1}
            // 每一段自带左右留白，控件不靠父容器撑宽也有形状（2026-10-23）。2026-11-01 收窄到 8：工作台侧栏 272 宽，要放得下四段英文。
            px={8} // spacing-exempt: 控件自己的规格
            minH={height}
            h={height}
            rounded={9}
            items="center"
            justify="center"
            cursor="pointer"
            bg={selected ? 'surface' : 'transparent'}
            // 没选中时不写 boxShadow：原生端 Tamagui 把 'none' 当颜色解析，报「unknown color "none"」（2026-11-13）。
            {...(selected ? { boxShadow: '0 1px 2px rgba(16,24,40,0.08)' } : {})}
            onPress={() => onChange(option.value)}
          >
            <Text
              size={size === 'md' ? '13' : '12'}
              weight={selected ? 'extrabold' : 'bold'}
              tone={selected ? 'default' : 'secondary'}
              align="center"
              numberOfLines={1}
            >
              {option.label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
