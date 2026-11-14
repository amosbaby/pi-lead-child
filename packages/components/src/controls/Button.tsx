import { TamaguiButton, TamaguiIconButton } from './Button.tamagui';
import type { ButtonProps, IconButtonProps } from './Button.types';

export type { ButtonProps, ButtonSize, ButtonTone, ButtonVariant, IconButtonProps } from './Button.types';

// web 实现：Tamagui 渲染，见 Button.tamagui.tsx。iOS 见 Button.native.tsx。
export function Button(props: ButtonProps) {
  return <TamaguiButton {...props} />;
}

export function IconButton(props: IconButtonProps) {
  return <TamaguiIconButton {...props} />;
}
