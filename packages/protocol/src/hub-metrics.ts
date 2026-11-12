// 外部工人 hub 的指标和「找不到」记录（计划 Task 14）的线上契约。
// - ticket_miss.record：用户说「找不到某张单」，记一行（操作层的 ticket_miss，lead_allowed，写账本）。网页按钮和 plc miss 走同一个操作。
// - GET /v1/hub/metrics?since=7d：S1 成不成功看的几个数（store 的 hubMetrics，口径写在那里）。since 只认 Nd、Nh。
// 这个文件不 import index.ts（index.ts 从这里 re-export，反过来会循环）。
import { Type, type Static, type TProperties } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

// 「找不到」的原话最多多少个字符（去掉首尾空白以后算）。
export const TICKET_MISS_TEXT_MAX = 500;

// 前后都不是空白、长度在上限以内。JSON Schema 管不了「去掉空白以后」，所以操作层和 plc 在 trim 以后再用 normalizeMissText 查一遍。
export const RecordTicketMissRequestSchema = StrictObject({
  text: Type.String({ minLength: 1, maxLength: TICKET_MISS_TEXT_MAX + 200 }),
});
export type RecordTicketMissRequest = Static<typeof RecordTicketMissRequestSchema>;

/** 去掉首尾空白。空的、超过上限的返回 null（调用方说原因）。 */
export function normalizeMissText(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === "" || trimmed.length > TICKET_MISS_TEXT_MAX ? null : trimmed;
}

export const HUB_METRICS_DEFAULT_SINCE = "7d";
export const HUB_METRICS_SINCE_PATTERN = /^[1-9]\d{0,3}[dh]$/;

/** 「7d」「36h」换成毫秒。不是 Nd、Nh（N 是 1 到 9999 的整数）时返回 null。 */
export function hubMetricsWindowMs(since: string): number | null {
  if (!HUB_METRICS_SINCE_PATTERN.test(since)) return null;
  const amount = Number(since.slice(0, -1));
  return amount * (since.endsWith("d") ? 86_400_000 : 3_600_000);
}

export const HubMetricsSchema = StrictObject({
  tickets: Type.Integer({ minimum: 0 }),
  withSource: Type.Integer({ minimum: 0 }),
  withSession: Type.Integer({ minimum: 0 }),
  sourceCoverage: Type.Number({ minimum: 0, maximum: 1 }),
  sessionCoverage: Type.Number({ minimum: 0, maximum: 1 }),
  medianClaimMinutes: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  // 用户自己说的「找不到」（按钮、plc miss）。止损看这一个。
  misses: Type.Integer({ minimum: 0 }),
  // Lead 调操作记的（ruling R27）：单独数，不进 misses。
  leadMisses: Type.Integer({ minimum: 0 }),
});
export type HubMetricsDto = Static<typeof HubMetricsSchema>;

export const HubMetricsResponseSchema = StrictObject({
  since: Type.String(),
  metrics: HubMetricsSchema,
});
export type HubMetricsResponse = Static<typeof HubMetricsResponseSchema>;
