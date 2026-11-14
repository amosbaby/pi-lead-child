import { TamaguiSegmentedControl } from './SegmentedControl.tamagui';
import type { SegmentedControlProps } from './SegmentedControl.types';

export type { SegmentedControlProps, SegmentedOption } from './SegmentedControl.types';

// Android 实现：Tamagui 渲染，见 SegmentedControl.tamagui.tsx。iOS 见 SegmentedControl.native.tsx。
export function SegmentedControl<T extends string>(props: SegmentedControlProps<T>) {
  return <TamaguiSegmentedControl {...props} />;
}
