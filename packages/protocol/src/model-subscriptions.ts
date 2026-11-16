// 设置 → 模型的订阅（模型配置方案 C 的 S2，2026-11-16，.scratch/model-config-c/spec.md D1–D7）。
//
// 订阅只有两种：GitHub Copilot（github-copilot）和 Codex（openai-codex），都经过 pi-multi-pass。
// 一种订阅可以有几个账号（D4）：第一个账号的 provider 名是 <base> 本身，第 n 个是 <base>-<n>。账号的名字（工作、个人）是 label。
// 两个以上账号时 pi-multi-pass 建一个 pool，一个账号限流时按换号方式换下一个账号（D5）。
//
// 页面读 GET /v1/models/settings?grouping=1 的 subscriptions（可选字段，旧版 Companion 的严格 schema 不认它）。
// 改动都是操作层的操作（ui-actions.ts 的 model_settings），页面和 Lead 调同一个函数。
import { Type, type Static, type TProperties, type TSchema } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const IsoTimeSchema = Type.String({ minLength: 10, maxLength: 40 });

export const SUBSCRIPTION_BASES = ["openai-codex", "github-copilot"] as const;
export type SubscriptionBase = (typeof SUBSCRIPTION_BASES)[number];
export const SubscriptionBaseSchema = Type.Union([Type.Literal("openai-codex"), Type.Literal("github-copilot")]);

// 一个账号的 provider 名：<base> 或 <base>-<n>（n 从 2 起）。
export const SUBSCRIPTION_ACCOUNT_PATTERN = "^(openai-codex|github-copilot)(-([2-9]|[1-9][0-9]))?$";
export const SubscriptionAccountNameSchema = Type.String({ pattern: SUBSCRIPTION_ACCOUNT_PATTERN });
export const SubscriptionLabelSchema = Type.String({ minLength: 1, maxLength: 40 });

/** 账号的 provider 名拆成订阅和序号。不是订阅账号时返回 null。<base> 本身是第 1 个。 */
export function subscriptionAccountOf(provider: string): { base: SubscriptionBase; index: number } | null {
  const match = /^(openai-codex|github-copilot)(?:-(\d{1,2}))?$/.exec(provider);
  if (!match) return null;
  const index = match[2] === undefined ? 1 : Number(match[2]);
  if (match[2] !== undefined && (index < 2 || match[2].startsWith("0"))) return null;
  return { base: match[1] as SubscriptionBase, index };
}

/** 第 index 个账号的 provider 名。 */
export function subscriptionAccountName(base: SubscriptionBase, index: number): string {
  return index <= 1 ? base : `${base}-${index}`;
}

/**
 * 分工里的一格（D5）：<base>-<n>/<id> 和 <base>/<id> 是同一格。别的模型原样返回。
 * spec 可以带推理强度的后缀（provider/id(high)），后缀原样保留。
 */
export function subscriptionSlotSpec(spec: string): string {
  const slash = spec.indexOf("/");
  if (slash <= 0) return spec;
  const account = subscriptionAccountOf(spec.slice(0, slash));
  return account ? `${account.base}${spec.slice(slash)}` : spec;
}

// 换号方式（pi-multi-pass 的 PoolStrategy）。custom 是用户自己在 pi 里写的脚本，这里只显示，不能选。
export const SubscriptionStrategySchema = Type.Union([
  Type.Literal("round-robin"), Type.Literal("quota-first"), Type.Literal("scheduled"),
]);
export type SubscriptionStrategy = Static<typeof SubscriptionStrategySchema>;
export const SubscriptionStrategyStateSchema = Type.Union([SubscriptionStrategySchema, Type.Literal("custom")]);

export const SubscriptionDaySchema = Type.Union([
  Type.Literal("mon"), Type.Literal("tue"), Type.Literal("wed"), Type.Literal("thu"),
  Type.Literal("fri"), Type.Literal("sat"), Type.Literal("sun"),
]);
export type SubscriptionDay = Static<typeof SubscriptionDaySchema>;
const DateSchema = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });

// 一个时间段（pi-multi-pass 的 ScheduleWindow）。hours 是本机时间的 [开始, 结束)，开始比结束大时跨午夜（[22, 6]）。
export const SubscriptionWindowSchema = StrictObject({
  hours: Type.Optional(Type.Tuple([Type.Integer({ minimum: 0, maximum: 23 }), Type.Integer({ minimum: 0, maximum: 24 })])),
  days: Type.Optional(Type.Array(SubscriptionDaySchema, { minItems: 1, maxItems: 7 })),
  dateRange: Type.Optional(StrictObject({ from: Type.Optional(DateSchema), to: Type.Optional(DateSchema) })),
});
export type SubscriptionWindow = Static<typeof SubscriptionWindowSchema>;

// 按时间段换号（scheduled）时账号的角色：preferred 只在自己的时间段里用，default 一直能用，overflow 别的都用不了时才用。
export const SubscriptionRoleSchema = Type.Union([Type.Literal("preferred"), Type.Literal("default"), Type.Literal("overflow")]);
export type SubscriptionRole = Static<typeof SubscriptionRoleSchema>;

// 额度的一个窗口（Codex 的 5 小时和 7 天）。remainingPercent 是剩下的百分比。
export const SubscriptionQuotaWindowSchema = StrictObject({
  label: Type.String({ minLength: 1, maxLength: 20 }),
  remainingPercent: Nullable(Type.Number({ minimum: 0, maximum: 100 })),
  resetAt: Nullable(IsoTimeSchema),
});
export type SubscriptionQuotaWindow = Static<typeof SubscriptionQuotaWindowSchema>;

export const SubscriptionQuotaSchema = StrictObject({
  windows: Type.Array(SubscriptionQuotaWindowSchema, { maxItems: 8 }),
  checkedAt: IsoTimeSchema,
  // 查不到的原因（例如登录过期）。没问题时为 null。
  problem: Nullable(Type.String({ maxLength: 300 })),
});
export type SubscriptionQuota = Static<typeof SubscriptionQuotaSchema>;

export const SubscriptionAccountSchema = StrictObject({
  provider: SubscriptionAccountNameSchema,
  index: Type.Integer({ minimum: 1, maximum: 99 }),
  label: Nullable(SubscriptionLabelSchema),
  loggedIn: Type.Boolean(),
  email: Nullable(Type.String({ maxLength: 200 })),
  plan: Nullable(Type.String({ maxLength: 60 })),
  // 只有 Codex 有额度查询（D6）。Copilot、没查过或者没登录时为 null。
  quota: Nullable(SubscriptionQuotaSchema),
  // 限流以后在冷却，到这个时间（ISO）以前不换回它。没有时为 null。
  coolingUntil: Nullable(IsoTimeSchema),
  role: SubscriptionRoleSchema,
  windows: Type.Array(SubscriptionWindowSchema, { maxItems: 16 }),
  // 这个账号的模型在大脑的分工里（删掉它会被拒绝）。
  inUse: Type.Boolean(),
});
export type SubscriptionAccount = Static<typeof SubscriptionAccountSchema>;

// 订阅的一个模型：分工里写 <base>/<id>。
export const SubscriptionModelSchema = StrictObject({
  model: Type.String({ minLength: 3, maxLength: 300 }),
  id: Type.String({ minLength: 1, maxLength: 200 }),
  name: Nullable(Type.String({ maxLength: 200 })),
  image: Type.Boolean(),
  contextWindow: Nullable(Type.Integer({ minimum: 1 })),
  efforts: Type.Array(Type.String({ minLength: 1, maxLength: 32 })),
});
export type SubscriptionModel = Static<typeof SubscriptionModelSchema>;

export const SubscriptionSchema = StrictObject({
  base: SubscriptionBaseSchema,
  accounts: Type.Array(SubscriptionAccountSchema, { maxItems: 32 }),
  strategy: SubscriptionStrategyStateSchema,
  // 能不能查额度：Codex 能，Copilot 不能（界面写明）。
  quotaSupported: Type.Boolean(),
  // 有账号登录时才列模型。
  models: Type.Array(SubscriptionModelSchema, { maxItems: 200 }),
});
export type Subscription = Static<typeof SubscriptionSchema>;

// 一次登录（D3）。Copilot 给设备码，Codex 给登录地址；Codex 在手机上没法开浏览器时，用户把回调地址粘贴回来（awaitingCode）。
export const SubscriptionLoginStateSchema = Type.Union([
  Type.Literal("starting"), Type.Literal("waiting"), Type.Literal("done"), Type.Literal("error"), Type.Literal("cancelled"),
]);
export type SubscriptionLoginState = Static<typeof SubscriptionLoginStateSchema>;

export const SubscriptionLoginSchema = StrictObject({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  base: SubscriptionBaseSchema,
  provider: SubscriptionAccountNameSchema,
  label: Nullable(SubscriptionLabelSchema),
  state: SubscriptionLoginStateSchema,
  authUrl: Nullable(Type.String({ maxLength: 4000 })),
  deviceCode: Nullable(StrictObject({
    code: Type.String({ minLength: 1, maxLength: 64 }),
    uri: Type.String({ minLength: 1, maxLength: 500 }),
    expiresAt: Nullable(IsoTimeSchema),
  })),
  // 在等用户粘贴回调地址或者授权码（submit_subscription_login_code）。
  awaitingCode: Type.Boolean(),
  progress: Nullable(Type.String({ maxLength: 300 })),
  error: Nullable(Type.String({ maxLength: 500 })),
  startedAt: IsoTimeSchema,
});
export type SubscriptionLogin = Static<typeof SubscriptionLoginSchema>;

export const SubscriptionsDtoSchema = StrictObject({
  subscriptions: Type.Array(SubscriptionSchema, { maxItems: 8 }),
  logins: Type.Array(SubscriptionLoginSchema, { maxItems: 16 }),
  // pi-multi-pass 装好、加载进了 Lead 的会话。没有时第 2 个以后的账号还不能用。
  multiPass: Type.Boolean(),
});
export type SubscriptionsDto = Static<typeof SubscriptionsDtoSchema>;

// ── 操作的输入（ui-actions.ts 的 model_settings）──────────────────────────────────

// 开始登录。不给 provider 时加一个新账号（下一个空着的序号）；给了时重新登录这个账号。
// method 只对 Codex 有用：browser（缺省）或者 device_code。
export const StartSubscriptionLoginRequestSchema = StrictObject({
  base: SubscriptionBaseSchema,
  provider: Type.Optional(SubscriptionAccountNameSchema),
  label: Type.Optional(SubscriptionLabelSchema),
  method: Type.Optional(Type.Union([Type.Literal("browser"), Type.Literal("device_code")])),
});
export type StartSubscriptionLoginRequest = Static<typeof StartSubscriptionLoginRequestSchema>;

export const SubscriptionLoginIdSchema = Type.String({ minLength: 1, maxLength: 64 });
// 粘贴回来的回调地址或者授权码。
export const SubmitSubscriptionLoginCodeRequestSchema = StrictObject({
  login: SubscriptionLoginIdSchema,
  code: Type.String({ minLength: 1, maxLength: 4000 }),
});
export type SubmitSubscriptionLoginCodeRequest = Static<typeof SubmitSubscriptionLoginCodeRequestSchema>;

export const CancelSubscriptionLoginRequestSchema = StrictObject({ login: SubscriptionLoginIdSchema });
export type CancelSubscriptionLoginRequest = Static<typeof CancelSubscriptionLoginRequestSchema>;

export const RenameSubscriptionAccountRequestSchema = StrictObject({
  provider: SubscriptionAccountNameSchema,
  label: SubscriptionLabelSchema,
});
export type RenameSubscriptionAccountRequest = Static<typeof RenameSubscriptionAccountRequestSchema>;

export const RemoveSubscriptionAccountRequestSchema = StrictObject({ provider: SubscriptionAccountNameSchema });
export type RemoveSubscriptionAccountRequest = Static<typeof RemoveSubscriptionAccountRequestSchema>;

export const SetSubscriptionStrategyRequestSchema = StrictObject({
  base: SubscriptionBaseSchema,
  strategy: SubscriptionStrategySchema,
});
export type SetSubscriptionStrategyRequest = Static<typeof SetSubscriptionStrategyRequestSchema>;

// 一个账号在按时间段换号时的角色和时间段。windows 为空：preferred 没有时间段时一直算在时间段里。
export const SetSubscriptionScheduleRequestSchema = StrictObject({
  provider: SubscriptionAccountNameSchema,
  role: SubscriptionRoleSchema,
  windows: Type.Array(SubscriptionWindowSchema, { maxItems: 16 }),
});
export type SetSubscriptionScheduleRequest = Static<typeof SetSubscriptionScheduleRequestSchema>;
