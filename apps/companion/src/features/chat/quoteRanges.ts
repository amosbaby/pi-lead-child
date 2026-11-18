// web：在画出来的原文里找回一段引用的位置（原文上的标记、跳回原文时闪一下，主题 Q-3、Q-9）。
// 画出来的字和选区的字不完全一样（段落之间的换行、列表的圆点），所以只比字母和数字（和 chatQuoteMatchKey 同一个规则）：
// 把容器里每个字母、数字记下它在哪个文字节点的哪个位置，在这串字里找引用，再换回 DOM 的 Range。
// occurrence：同一段字在来源里出现了好几次时，是第几次（从 0 开始）。选字时记下（occurrenceOfRange），存在引用的 anchor 里。

interface Indexed {
  key: string;
  nodes: Text[];
  offsets: number[];
}

const KEY_CHAR = /[\p{L}\p{N}]/u;

function indexText(container: Element): Indexed {
  const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let key = '';
  const nodes: Text[] = [];
  const offsets: number[] = [];
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const text = node.data;
    let index = 0;
    for (const char of text) {
      const folded = char.normalize('NFKC').toLowerCase();
      for (const piece of folded) {
        if (!KEY_CHAR.test(piece)) continue;
        key += piece;
        nodes.push(node);
        offsets.push(index);
      }
      index += char.length;
    }
  }
  return { key, nodes, offsets };
}

function keyOf(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  if (!needle) return found;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) found.push(at);
  return found;
}

export function findQuoteRange(container: Element, text: string, occurrence = 0): Range | null {
  const indexed = indexText(container);
  const needle = keyOf(text);
  const starts = occurrences(indexed.key, needle);
  const start = starts[Math.min(occurrence, starts.length - 1)];
  if (start === undefined) return null;
  const end = start + needle.length - 1;
  const range = container.ownerDocument.createRange();
  const endNode = indexed.nodes[end]!;
  const endOffset = indexed.offsets[end]!;
  range.setStart(indexed.nodes[start]!, indexed.offsets[start]!);
  // 结束位置在最后一个字之后：按那个字在节点里占几个 UTF-16 单位算。
  const endChar = String.fromCodePoint(endNode.data.codePointAt(endOffset) ?? 0);
  range.setEnd(endNode, endOffset + endChar.length);
  return range;
}

// 选区是这段字在容器里的第几次出现。
export function occurrenceOfRange(container: Element, range: Range, text: string): number {
  const needle = keyOf(text);
  if (!needle) return 0;
  const before = container.ownerDocument.createRange();
  before.setStart(container, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const prefix = keyOf(before.toString());
  return occurrences(indexText(container).key, needle).filter((at) => at < prefix.length).length;
}

export function anchorOfOccurrence(occurrence: number): string {
  return `n:${occurrence}`;
}

export function occurrenceOfAnchor(anchor: string | undefined): number {
  const match = /^n:(\d+)$/u.exec(anchor ?? '');
  return match ? Number(match[1]) : 0;
}
