import { Text, type FontSizeToken, type TextProps } from '@pi-lead-child/components';
import type { ObjectLinkTarget } from '@pi-lead-child/protocol';
import { createContext, useContext, type ReactNode } from 'react';

// 会话文字里指向对象的链接（设计规范 P14.6–P14.8，2026-11-02）：Lead 写「[Ethan 的私信](plc:card/134)」，
// 用户看到的是一段可以点的文字，不是「卡 #134」。
// 这里只决定画不画成链接；链接本身（读工单和卡、打开浮层）由 ObjectLinkProvider 给。
// 这样 MarkdownMessage 不依赖应用的状态：没有 provider 时（例如单独测一段 Markdown），链接只显示文字。

export type ObjectLinkProps = {
  target: ObjectLinkTarget;
  text: string;
  size: FontSizeToken;
  weight?: TextProps['weight'];
  italic?: boolean;
};

export const ObjectLinkRenderer = createContext<((props: ObjectLinkProps) => ReactNode) | null>(null);
// 这段 Markdown 认不认对象链接。MarkdownMessage 按它的 objectLinks 设：外来的原文（Slack 消息）里别人写的链接，
// 不该带用户去 App 里的东西。
export const ObjectLinksAllowed = createContext(true);

export function ObjectLink(props: ObjectLinkProps) {
  const allowed = useContext(ObjectLinksAllowed);
  const render = useContext(ObjectLinkRenderer);
  if (!allowed || !render) return <ObjectLinkText {...props} />;
  return <>{render(props)}</>;
}

// 取不到对象时的样子：只有链接的文字（P14.8）。
export function ObjectLinkText({ text, size, weight, italic }: ObjectLinkProps) {
  return <Text size={size} weight={weight} italic={italic}>{text}</Text>;
}
