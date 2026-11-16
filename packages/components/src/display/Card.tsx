import { styled, View, type GetProps, type TamaguiElement } from '@tamagui/core';
import { createContext, forwardRef, useContext, type ReactNode } from 'react';

import { withDensity } from '../theme/density';
import { elevation } from '../theme/tokens';

// 卡片：白底、细边框、圆角。tone 给出提醒类卡片的浅色底和同色系边框。
// float：悬浮的卡片（主题 A-1、R-1、E-1，2026-11-14 方案 F）。白底、20 圆角、一档轻阴影，没有边框。会话里的卡片用它。
// 需要整张卡片可点时，给它 pressable、onPress 和 role="button"：pressable 带上手型光标和按下的反馈。
const CardFrame = styled(View, {
  displayName: 'Card',
  bg: 'surface',
  rounded: 'xl',
  borderWidth: 1,
  borderColor: 'border',
  variants: {
    variant: {
      outline: {},
      elevated: { borderWidth: 0, boxShadow: '0 1px 2px rgba(16,24,40,0.05)' },
      flat: { borderWidth: 0 },
      float: { borderWidth: 0, rounded: '5xl', boxShadow: elevation.float },
    },
    tone: {
      neutral: {},
      subtle: { bg: 'surface-subtle', borderColor: 'border-soft' },
      accent: { bg: 'accent-soft', borderColor: 'accent-soft' },
      success: { bg: 'success-surface', borderColor: 'success-border' },
      warning: { bg: 'warning-surface', borderColor: 'warning-border' },
      danger: { bg: 'danger-surface', borderColor: 'danger-border' },
    },
    pressable: {
      true: { cursor: 'pointer', opacity: { default: 1, press: 0.85 } },
    },
  } as const,
  defaultVariants: { variant: 'outline', tone: 'neutral' },
});

export type CardProps = GetProps<typeof CardFrame>;
// 语义间距按密度区域换值（theme/density.ts）。
const DensityCard = withDensity<CardProps, TamaguiElement>(CardFrame, { displayName: 'Card' });

// 一片区域里卡片的缺省样子（主题 A-1，2026-11-14 方案 F）：手机上的设置页、二级页面里，卡片缺省是悬浮的。
// 只换缺省值：写了 variant 的卡片照写的来（例如卡片里面的框写 flat）。
const CardDefault = createContext<CardProps['variant']>(undefined);

export function CardDefaults({ variant, children }: { variant: NonNullable<CardProps['variant']>; children: ReactNode }) {
  return <CardDefault.Provider value={variant}>{children}</CardDefault.Provider>;
}

export const Card = forwardRef<TamaguiElement, CardProps>(function Card({ variant, ...props }, ref) {
  const fallback = useContext(CardDefault);
  // 悬浮的卡片不带细边框：调用方写的 borderWidth / borderColor 只在原来的细边框卡片上生效。
  const resolved = variant ?? fallback;
  const floating = resolved === 'float';
  const { borderWidth, borderColor, rounded, ...rest } = props as CardProps & { rounded?: CardProps['rounded'] };
  // 只传调用方写了的值：显式的 undefined 会盖掉 1px 和 border 色，web 上退回 3px 的文字色边框（2026-11-16 回归）。
  return (
    <DensityCard
      ref={ref}
      variant={resolved}
      {...rest}
      {...(floating || borderWidth === undefined ? {} : { borderWidth })}
      {...(floating || borderColor === undefined ? {} : { borderColor })}
      {...(floating && variant === undefined ? {} : rounded !== undefined ? { rounded } : {})}
    />
  );
});

// 加载中的占位块。
export const Skeleton = styled(View, {
  displayName: 'Skeleton',
  bg: 'surface-muted',
  rounded: 'md',
});

export type SkeletonProps = GetProps<typeof Skeleton>;
