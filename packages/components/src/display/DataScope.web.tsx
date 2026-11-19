import type { DataScopeProps } from './DataScope';

export type { DataScopeProps } from './DataScope';

// web：display: contents 的 div，带 data-* 属性，不影响排版。
export function DataScope({ data, children }: DataScopeProps) {
  const attributes = Object.fromEntries(Object.entries(data).map(([name, value]) => [`data-${name}`, value]));
  return <div {...attributes} style={{ display: 'contents' }}>{children}</div>;
}
