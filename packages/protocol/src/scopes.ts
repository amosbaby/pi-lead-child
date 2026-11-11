import { Type, type Static } from "typebox";

// 这个文件只依赖 typebox：index.ts 和 admin.ts、local-sockets.ts 都从这里取值，不形成循环引用。

// scope 名是线上契约，不随内部改名走。
export const ScopeSchema = Type.Union([
  Type.Literal("chat"),
  Type.Literal("tickets:view"),
  Type.Literal("tickets:create"),
  Type.Literal("approvals:respond"),
  Type.Literal("notices"),
  // 管理权限（配对、撤销 binding、aish 凭证）。缺省不授予，见 admin.ts 的 ADMIN_SCOPE。
  Type.Literal("admin"),
  // 外部工人（Claude Code、Codex）领单和回写（worker.ts）。只给 plc worker pair 单独配对的凭证，永远不进缺省授予的清单
  // （store 的 DEFAULT_SCOPES、CLI_CREDENTIAL_SCOPES、LOOPBACK_AUTO_PAIR_SCOPES）。
  Type.Literal("worker"),
]);
export type Scope = Static<typeof ScopeSchema>;

export const ALL_SCOPES: Scope[] = [
  "chat", "tickets:view", "tickets:create", "approvals:respond", "notices", "admin", "worker",
];

export const BindingDtoSchema = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  kind: Type.String(),
  name: Type.String(),
  scopes: Type.Array(ScopeSchema),
}, { additionalProperties: false });
export type BindingDto = Static<typeof BindingDtoSchema>;
