// 用户引用了外来消息里对方的话（设计规范 P17.9）：这一轮记下带着外部内容，只对改规则有用；external 不变，
// 所以这一轮照旧是用户本人的一轮（bash 照用，用户本人正在说话的豁免照旧）。
import { describe, expect, it } from "vitest";
import { externalContentOf, QUOTED_EXTERNAL_TEXT, withExternalContent } from "../src/turn-origin.js";

describe("a user turn that quotes an external message", () => {
  it("carries external content for rule changes without becoming an external turn", () => {
    const origin = withExternalContent({ external: false, timer: null }, { via: "tool", tool: QUOTED_EXTERNAL_TEXT });
    expect(origin.external).toBe(false);
    expect(externalContentOf({ turnOrigin: () => origin })).toEqual([{ via: "tool", tool: QUOTED_EXTERNAL_TEXT }]);
  });

  it("is recorded once however many external quotes the turn has", () => {
    const once = withExternalContent({ external: false, timer: null }, { via: "tool", tool: QUOTED_EXTERNAL_TEXT });
    expect(withExternalContent(once, { via: "tool", tool: QUOTED_EXTERNAL_TEXT }).externalBy).toHaveLength(1);
  });
});
