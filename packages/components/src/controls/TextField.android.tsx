import { TamaguiTextField } from './TextField.tamagui';
import type { TextFieldProps } from './TextField.types';

export type { TextFieldProps, TextFieldSize, TextFieldVariant } from './TextField.types';

// Android 实现：Tamagui 外框加 React Native 的 TextInput，见 TextField.tamagui.tsx。iOS 见 TextField.native.tsx。
export function TextField(props: TextFieldProps) {
  return <TamaguiTextField {...props} />;
}
