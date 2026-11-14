import { View } from 'react-native';

import { palette } from '../theme/tokens';
import type { KeyboardAreaProps } from './KeyboardArea.types';

export type { KeyboardAreaProps } from './KeyboardArea.types';

// web 实现：没有软键盘遮挡，只是一个铺满的容器。原生实现见 KeyboardArea.native.tsx。
export function KeyboardArea({ children, bg, testID }: KeyboardAreaProps) {
  return (
    <View testID={testID} style={{ flex: 1, minWidth: 0, backgroundColor: bg ? palette[bg] : undefined }}>
      {children}
    </View>
  );
}
