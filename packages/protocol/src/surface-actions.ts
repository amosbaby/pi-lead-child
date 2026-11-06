// 会话卡片上的按钮做成了（工单 #263，2026-11-05）。Lead 用 render_ui 画的卡片上的 Action 按钮，按下、操作成功以后，
// 按钮收起，换成一行「已完成」。刷新页面、换一台设备打开，也要看到已完成：服务端按「哪一次 render_ui 调用、哪个按钮节点」
// 记一条，卡片打开时读回来。
//
// - 执行请求（POST /v1/tickets/:id/actions/:action、POST /v1/actions/:type/:id/:action）可以带 origin：按钮所在的卡片。
//   操作成功以后才记；失败不记，按钮照旧能再按。Lead 的工具入口不带 origin。
// - GET /v1/conversation/surface-actions?call=<callId>（chat）：这些卡片上已经做成的按钮。call 可以给多个。
// - 记录里写目标和操作。客户端只在记录和按钮的 target、action 一致时显示已完成。
// - 工作台的控件（widgets）是反复用的，按钮不带 origin，不收起。
//
// 这个文件不 import index.ts（index.ts 从这里 re-export，ticket-actions.ts 和 ui-actions.ts 也用它）。
import { Type, type Static, type TProperties } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

const CallIdSchema = Type.String({ minLength: 1, maxLength: 200 });
// 和 ui-surfaces.ts 的节点 id 同一种写法。
const NodeIdSchema = Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" });

/** 一次 GET 最多问几张卡。 */
export const SURFACE_ACTIONS_QUERY_LIMIT = 50;

export const SurfaceActionOriginSchema = StrictObject({
  // 画出这张卡的 render_ui 调用（会话里 surface 部件的 callId）。
  callId: CallIdSchema,
  // 卡片里按钮的节点 id。
  node: NodeIdSchema,
});
export type SurfaceActionOrigin = Static<typeof SurfaceActionOriginSchema>;

export const SurfaceActionDoneSchema = StrictObject({
  callId: CallIdSchema,
  node: NodeIdSchema,
  target: StrictObject({ type: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) }),
  action: Type.String({ minLength: 1, maxLength: 64 }),
  // 做成的时刻（ISO）。
  at: Type.String({ minLength: 1 }),
});
export type SurfaceActionDone = Static<typeof SurfaceActionDoneSchema>;

export const SurfaceActionsResponseSchema = StrictObject({
  actions: Type.Array(SurfaceActionDoneSchema),
});
export type SurfaceActionsResponse = Static<typeof SurfaceActionsResponseSchema>;
