import type { NativeSheetProps } from './NativeSheet.types';

export type { NativeSheetProps } from './NativeSheet.types';

// web 没有系统的底部面板：Sheet、AnchoredPanel 和 PopoverPanel 在 web 上用自己画的面板，不会走到这里。
// 原生实现见 NativeSheet.native.tsx。
export function NativeSheet(_props: NativeSheetProps) {
  return null;
}
