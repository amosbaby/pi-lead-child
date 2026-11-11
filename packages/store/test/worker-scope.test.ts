// 外部工人的权限 worker（.scratch/external-worker-hub/spec.md P1-5）：它是一个认得出的 scope，但永远不在任何缺省授予的清单里。
// 只有 plc worker pair 单独配对的凭证带它；网页、plc 的 CLI 凭证、本机自动配对都不能领单。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { tempDir } from "@pi-lead-child/core/testing";
import { ALL_SCOPES, ScopeSchema } from "@pi-lead-child/protocol";
import {
  authenticateToken, bindingScopes, CLI_CREDENTIAL_SCOPES, createWorkerBinding, DEFAULT_SCOPES, LOOPBACK_AUTO_PAIR_SCOPES, openDb,
  revokeBinding, WorkerNameTakenError,
} from "../src/index.js";

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

describe("a worker binding (plc worker pair)", () => {
  it("carries only the worker scope, and a token that authenticates", () => {
    const db = openDb(join(tempDir("plc-worker-binding-"), "plc.db"));
    try {
      const { binding, accessToken } = createWorkerBinding(db, { name: "ethan-cc" });
      expect(binding).toMatchObject({ kind: "cli", display_name: "ethan-cc", status: "active", origin: "cli" });
      expect(bindingScopes(binding)).toEqual(["worker"]);
      // the token authenticates, and only its hash is stored
      expect(authenticateToken(db, accessToken)?.id).toBe(binding.id);
      expect(JSON.stringify(db.prepare("SELECT * FROM bindings WHERE id = ?").get(binding.id))).not.toContain(accessToken);
    } finally {
      db.close();
    }
  });

  it("refuses a second live worker with the same name, and allows it after a revoke", () => {
    const db = openDb(join(tempDir("plc-worker-binding-"), "plc.db"));
    try {
      const first = createWorkerBinding(db, { name: "ethan-cc" });
      expect(() => createWorkerBinding(db, { name: "ethan-cc" })).toThrow(WorkerNameTakenError);
      expect(createWorkerBinding(db, { name: "nina-codex" }).binding.id).toBeGreaterThan(first.binding.id);
      revokeBinding(db, first.binding.id);
      expect(createWorkerBinding(db, { name: "ethan-cc" }).binding.id).toBeGreaterThan(first.binding.id);
    } finally {
      db.close();
    }
  });
});
