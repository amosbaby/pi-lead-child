// 外部工人的权限 worker（.scratch/external-worker-hub/spec.md P1-5）：它是一个认得出的 scope，但永远不在任何缺省授予的清单里。
// 只有 plc worker pair 单独配对的凭证带它；网页、plc 的 CLI 凭证、本机自动配对都不能领单。
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { ALL_SCOPES, ScopeSchema } from "@pi-lead-child/protocol";
import { bindingScopes, CLI_CREDENTIAL_SCOPES, DEFAULT_SCOPES, LOOPBACK_AUTO_PAIR_SCOPES } from "../src/index.js";

describe("the worker scope", () => {
  it("is a recognized scope, and a stored worker scope survives reading", () => {
    expect(Value.Check(ScopeSchema, "worker")).toBe(true);
    expect(ALL_SCOPES).toContain("worker");
    expect(bindingScopes({ scopes: JSON.stringify(["worker"]), kind: "companion", origin: "loopback_web" })).toEqual(["worker"]);
  });

  it("is never granted by default", () => {
    expect(DEFAULT_SCOPES).not.toContain("worker");
    expect(CLI_CREDENTIAL_SCOPES).not.toContain("worker");
    expect(LOOPBACK_AUTO_PAIR_SCOPES).not.toContain("worker");
  });
});
