import type { KeyboardEvent, ReactNode, Ref } from 'react';

// 钉在视口某个位置上的一层（web 上画到 body 的最上层，position: fixed；原生上不画）。
// 用在 web 的选字回复上：选区上的「回复」按钮、悬停的提示、引用浮层（设计规范 P17、主题 Q-1–Q-3）。
// 不占会话列表的位置，列表不变高（P1）。
export type ViewportOverlayProps = {
  // 视口坐标：top、left 是这一层的左上角；centerX 为 true 时 left 是这一层的水平中线。
  top: number;
  left: number;
  centerX?: boolean;
  width?: number;
  // 浮起的一档阴影和 xl 圆角（主题 E-2），给浮层用。
  raised?: boolean;
  // 不接鼠标（提示）。
  passThrough?: boolean;
  // 按下鼠标时不抢走页面上的选区（「回复」按钮）。
  keepSelection?: boolean;
  role?: 'dialog';
  label?: string;
  testID?: string;
  onKeyDownCapture?: (event: KeyboardEvent<HTMLDivElement>) => void;
  nodeRef?: Ref<HTMLDivElement>;
  children: ReactNode;
};

export function ViewportOverlay(_props: ViewportOverlayProps) {
  return null;
}
