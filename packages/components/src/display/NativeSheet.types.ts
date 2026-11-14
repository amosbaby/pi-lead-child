import type { ReactNode } from 'react';

export type NativeSheetProps = {
  /** 是否打开。组件不存这个状态。 */
  open: boolean;
  /** 下拉、点遮罩、按返回键关闭以后调用（关闭动画播完）。 */
  onClose: () => void;
  /** 给读屏的面板名字。 */
  label: string;
  /** 面板最上面的一行（标题、关闭按钮），不随正文滚动。 */
  header?: ReactNode;
  /** 正文。比面板高时在面板里滚动。 */
  children?: ReactNode;
  /** 面板底部，例如取消和应用按钮。不随正文滚动。 */
  footer?: ReactNode;
  testID?: string;
};
