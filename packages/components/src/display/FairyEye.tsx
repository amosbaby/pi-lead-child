import { useMemo } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, { cubicBezier, steps, useReducedMotion, type CSSAnimationKeyframes } from 'react-native-reanimated';

import {
  FAIRY_BOX,
  FAIRY_CENTER,
  fairyBreathRange,
  fairyDepth,
  fairyGeometry,
  fairyLayerScale,
  fairyLayers,
  fairyMotion,
  fairyPalettes,
  fairyQuarterTurnMs,
  type FairyEyeState,
  type FairyEyeTone,
  type FairyLayer,
} from './FairyEye.shared';
import { useMessages } from '../i18n';
import { displayMessages } from './display.messages';
import { useAppActive, useOverlayOpen } from './overlayPresence';

export type { FairyEyeState, FairyEyeTone } from './FairyEye.shared';

export type FairyEyeProps = {
  // 边长。左栏头部 32，消息头 18（主题 F-4、F-5）。
  size?: number;
  // idle：只转。thinking：转得快，中间的圈呼吸（M-7、M-8）。
  state?: FairyEyeState;
  // color 会动；muted、quiet 静止（F-1 到 F-3）。
  tone?: FairyEyeTone;
  // 无障碍标签。缺省是「Fairy」，思考时加「在想」。调用方传 Lead 的名字。
  name?: string;
  // 调用方知道它看不见时（例如所在的页面被别的页面盖住）传 true，动画暂停。
  paused?: boolean;
  testID?: string;
};

// 方块转 90 度的关键帧：线性、无限循环。
const TURN: CSSAnimationKeyframes = {
  from: { transform: [{ rotate: '0deg' }] },
  to: { transform: [{ rotate: '90deg' }] },
};
// 空闲时转动的一步多长（毫秒）：一秒 10 步。
const IDLE_STEP_MS = 100;
// 呼吸一次的一半（张开 → 缩到最小），来回播（alternate），每一半都按原图的曲线走。
const breathEasing = cubicBezier(...fairyMotion.bezier);

// Fairy 的形象（P12.8，主题 11.12）：蓝色圆盘、会转的深色方块、四层眼睛、右下角的高光。全部用 View 画，三端同一份。
// 动效用 Reanimated 的 CSS 动画（2026-11-14）：原生上由 UI 线程里的原生代码驱动，每帧不跑 JS 也不跑 worklet；
// web 上就是浏览器的 CSS 关键帧。以前用逐帧回调，每帧算一次角度、改六个样式，空闲时 UI 线程占用三到四成。
//   空闲：只有方块慢慢转（24 秒一圈），眼睛不动。思考：方块 8 秒一圈，四层眼睛 1.5 秒呼吸一次，瞳孔先缩、外层依次跟上。
//   转动的那一层缓存成一张纹理（Android 硬件纹理、iOS 栅格化）：转的时候只转这张图，不重画里面。
//   减弱动态效果：不转，不呼吸；思考时瞳孔停在缩小的位置。
// 规格（形状、颜色、节奏、出处）在 FairyEye.shared.ts。
export function FairyEye({ size = 18, state = 'idle', tone = 'color', name = 'Fairy', paused = false, testID }: FairyEyeProps) {
  const m = useMessages(displayMessages);
  const reduced = useReducedMotion();
  const palette = fairyPalettes[tone];
  const moving = tone === 'color' && !reduced;
  const thinking = state === 'thinking' && tone === 'color';
  const breathing = thinking && moving;
  const depth = fairyDepth(size);
  const quarterTurnMs = fairyQuarterTurnMs(state, moving);
  // 看不见时暂停（2026-11-14 用户：只加不可见时暂停）：应用在后台或锁屏、页面被面板或抽屉盖住、调用方说看不见。
  // 暂停的是 CSS 动画本身，恢复时从停下的地方接着转，不跳。
  const appActive = useAppActive();
  const covered = useOverlayOpen();
  const playState = paused || covered || !appActive ? ('paused' as const) : ('running' as const);

  // 空闲时分步转：每次跳 1.5 度，一秒只更新 10 次。只要有东西在逐帧动，整个窗口每一帧都要重新合成；
  // 这台 120Hz 的手机上，平滑的慢转让 UI 线程和渲染线程加起来占掉大半个核（2026-11-14 真机量过，去掉阴影也一样）。
  // 24 秒一圈的慢转，分步和平滑肉眼看不出差别。思考时转得快，照旧平滑。
  // 应用和组件库的类型检查对 CSS 动画属性的推断不一样（时间单位的联合类型），这里按 ViewStyle 交给 Animated.View。
  const cornersStyle = (quarterTurnMs > 0
    ? {
        animationName: TURN,
        animationDuration: quarterTurnMs,
        animationIterationCount: 'infinite' as const,
        animationTimingFunction: thinking ? ('linear' as const) : steps(Math.round(quarterTurnMs / IDLE_STEP_MS)),
        animationPlayState: playState,
      }
    : null) as ViewStyle | null;
  // 减弱动态效果时，思考中的瞳孔停在缩小的位置；不思考时张开。
  const hold = thinking && !moving ? fairyMotion.reducedHold : 0;
  const layerStyle = (layer: FairyLayer) => (breathing ? { ...breathStyle(layer, depth), animationPlayState: playState } : { transform: [{ scale: fairyLayerScale(layer, 0, 1, depth, hold) }] });

  const shapes = useMemo(() => fairyShapes(size), [size]);
  return (
    <View
      testID={testID}
      role="img"
      aria-label={thinking ? m.thinking(name) : name}
      pointerEvents="none"
      style={{ width: size, height: size, flexShrink: 0 }}
    >
      <View style={[shapes.disc, { backgroundColor: palette.disc }]} />
      <Animated.View style={[StyleSheet.absoluteFill, cornersStyle]} renderToHardwareTextureAndroid shouldRasterizeIOS>
        <View style={[shapes.cornersCircle, { backgroundColor: palette.corners }]} />
        <View style={[shapes.cornersSquare, { backgroundColor: palette.corners }]} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, layerStyle('sclera')]}>
        <View style={[shapes.sclera, { backgroundColor: palette.sclera }]} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, layerStyle('irisOuter')]}>
        <View style={[shapes.irisOuter, { backgroundColor: palette.irisOuter }]} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, layerStyle('iris')]}>
        <View style={[shapes.irisRing, { backgroundColor: palette.sclera }]} />
        <View style={[shapes.iris, { backgroundColor: palette.iris }]} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, layerStyle('pupil')]}>
        <View style={[shapes.pupil, { backgroundColor: palette.pupil }]} />
      </Animated.View>
      {/* 高光和蓝色虹膜同一个相位（原图如此），画在瞳孔上面。 */}
      <Animated.View style={[StyleSheet.absoluteFill, layerStyle('iris')]}>
        <View style={[shapes.highlightHalo, { backgroundColor: palette.highlight, opacity: 0.35 }]} />
        <View style={[shapes.highlight, { backgroundColor: palette.highlight }]} />
      </Animated.View>
    </View>
  );
}

// 一层眼睛的呼吸：在张开和缩到最小之间来回，半次 750 毫秒；外层的相位落后一点（负的延迟让它从中途开始）。
function breathStyle(layer: FairyLayer, depth: number) {
  const { expanded, contracted } = fairyBreathRange(layer, depth);
  const half = fairyMotion.breathMs / 2;
  return {
    animationName: { from: { transform: [{ scale: expanded }] }, to: { transform: [{ scale: contracted }] } } satisfies CSSAnimationKeyframes,
    animationDuration: half,
    animationDirection: 'alternate' as const,
    animationIterationCount: 'infinite' as const,
    animationTimingFunction: breathEasing,
    animationDelay: -fairyLayers[layer].lead * fairyMotion.breathMs,
  };
}

// 一个圆：直径和圆心（盒子的单位）换成像素。
function circle(size: number, diameter: number, dx = 0, dy = 0): ViewStyle {
  const unit = size / FAIRY_BOX;
  const d = diameter * unit;
  return {
    position: 'absolute',
    width: d,
    height: d,
    borderRadius: d / 2,
    left: (FAIRY_CENTER + dx) * unit - d / 2,
    top: (FAIRY_CENTER + dy) * unit - d / 2,
  };
}

function fairyShapes(size: number) {
  const g = fairyGeometry;
  const unit = size / FAIRY_BOX;
  const side = g.cornersSquare * unit;
  return {
    disc: circle(size, g.disc),
    cornersCircle: circle(size, g.cornersCircle),
    cornersSquare: {
      position: 'absolute',
      width: side,
      height: side,
      borderRadius: 2 * unit,
      left: FAIRY_CENTER * unit - side / 2,
      top: FAIRY_CENTER * unit - side / 2,
      transform: [{ rotate: `${g.cornersSquareTilt}deg` }],
    } satisfies ViewStyle,
    sclera: circle(size, g.sclera),
    irisOuter: circle(size, g.irisOuter),
    irisRing: circle(size, g.irisRing),
    iris: circle(size, g.iris),
    pupil: circle(size, g.pupil),
    highlightHalo: circle(size, g.highlightHalo, g.highlightOffset.x, g.highlightOffset.y),
    highlight: circle(size, g.highlight, g.highlightOffset.x, g.highlightOffset.y),
  };
}
