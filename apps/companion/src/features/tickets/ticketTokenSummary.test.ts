// 工单属性里 Token 一行的汇总（主题 11.21，用户 2026-11-14 选的算法）。
import { describe, expect, it } from 'vitest';

import { tokenSummary } from './ticketDetailSections';

describe('the token summary in the attributes', () => {
  it('counts cache reads as cached and everything else as uncached', () => {
    const summary = tokenSummary({ cacheReadTokens: 860, uncachedInputTokens: 80, cacheWriteTokens: 40, outputTokens: 20, unsplitTokens: 500 });
    expect(summary).toEqual({ cached: 860, uncached: 140, cachedPercent: 86 });
  });

  it('has no summary when nothing was split', () => {
    expect(tokenSummary({ cacheReadTokens: 0, uncachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, unsplitTokens: 900 })).toBeNull();
    expect(tokenSummary(null)).toBeNull();
  });
});
