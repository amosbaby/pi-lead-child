// 模板按数组重复节点（工单 #53）：节点写 repeat: "路径"，数据里那个数组的每一项生成一份这个节点和它下面的节点，
// 这一份里的 {{item.字段}}、{"$data": "item.字段"} 指这一项。展开以后照常过 buildWidgetSurface 的校验。
import { describe, expect, it } from "vitest";
import { validateUiSurface } from "../src/ui-surfaces.ts";
import {
  buildWidgetSurface, resolveWidgetTemplate, WIDGET_SOURCE_LIMITS, WIDGET_SURFACE_RULES, widgetTemplateBinds, type WidgetSurfaceInput,
} from "../src/widgets.ts";

const template: WidgetSurfaceInput = {
  root: "card",
  nodes: [
    { id: "card", type: "Stack", props: { gap: "sm" }, children: ["head", "repo"] },
    { id: "head", type: "Text", props: { text: "{{count}} 个仓库" } },
    { id: "repo", type: "Section", props: { title: "{{item.name}} · {{item.prs}} 个 PR" }, children: ["table"], repeat: "repos" },
    { id: "table", type: "DataTable", props: { columns: [{ label: "PR" }], rows: { $data: "item.rows" } } },
  ],
  fallback_text: "{{count}} 个仓库",
};

const repo = (name: string, prs: number) => ({ name, prs, rows: Array.from({ length: prs }, (_, index) => [`#${index + 1}`]) });

function render(data: Record<string, unknown>) {
  const resolved = resolveWidgetTemplate(template, data);
  if (!resolved.ok) throw new Error(resolved.error);
  const built = buildWidgetSurface(7, resolved.input);
  if (!built.ok) throw new Error(JSON.stringify(built.errors));
  return built.surface;
}

describe("repeat in a widget template", () => {
  it("draws a valid card with no repeated nodes when the array is empty", () => {
    const surface = render({ count: 0, repos: [] });
    expect(surface.nodes.map((node) => node.id)).toEqual(["card", "head"]);
    expect(surface.nodes[0]!.children).toEqual(["head"]);
  });

  it("makes one copy for one item, with item paths bound to that item", () => {
    const surface = render({ count: 1, repos: [repo("acme/api", 2)] });
    expect(surface.nodes.map((node) => node.id)).toEqual(["card", "head", "repo-0", "table-0"]);
    expect(surface.nodes[0]!.children).toEqual(["head", "repo-0"]);
    expect(surface.nodes[2]).toMatchObject({ props: { title: "acme/api · 2 个 PR" }, children: ["table-0"] });
    expect(surface.nodes[3]!.props.rows).toEqual([["#1"], ["#2"]]);
    expect(surface.nodes.some((node) => "repeat" in node)).toBe(false);
  });

  it("makes one copy per item in order, each with its own rows", () => {
    const surface = render({ count: 3, repos: [repo("acme/api", 1), repo("acme/web", 3), repo("acme/x", 2)] });
    expect(surface.nodes[0]!.children).toEqual(["head", "repo-0", "repo-1", "repo-2"]);
    expect(surface.nodes.filter((node) => node.type === "Section").map((node) => node.props.title))
      .toEqual(["acme/api · 1 个 PR", "acme/web · 3 个 PR", "acme/x · 2 个 PR"]);
    expect(surface.nodes.find((node) => node.id === "table-1")!.props.rows).toHaveLength(3);
  });

  it("names the missing field of an item, a missing or non-array path, and an array over the limit", () => {
    expect(resolveWidgetTemplate(template, { count: 1, repos: [{ name: "acme/api", rows: [["#1"]] }] }))
      .toEqual({ ok: false, error: "数据里没有 repos.0.prs" });
    expect(resolveWidgetTemplate(template, { count: 1 })).toEqual({ ok: false, error: "数据里没有 repos" });
    expect(resolveWidgetTemplate(template, { count: 1, repos: { a: 1 } })).toEqual({ ok: false, error: "repos 要是一个数组" });
    const many = Array.from({ length: WIDGET_SOURCE_LIMITS.repeatItems + 1 }, (_, index) => repo(`acme/r${index}`, 1));
    expect(resolveWidgetTemplate(template, { count: many.length, repos: many }))
      .toMatchObject({ ok: false, error: expect.stringContaining(`最多 ${WIDGET_SOURCE_LIMITS.repeatItems} 项`) });
  });

  it("refuses repeat on the root, nested repeats, and repeat in a template without a data source", () => {
    const onRoot = { ...template, nodes: template.nodes.map((node) => (node.id === "card" ? { ...node, repeat: "repos" } : node)) };
    expect(resolveWidgetTemplate(onRoot, { count: 0, repos: [] })).toMatchObject({ ok: false, error: expect.stringContaining("root") });
    const nested = { ...template, nodes: template.nodes.map((node) => (node.id === "table" ? { ...node, repeat: "item.rows" } : node)) };
    expect(resolveWidgetTemplate(nested, { count: 0, repos: [] })).toMatchObject({ ok: false, error: expect.stringContaining("不能嵌套") });
    expect(buildWidgetSurface(7, template)).toMatchObject({ ok: false, errors: [{ path: "/nodes/2/repeat" }] });
    expect(widgetTemplateBinds({ root: "a", nodes: [{ id: "a", type: "Stack", props: {}, children: ["b"] }, { id: "b", type: "Text", props: { text: "x" }, repeat: "xs" }], fallback_text: "x" }))
      .toBe(true);
  });

  it("renames id references inside a copy (Disclosure detail) and leaves the rest of the card alone", () => {
    const disclosure: WidgetSurfaceInput = {
      root: "card",
      nodes: [
        { id: "card", type: "Stack", props: {}, children: ["repo"] },
        { id: "repo", type: "Disclosure", props: { label: "{{item.name}}", detail: ["table"] }, children: ["line", "table"], repeat: "repos" },
        { id: "line", type: "Text", props: { text: "{{item.name}}" } },
        { id: "table", type: "DataTable", props: { columns: [{ label: "PR" }], rows: { $data: "item.rows" } } },
      ],
      fallback_text: "PR",
    };
    const resolved = resolveWidgetTemplate(disclosure, { repos: [repo("acme/api", 1), repo("acme/web", 1)] });
    expect(resolved.ok && resolved.input.nodes.filter((node) => node.type === "Disclosure").map((node) => [node.props.detail, node.children]))
      .toEqual([[["table-0"], ["line-0", "table-0"]], [["table-1"], ["line-1", "table-1"]]]);
  });

  it("lets a widget have one Disclosure per item, while a conversation card still allows only one", () => {
    const perRepo: WidgetSurfaceInput = {
      root: "card",
      nodes: [
        { id: "card", type: "Stack", props: {}, children: ["head", "repo"] },
        { id: "head", type: "Text", props: { text: "{{count}} 个未合并 PR" } },
        { id: "repo", type: "Disclosure", props: { label: "{{item.name}}", lines: 1, detail: ["table"] }, children: ["line", "table"], repeat: "repos" },
        { id: "line", type: "Text", props: { text: "{{item.name}} · {{item.prs}} 个 PR" } },
        { id: "table", type: "DataTable", props: { columns: [{ label: "PR" }], rows: { $data: "item.rows" } } },
      ],
      fallback_text: "我的未合并 PR",
    };
    const resolved = resolveWidgetTemplate(perRepo, { count: 3, repos: [repo("acme/api", 1), repo("acme/web", 2)] });
    if (!resolved.ok) throw new Error(resolved.error);
    const built = buildWidgetSurface(7, resolved.input);
    expect(built.ok && built.surface.nodes.filter((node) => node.type === "Disclosure")).toHaveLength(2);
    if (!built.ok) return;
    expect(validateUiSurface(built.surface, WIDGET_SURFACE_RULES).ok).toBe(true);
    expect(validateUiSurface(built.surface)).toMatchObject({ ok: false, errors: [{ message: expect.stringContaining("最多一个") }] });
    // 多个也不能互相嵌套。
    const nested = {
      ...built.surface,
      nodes: built.surface.nodes.map((node) => (node.id === "line-0" ? { id: "line-0", type: "Disclosure", props: { label: "x", detail: ["inner"] }, children: ["inner-text", "inner"] } : node))
        .concat([{ id: "inner-text", type: "Text", props: { text: "x" } }, { id: "inner", type: "Text", props: { text: "y" } }]),
    };
    expect(validateUiSurface(nested, WIDGET_SURFACE_RULES)).toMatchObject({ ok: false });
  });
});
