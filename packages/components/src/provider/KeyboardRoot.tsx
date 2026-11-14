import type { KeyboardRootProps } from './KeyboardRoot.types';

export type { KeyboardRootProps } from './KeyboardRoot.types';

// web 实现：没有软键盘，什么都不加。原生实现见 KeyboardRoot.native.tsx。
export function KeyboardRoot({ children }: KeyboardRootProps) {
  return <>{children}</>;
}
