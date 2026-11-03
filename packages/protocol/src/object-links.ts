// 会话文字里指向一个对象的链接（设计规范 P14.6–P14.8，2026-11-02）。
// Lead 不把系统内部的编号写给用户看（「Run #217」「卡 #134」），而是写人能懂的称呼，再把它写成 Markdown 链接：
//   [Ethan 的私信](plc:card/134)   点了在浮层里打开那张外来消息卡
//   [#165](plc:ticket/165)         点了打开工单详情（提醒打开日程）
// App 认这种地址；plc、Slack、推送通知显示不了，发出去之前用 plainObjectLinks 换成链接的文字。
export type ObjectLinkTarget = { kind: "ticket"; id: number } | { kind: "card"; id: number };

const LINK_HREF = /^plc:(ticket|card)\/([1-9]\d{0,9})$/u;
// Markdown 里的 [文字](plc:…)。文字里不能有方括号，和 Markdown 自己的规则一致。
const LINK_IN_MARKDOWN = /\[([^\]\n]*)\]\(\s*plc:[^)\s]*\s*\)/gu;

export function objectLinkHref(target: ObjectLinkTarget): string {
  return `plc:${target.kind}/${target.id}`;
}

// 不是这两种地址时返回 null（包括别的 plc: 地址）。
export function parseObjectLink(href: string | null | undefined): ObjectLinkTarget | null {
  const match = href ? LINK_HREF.exec(href.trim()) : null;
  if (!match) return null;
  return { kind: match[1] as ObjectLinkTarget["kind"], id: Number(match[2]) };
}

// 把文字里的对象链接换成链接的文字：[Ethan 的私信](plc:card/134) → Ethan 的私信。别的链接不动。
export function plainObjectLinks(markdown: string): string {
  return markdown.replace(LINK_IN_MARKDOWN, (_whole, label: string) => label);
}
