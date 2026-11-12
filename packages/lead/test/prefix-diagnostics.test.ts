import { describe, expect, it } from "vitest";
import { fingerprintPayload, firstDivergence, prefixDiagnosticsExtension } from "../src/prefix-diagnostics.js";

const tool = (name: string, description = name) => ({ type: "function", function: { name, description, parameters: {} } });
const payload = (overrides: Record<string, unknown> = {}) => ({
  model: "deepseek-flash",
  messages: [
    { role: "system", content: "你是 Lead" },
    { role: "user", content: "看一下 #12" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1" }] },
    { role: "tool", tool_call_id: "c1", content: "结果" },
  ],
  tools: [tool("get_ticket"), tool("query_tickets")],
  ...overrides,
});
const fp = (value: unknown) => fingerprintPayload(value)!;

describe("prefix diagnostics", () => {
  it("reports an append when only new messages follow the old ones", () => {
    const before = payload();
    const after = payload({ messages: [...before.messages, { role: "user", content: "再看 #13" }] });
    expect(firstDivergence(null, fp(before))).toBe("first");
    expect(firstDivergence(fp(before), fp(after))).toBe("append");
  });

  it("names the first rewritten message", () => {
    const before = payload();
    const messages = [...before.messages];
    messages[3] = { role: "tool", tool_call_id: "c1", content: "[已替换成占位符]" };
    expect(firstDivergence(fp(before), fp(payload({ messages })))).toBe("message 2/3 role=tool");
  });

  it("separates system, tool and model changes", () => {
    const before = fp(payload());
    const system = payload();
    system.messages = [{ role: "system", content: "你是 Lead（改过）" }, ...system.messages.slice(1)];
    expect(firstDivergence(before, fp(system))).toBe("system");
    expect(firstDivergence(before, fp(payload({ tools: [tool("query_tickets"), tool("get_ticket")] })))).toBe("tools:order");
    expect(firstDivergence(before, fp(payload({ tools: [tool("get_ticket", "新说明"), tool("create_task")] }))))
      .toBe("tools:+create_task,-query_tickets,~get_ticket");
    expect(firstDivergence(before, fp(payload({ model: "gpt-4.1-mini" })))).toBe("model");
  });

  it("reports a shorter history after compaction", () => {
    const before = payload();
    const after = payload({ messages: [before.messages[0], { role: "user", content: "摘要" }] });
    expect(firstDivergence(fp(before), fp(after))).toBe("message 0/3 role=user");
    expect(firstDivergence(fp(before), fp(payload({ messages: before.messages.slice(0, 2) })))).toBe("shorter 1/3");
  });

  it("logs positions only, never message text", () => {
    const lines: string[] = [];
    const handlers: Array<(event: { payload: unknown }) => unknown> = [];
    prefixDiagnosticsExtension({ log: (line) => lines.push(line) })({
      on: (_event: string, handler: (event: { payload: unknown }) => unknown) => { handlers.push(handler); },
    } as never);
    const before = payload();
    handlers[0]!({ payload: before });
    handlers[0]!({ payload: payload({ messages: [...before.messages, { role: "user", content: "再看 #13" }] }) });
    handlers[0]!({ payload: { not: "a chat payload" } });
    expect(lines).toEqual([
      "[lead] prefix model=deepseek-flash tools=2 messages=3 diverge=first",
      "[lead] prefix model=deepseek-flash tools=2 messages=4 diverge=append",
    ]);
    expect(lines.join("\n")).not.toContain("#13");
  });
});
