import { Type, type Static, type TProperties } from "typebox";
import { Value } from "typebox/value";
import {
  redactUiSurface, UI_CATALOG_VERSION, UiSurfaceSchema, validateUiSurface, type UiComponentType, type UiSurface, type UiSurfaceError,
  type UiSurfaceRules,
} from "./ui-surfaces.ts";
import {
  DEFAULT_VIEW, WIDGET_LIMITS, WIDGET_SOURCE_LIMITS, WidgetSurfaceInputSchema, type WidgetSurfaceInput,
} from "./widget-requests.ts";

export * from "./widget-requests.ts";

// 自定义控件（用户 2026-10-30，.scratch/custom-views/spec.md）：用户用自然语言让 Lead 做的常驻控件，放在右侧的视图面板里。
// 一个控件是一块 genui 的 surface，加一个标题和它所在的视图（view）。视图只是控件的一个属性，缺省是 default，
// 没有单独的视图表：一个视图里的控件都删完或移走，这个视图就没了。只有一个视图时面板不显示 tab（用户 2026-10-30）。
// 数据源和绑定是第二期（spec D3、D4）。
//
// 控件存在 daemon 的库里，所有端看到同一份。建、改、删、排序、视图改名都是操作层的操作（ui-actions.ts 的 widget_board、widget），
// 页面和 Lead（perform_action）调同一个函数。GET /v1/widgets 读全部控件；改动以后推 snapshot.required（resource=widgets）。

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const WIDGETS_RESOURCE = "widgets";

// 控件里不能用的组件。它们属于会话里的某一轮，不能常驻：
//   ChoiceGroup、UserAction 和几种确认卡是一次性的请求，处理完就结束；
//   SourceQuote、Message、Intervention 的内容由服务端在 render_ui 定稿时从账本填；
//   ChannelCard 是外部消息卡，属于收件箱。
export const WIDGET_EXCLUDED_COMPONENTS: ReadonlySet<UiComponentType> = new Set<UiComponentType>([
  "ChoiceGroup", "UserAction", "ConnectionConnect", "ConnectionConfirm", "MemorySwitchConfirm", "StandingOrderChangeConfirm",
  "SourceQuote", "Message", "Intervention", "ChannelCard",
]);

export const WidgetActorSchema = Type.Union([Type.Literal("user"), Type.Literal("lead")]);
export type WidgetActor = Static<typeof WidgetActorSchema>;

// 控件的数据源现在怎样（第二期）：多久跑一次、上次跑和上次成功是什么时候、出错的原因、是不是暂停了。
// 命令和模板不给客户端：页面只画 surface（daemon 已经用最新的数据解析好的那一块）。
export const WidgetSourceDtoSchema = StrictObject({
  everySeconds: Type.Integer({ minimum: 1 }),
  lastRunAt: Type.Union([Type.String(), Type.Null()]),
  lastOkAt: Type.Union([Type.String(), Type.Null()]),
  lastError: Type.Union([Type.String(), Type.Null()]),
  paused: Type.Boolean(),
});
export type WidgetSourceDto = Static<typeof WidgetSourceDtoSchema>;

export const WidgetDtoSchema = StrictObject({
  id: Type.Integer({ minimum: 1 }),
  title: Type.String({ minLength: 1, maxLength: WIDGET_LIMITS.title }),
  view: Type.String({ minLength: 1, maxLength: WIDGET_LIMITS.viewName }),
  surface: UiSurfaceSchema,
  // 没有数据源的控件（快照）没有这个字段，或者是 null。可选：比它旧的 daemon 不给。
  source: Type.Optional(Type.Union([WidgetSourceDtoSchema, Type.Null()])),
  createdBy: WidgetActorSchema,
  createdAt: Type.String({ minLength: 1 }),
  updatedAt: Type.String({ minLength: 1 }),
});
export type WidgetDto = Static<typeof WidgetDtoSchema>;

// GET /v1/widgets：全部控件，按面板里从上到下的顺序（各个视图混在一起，客户端按 view 分开）。
export const WidgetsResponseSchema = StrictObject({
  widgets: Type.Array(WidgetDtoSchema, { maxItems: WIDGET_LIMITS.widgets }),
});
export type WidgetsResponse = Static<typeof WidgetsResponseSchema>;

/** 控件的 surface id：按控件编号，同一个控件改了模板也不变。 */
export function widgetSurfaceId(widgetId: number): string {
  return `widget_${widgetId}`;
}

/**
 * 现有的视图，按 tab 的顺序：缺省的视图排第一，别的按出现的先后（视图里最早建的控件）。
 * 页面画 tab 和 Lead 读到的视图列表用同一个顺序。
 */
export function widgetViews(widgets: readonly Pick<WidgetDto, "id" | "view">[]): string[] {
  const first = new Map<string, number>();
  for (const widget of widgets) first.set(widget.view, Math.min(first.get(widget.view) ?? widget.id, widget.id));
  return [...first.keys()].sort((a, b) => (a === DEFAULT_VIEW ? -1 : b === DEFAULT_VIEW ? 1 : first.get(a)! - first.get(b)!));
}

export type WidgetSurfaceResult = { ok: true; surface: UiSurface } | { ok: false; errors: UiSurfaceError[] };

// 控件的校验规则：一张卡可以有多个能点开的块（工单 #53，例如每个仓库一个 Disclosure）。服务端建卡和页面画控件都用它。
export const WIDGET_SURFACE_RULES: UiSurfaceRules = { manyOpeners: true };

/**
 * 把操作的 input 里的模板变成控件的 surface：先去掉密钥，再用和 render_ui 同一个 validateUiSurface 校验（控件的规则 WIDGET_SURFACE_RULES），
 * 再查控件不能用的组件（WIDGET_EXCLUDED_COMPONENTS）。不合格时返回带路径的错误，和 render_ui 给 Lead 的一样。
 */
export function buildWidgetSurface(widgetId: number, input: unknown): WidgetSurfaceResult {
  if (!Value.Check(WidgetSurfaceInputSchema, input)) {
    return { ok: false, errors: [{ path: "/surface", message: "模板的结构不对：要有 root、nodes 和 fallback_text，写法和 render_ui 一样" }] };
  }
  const repeated = input.nodes.findIndex((node) => node.repeat !== undefined);
  if (repeated >= 0) {
    return { ok: false, errors: [{ path: `/nodes/${repeated}/repeat`, message: "repeat 只能用在带数据源（source）的模板里" }] };
  }
  const draft: UiSurface = {
    id: widgetSurfaceId(widgetId),
    catalogVersion: UI_CATALOG_VERSION,
    root: input.root,
    fallbackText: input.fallback_text,
    nodes: input.nodes.map((node) => ({ ...node, props: { ...node.props } })),
  };
  const checked = validateUiSurface(redactUiSurface(draft), WIDGET_SURFACE_RULES);
  if (!checked.ok) return checked;
  const excluded = checked.surface.nodes.findIndex((node) => WIDGET_EXCLUDED_COMPONENTS.has(node.type as UiComponentType));
  if (excluded >= 0) {
    const type = checked.surface.nodes[excluded]!.type;
    return {
      ok: false,
      errors: [{ path: `/nodes/${excluded}/type`, message: `控件里不能用 ${type}：它属于会话里的一轮，不能常驻。要用户做决定或确认时，在会话里用 render_ui 画` }],
    };
  }
  return { ok: true, surface: checked.surface };
}

// ── 数据源的输出和模板的绑定（第二期，spec D3、D4）────────────────────────────────────────────

export type WidgetDataResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

/**
 * 数据源命令的输出变成数据：一个 JSON 对象，最多 WIDGET_SOURCE_LIMITS.outputBytes 字节。
 * 整段不是 JSON 时，取最后一个不空的行再试一次（命令前面打了别的字）。
 */
export function parseWidgetSourceOutput(output: string): WidgetDataResult {
  const text = output.trim();
  if (!text) return { ok: false, error: "命令没有输出" };
  if (new TextEncoder().encode(text).length > WIDGET_SOURCE_LIMITS.outputBytes) {
    return { ok: false, error: `输出超过 ${WIDGET_SOURCE_LIMITS.outputBytes} 字节` };
  }
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const candidate of [text, lines.at(-1) ?? ""]) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ok: true, data: parsed as Record<string, unknown> };
      return { ok: false, error: "输出要是一个 JSON 对象（{ ... }），不能是数组或单个值" };
    } catch {
      // 再试最后一行。
    }
  }
  return { ok: false, error: "输出不是 JSON：命令的标准输出只能打一个 JSON 对象" };
}

const MISSING = Symbol("missing");

// 点分路径取值：quote.price、series.0.value。数组用数字下标。
function valueAt(data: unknown, path: string): unknown {
  let current: unknown = data;
  for (const key of path.split(".")) {
    if (Array.isArray(current) && /^\d+$/.test(key)) current = current[Number(key)];
    else if (current && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, key)) current = (current as Record<string, unknown>)[key];
    else return MISSING;
    if (current === undefined) return MISSING;
  }
  return current;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export type WidgetTemplateResult = { ok: true; input: WidgetSurfaceInput } | { ok: false; error: string };

type TemplateNode = WidgetSurfaceInput["nodes"][number];

// 节点的 props 里引用别的节点 id 的字段：Disclosure 的 detail、Field 的 for。重复出来的一份里跟着换成这一份的 id。
const ID_REFERENCE_PROPS = ["detail", "for"] as const;

// 这个节点和它下面的所有节点的 id（按 children）。
function templateSubtree(id: string, byId: ReadonlyMap<string, TemplateNode>, into = new Set<string>()): Set<string> {
  if (into.has(id)) return into;
  into.add(id);
  for (const child of byId.get(id)?.children ?? []) templateSubtree(child, byId, into);
  return into;
}

// 文字里的 {{item.x}} 和 {"$data": "item.x"} 换成这一项在数据里的路径（repos.2.x）；别的路径不动。
function scopeItemPaths(value: unknown, base: string): unknown {
  const scoped = (path: string) => (path === "item" ? base : path.startsWith("item.") ? `${base}${path.slice(4)}` : path);
  if (typeof value === "string") return value.replace(PLACEHOLDER, (_whole, path: string) => `{{${scoped(path)}}}`);
  if (Array.isArray(value)) return value.map((child) => scopeItemPaths(child, base));
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 1 && entries[0]![0] === "$data" && typeof entries[0]![1] === "string") return { $data: scoped(entries[0]![1]) };
    return Object.fromEntries(entries.map(([key, child]) => [key, scopeItemPaths(child, base)]));
  }
  return value;
}

type ExpandResult = { ok: true; nodes: TemplateNode[] } | { ok: false; error: string };

/**
 * 按数组重复节点（工单 #53）：节点写 repeat: "路径"，数据里那个数组的每一项生成一份这个节点和它下面的节点。
 * 这一份里 {{item.字段}}、{"$data": "item.字段"} 指这一项。id 加上 -序号，children、detail、for 跟着换；
 * 上一层的 children 和 detail 里这个节点换成生成的那几份，0 项时去掉。不能嵌套，最多 WIDGET_SOURCE_LIMITS.repeatItems 项。
 */
function expandRepeats(template: WidgetSurfaceInput, data: Record<string, unknown>): ExpandResult {
  if (!template.nodes.some((node) => node.repeat !== undefined)) return { ok: true, nodes: template.nodes };
  const byId = new Map(template.nodes.map((node) => [node.id, node]));
  const owner = new Map<string, string>();
  const copies = new Map<string, TemplateNode[]>();
  const replaced = new Map<string, string[]>();
  for (const node of template.nodes) {
    if (node.repeat === undefined) continue;
    if (node.id === template.root) return { ok: false, error: `root 节点 ${node.id} 不能写 repeat` };
    const below = templateSubtree(node.id, byId);
    for (const id of below) {
      if (id !== node.id && byId.get(id)?.repeat !== undefined) return { ok: false, error: `repeat 不能嵌套：${id} 在 ${node.id} 下面` };
      if (owner.has(id)) return { ok: false, error: `节点 ${id} 同时在两个 repeat 下面` };
      owner.set(id, node.id);
    }
    const outside = template.nodes.find((other) => !below.has(other.id) && [...below].some((id) => id !== node.id && (
      other.children?.includes(id) || ID_REFERENCE_PROPS.some((key) => [other.props[key]].flat().includes(id)))));
    if (outside) return { ok: false, error: `${outside.id} 引用了 repeat 节点 ${node.id} 下面的节点` };
    const items = valueAt(data, node.repeat);
    if (items === MISSING) return { ok: false, error: `数据里没有 ${node.repeat}` };
    if (!Array.isArray(items)) return { ok: false, error: `${node.repeat} 要是一个数组` };
    if (items.length > WIDGET_SOURCE_LIMITS.repeatItems) {
      return { ok: false, error: `${node.repeat} 有 ${items.length} 项，repeat 最多 ${WIDGET_SOURCE_LIMITS.repeatItems} 项` };
    }
    const order = template.nodes.filter((other) => below.has(other.id));
    const generated: TemplateNode[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const rename = (id: string) => (below.has(id) ? `${id}-${index}` : id);
      for (const { repeat: _repeat, ...source } of order) {
        const props = scopeItemPaths(source.props, `${node.repeat}.${index}`) as Record<string, unknown>;
        for (const key of ID_REFERENCE_PROPS) {
          const ref = props[key];
          if (typeof ref === "string") props[key] = rename(ref);
          else if (Array.isArray(ref)) props[key] = ref.map((id) => (typeof id === "string" ? rename(id) : id));
        }
        generated.push({ ...source, id: rename(source.id), props, ...(source.children ? { children: source.children.map(rename) } : {}) });
      }
    }
    copies.set(node.id, generated);
    replaced.set(node.id, items.map((_item, index) => `${node.id}-${index}`));
  }
  const swap = (ids: readonly string[]) => ids.flatMap((id) => replaced.get(id) ?? [id]);
  const nodes: TemplateNode[] = [];
  for (const node of template.nodes) {
    const repeatOf = owner.get(node.id);
    if (repeatOf !== undefined) {
      if (repeatOf === node.id) nodes.push(...copies.get(node.id)!);
      continue;
    }
    const props = Array.isArray(node.props.detail) ? { ...node.props, detail: swap(node.props.detail as string[]) } : node.props;
    nodes.push({ ...node, props, ...(node.children ? { children: swap(node.children) } : {}) });
  }
  return { ok: true, nodes };
}

/**
 * 用数据解析模板：先展开 repeat（expandRepeats），再把属性值是 {"$data": "路径"} 的整个换成那个字段的值，文字里的 {{路径}} 换成那个字段的文字。
 * 路径在数据里找不到时不解析，返回原因（这一次算出错，控件留着上一次的内容）。解析出来的还要过 buildWidgetSurface 的校验。
 */
export function resolveWidgetTemplate(template: WidgetSurfaceInput, data: Record<string, unknown>): WidgetTemplateResult {
  const missing = new Set<string>();
  const text = (value: string) => value.replace(PLACEHOLDER, (_whole, path: string) => {
    const found = valueAt(data, path);
    if (found === MISSING || found === null || typeof found === "object") {
      missing.add(path);
      return "";
    }
    return String(found);
  });
  const resolve = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 1 && entries[0]![0] === "$data" && typeof entries[0]![1] === "string") {
        const path = entries[0]![1] as string;
        const found = valueAt(data, path);
        if (found === MISSING) {
          missing.add(path);
          return null;
        }
        return found;
      }
      return Object.fromEntries(entries.map(([key, child]) => [key, resolve(child)]));
    }
    return value;
  };
  const expanded = expandRepeats(template, data);
  if (!expanded.ok) return expanded;
  const input: WidgetSurfaceInput = {
    root: template.root,
    fallback_text: text(template.fallback_text),
    nodes: expanded.nodes.map((node) => ({ ...node, props: resolve(node.props) as Record<string, unknown> })),
  };
  if (missing.size) return { ok: false, error: `数据里没有 ${[...missing].slice(0, 5).join("、")}` };
  return { ok: true, input };
}

/** 模板里有没有绑定（{"$data": …}、{{…}} 或 repeat）。没有绑定的模板加数据源没有意义。 */
export function widgetTemplateBinds(template: WidgetSurfaceInput): boolean {
  const json = JSON.stringify(template);
  return template.nodes.some((node) => node.repeat !== undefined) || json.includes('"$data"') || /\{\{\s*[A-Za-z0-9_.-]+\s*\}\}/.test(json);
}
