// 交付在界面上叫「第 N 次交付」（设计规范 P14.6）：N 是交付快照的序号（GET /v1/tickets/:id/deliveries 的 sequence），
// 不是执行记录的编号。执行记录的编号在界面上找不到，用户读了不知道指什么（2026-11-02）。
// 没有快照的交付没有序号（快照上线以前的交付、快照还没存好、旧 daemon），文字写「最新的交付」「之后的交付」。
import type { DeliverySummary } from '@pi-lead-child/protocol';

/** 交付它的执行记录 id → 第几次交付。 */
export type DeliveryNumbers = ReadonlyMap<number, number>;

export const NO_DELIVERY_NUMBERS: DeliveryNumbers = new Map();

/**
 * 每一次交付的序号。`latest` 是验收标准或核查接口给的最新一次交付：交付列表还没读到时，最新那次也有序号。
 * 同一个执行记录只算一次交付；两处都有时以交付列表为准。
 */
export function deliveryNumbersOf(
  deliveries: readonly Pick<DeliverySummary, 'attemptId' | 'sequence'>[],
  latest?: { attemptId: number; sequence: number | null } | null,
): DeliveryNumbers {
  const numbers = new Map<number, number>();
  if (latest && latest.sequence !== null) numbers.set(latest.attemptId, latest.sequence);
  for (const delivery of deliveries) numbers.set(delivery.attemptId, delivery.sequence);
  return numbers;
}

/** 这个执行记录是第几次交付。不知道时是 null。 */
export function deliveryNumber(numbers: DeliveryNumbers | undefined, attemptId: number | null | undefined): number | null {
  if (attemptId === null || attemptId === undefined) return null;
  return numbers?.get(attemptId) ?? null;
}
