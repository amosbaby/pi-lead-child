import type { ReactNode } from 'react';

import { Pressable } from '../primitives/Pressable';
import { elevation } from '../theme/tokens';

export type FloatingButtonProps = {
  /** 读屏的说法，例如「Fairy，打开菜单」。 */
  label: string;
  onPress: () => void;
  /** 圆钮里的内容：Lead 的形象、图标。 */
  children: ReactNode;
  testID?: string;
};

// 悬浮圆钮（主题 H-3，2026-11-14 方案 F）：直径 48，白底，一档轻阴影，没有边框。按下时缩到 0.96（M-4）。
// 手机首页左上角的 Lead 形象、右上角的「等你」都用它。三端同一份：Tamagui 渲染，原生上的阴影由系统画。
const SIZE = 48; // 组件规格

export function FloatingButton({ label, onPress, children, testID }: FloatingButtonProps) {
  return (
    <Pressable
      testID={testID}
      aria-label={label}
      onPress={onPress}
      feedback="none"
      w={SIZE}
      h={SIZE}
      shrink={0}
      rounded="full"
      bg="surface"
      boxShadow={elevation.float}
      items="center"
      justify="center"
      scale={{ default: 1, press: 0.96 }}
      transition="quick"
    >
      {children}
    </Pressable>
  );
}
