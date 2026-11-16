// 「只这一条」（模型配置方案 C 的 D8）：chat.send 的可选单轮模型，和会话里换模型的浮层要的 inSession。
// 两个都是严格契约上的可选字段：旧客户端、旧 daemon 不带也照样通过。
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";

import { CHAT_TURN_MODEL_CAPABILITY, ChatSendCommandSchema, LEAD_MODELS_LIVE_QUERY, LeadModelCatalogSchema } from "../src/index.js";

const command = { type: "chat.send", id: "cmd-1", protocolVersion: 2, message: "Think harder" };
const catalog = {
  current: { model: "openai-codex/gpt-5.5", effort: null },
  selected: { model: "openai-codex/gpt-5.5", effort: null },
  models: [],
};

describe("the one-message model on the wire", () => {
  it("lets chat.send carry a model and an effort, and nothing else", () => {
    expect(Value.Check(ChatSendCommandSchema, command)).toBe(true);
    expect(Value.Check(ChatSendCommandSchema, { ...command, turnModel: { model: "vibeproxy/claude-opus-5-5", effort: "high" } })).toBe(true);
    expect(Value.Check(ChatSendCommandSchema, { ...command, turnModel: { model: "openai-codex-2/gpt-5.5", effort: null } })).toBe(true);
    expect(Value.Check(ChatSendCommandSchema, { ...command, turnModel: { model: "vibeproxy/claude-opus-5-5" } })).toBe(false);
    expect(Value.Check(ChatSendCommandSchema, { ...command, turnModel: { model: "x", effort: null } })).toBe(false);
    expect(Value.Check(ChatSendCommandSchema, { ...command, turnModel: { model: "vibeproxy/claude", effort: "high!" } })).toBe(false);
    expect(Value.Check(ChatSendCommandSchema, { ...command, turnModel: { model: "vibeproxy/claude", effort: null, persist: true } })).toBe(false);
  });

  it("names the capability and the opt-in query", () => {
    expect(CHAT_TURN_MODEL_CAPABILITY).toBe("chat.turn-model.v1");
    expect(LEAD_MODELS_LIVE_QUERY).toBe("live=1");
  });

  it("keeps inSession optional in the model catalog", () => {
    expect(Value.Check(LeadModelCatalogSchema, catalog)).toBe(true);
    expect(Value.Check(LeadModelCatalogSchema, { ...catalog, inSession: "openai-codex-2/gpt-5.5" })).toBe(true);
    expect(Value.Check(LeadModelCatalogSchema, { ...catalog, inSession: null })).toBe(true);
    expect(Value.Check(LeadModelCatalogSchema, { ...catalog, account: "x" })).toBe(false);
  });
});
