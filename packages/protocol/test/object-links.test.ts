// 会话文字里指向对象的链接（设计规范 P14.7）：App 认 plc:ticket/N 和 plc:card/N，别的地方换成链接的文字。
import { describe, expect, it } from "vitest";
import { objectLinkHref, parseObjectLink, plainObjectLinks } from "../src/index.js";

describe("object links", () => {
  it("read a ticket or a card address, and nothing else", () => {
    expect(parseObjectLink("plc:ticket/165")).toEqual({ kind: "ticket", id: 165 });
    expect(parseObjectLink("plc:card/134")).toEqual({ kind: "card", id: 134 });
    expect(parseObjectLink(objectLinkHref({ kind: "card", id: 7 }))).toEqual({ kind: "card", id: 7 });
    for (const href of ["plc:run/217", "plc:ticket/0", "plc:ticket/abc", "https://example.com", "plc:card/1/x", "", null]) {
      expect(parseObjectLink(href)).toBeNull();
    }
  });

  it("turn object links into their words for places that cannot open them", () => {
    expect(plainObjectLinks("回 [Ethan 的私信](plc:card/134) 的草稿放好了，[#165](plc:ticket/165) 这次执行跑完了。"))
      .toBe("回 Ethan 的私信 的草稿放好了，#165 这次执行跑完了。");
    expect(plainObjectLinks("[文档](https://example.com)")).toBe("[文档](https://example.com)");
  });
});
