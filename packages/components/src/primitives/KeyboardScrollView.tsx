import { ScrollView } from 'react-native';

import type { KeyboardScrollViewProps } from './KeyboardScrollView.types';

// web 实现：没有软键盘遮挡，就是普通的 ScrollView。原生实现见 KeyboardScrollView.native.tsx。
export function KeyboardScrollView(props: KeyboardScrollViewProps) {
  return <ScrollView {...props} />;
}
