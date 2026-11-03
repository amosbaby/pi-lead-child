// 交付写「第 N 次交付」，N 是交付快照的序号，不是执行记录的编号（设计规范 P14.6，用户 2026-11-02）。
import { describe, expect, it } from 'vitest';

import { deliveryNumber, deliveryNumbersOf } from './deliveryNumbers';

describe('delivery numbers', () => {
  it('maps the run that delivered to the sequence of its delivery', () => {
    const numbers = deliveryNumbersOf([{ attemptId: 42, sequence: 1 }, { attemptId: 49, sequence: 2 }]);
    expect(deliveryNumber(numbers, 49)).toBe(2);
    expect(deliveryNumber(numbers, 42)).toBe(1);
  });

  it('knows the latest delivery before the delivery list arrives', () => {
    const numbers = deliveryNumbersOf([], { attemptId: 49, sequence: 2 });
    expect(deliveryNumber(numbers, 49)).toBe(2);
  });

  it('prefers the delivery list over the latest delivery of another source', () => {
    const numbers = deliveryNumbersOf([{ attemptId: 49, sequence: 3 }], { attemptId: 49, sequence: 2 });
    expect(deliveryNumber(numbers, 49)).toBe(3);
  });

  it('has no number for a run without a delivery snapshot', () => {
    const numbers = deliveryNumbersOf([{ attemptId: 49, sequence: 1 }], { attemptId: 50, sequence: null });
    expect(deliveryNumber(numbers, 50)).toBeNull();
    expect(deliveryNumber(numbers, null)).toBeNull();
    expect(deliveryNumber(undefined, 49)).toBeNull();
  });
});
