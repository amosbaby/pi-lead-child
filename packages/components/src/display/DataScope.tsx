import type { ReactNode } from 'react';

// 给页面上的一段标记数据属性（web 上是一个 display: contents 的 div，带 data-*；原生上什么都不加）。
// 应用用它在 DOM 里认出一段内容，例如选字回复认出这段字属于哪一条消息（设计规范 P17）。不影响排版。
export type DataScopeProps = {
  // 不带 data- 前缀的名字和值，例如 { 'quote-key': 'turn:t1:assistant' } 画成 data-quote-key="turn:t1:assistant"。
  data: Readonly<Record<string, string>>;
  children: ReactNode;
};

export function DataScope({ children }: DataScopeProps) {
  return <>{children}</>;
}
