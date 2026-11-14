// 换行的行（flexWrap="wrap"）里，文字不写 flex、grow、shrink（2026-11-12、11-13，Android 上设置页的说明文字被挤成一个字宽的竖排）。
// 用 Yoga 复现过：文字带 grow 或 shrink 时，Yoga 把它留在第一行，跟旁边的文字抢宽度。Yoga 没有浏览器那种「最长的词」最小宽度，
// 文字就被挤到一个字宽。不带 flex 的文字按内容定宽，最宽到整行：放不下时整块换到下一行，再在自己那一行里折行，和浏览器一样。
// 要把后面的东西推到行尾，给它写 ml="auto"。web 上看不出来，所以用源码检查。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOTS = ['./', '../../../packages/components/src/'].map((path) => fileURLToPath(new URL(path, import.meta.url)));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.tsx') && !entry.name.includes('.test.') ? [path] : [];
  });
}

const indent = (line: string) => line.length - line.trimStart().length;

// 找出直接放在 flexWrap="wrap" 容器里、写了 flex、grow 或 shrink 的文字。按缩进找父节点：仓库的 JSX 都经过格式化。
export function flexTextsInWrapRows(source: string): number[] {
  const lines = source.split('\n');
  const found: number[] = [];
  lines.forEach((line, index) => {
    if (!/<Text\b[^>]*\b(?:flex|grow|shrink)=\{/.test(line)) return;
    for (let parent = index - 1; parent >= 0; parent -= 1) {
      const candidate = lines[parent]!;
      if (!candidate.trim() || indent(candidate) >= indent(line)) continue;
      if (/flexWrap="wrap"/.test(candidate)) found.push(index + 1);
      return;
    }
  });
  return found;
}

describe('flex text in wrapping rows', () => {
  it('finds the pattern that collapsed the settings hint on Android', () => {
    const old = [
      '<Row items="baseline" gap="inline-item" flexWrap="wrap">',
      '  <Text size="card-title" weight="bold">{title}</Text>',
      '  <Text flex={1} size="meta" tone="muted">{hint}</Text>',
      '</Row>',
    ].join('\n');
    expect(flexTextsInWrapRows(old)).toEqual([3]);
    // 2026-11-12 的第一次修复也不对：grow、shrink 同样让文字留在第一行被挤窄。
    expect(flexTextsInWrapRows(old.replace('flex={1}', 'grow={1} shrink={1} minW={0}'))).toEqual([3]);
    expect(flexTextsInWrapRows(old.replace(' flex={1}', ''))).toEqual([]);
  });

  it('has none left in the app or the component library', () => {
    const offenders = ROOTS.flatMap(sources).flatMap((file) =>
      flexTextsInWrapRows(readFileSync(file, 'utf8')).map((line) => `${file}:${line}`));
    expect(offenders).toEqual([]);
  });
});
