// 2026-11-15 真机测量：工单详情首次渲染里，整篇任务说明的 Markdown 占了 178/275ms，画出来只露 6 行。
// 收着时只画开头的一段，按整行截。
import { describe, expect, it } from 'vitest';

import { briefHead } from './TicketDetailParts';

describe('the collapsed task brief', () => {
  it('keeps a short brief whole', () => {
    const brief = '目的：做一个原型。\n\n## 产出\n\n- 一个文件';
    expect(briefHead(brief)).toBe(brief);
  });

  it('cuts a long brief at a line boundary, enough to fill six lines', () => {
    const lines = Array.from({ length: 60 }, (_, index) => `- 第 ${index + 1} 条：${'很长的说明'.repeat(6)}`);
    const brief = lines.join('\n');
    const preview = briefHead(brief);
    expect(preview.length).toBeLessThan(brief.length);
    expect(preview.length).toBeLessThanOrEqual(480);
    expect(brief.startsWith(preview)).toBe(true);
    expect(preview.split('\n').every((line) => lines.includes(line))).toBe(true);
    expect(preview.split('\n').length).toBeGreaterThanOrEqual(6);
  });

  it('keeps at least the first line even when it is longer than the limit', () => {
    const first = 'x'.repeat(900);
    expect(briefHead(`${first}\nsecond`)).toBe(first);
  });
});
