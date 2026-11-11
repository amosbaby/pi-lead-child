// plc 是 daemon 的客户端，和 companion 平级。它和 daemon 之间的三条通道都是线上契约：
// 网关的管理路由（admin scope）、plc.sock（本机自举和运维）、supervisor.sock（运行时控制）。
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  DESKTOP_NOTIFICATION_BODY_MAX,
  DesktopNotificationEventSchema,
  ADMIN_SCOPE,
  ALL_SCOPES,
  ADMIN_TOKEN_TTL_MS,
  AdminBindingListResponseSchema,
  AdminTokenResponseSchema,
  OwnBindingResponseSchema,
  AishCredentialStatusSchema,
  AishForgetResponseSchema,
  CliCredentialResponseSchema,
  CreatePairingRequestSchema,
  CreatePairingResponseSchema,
  DaemonLocalStatusSchema,
  KERNEL_RUNTIME_IDS,
  LeadDelegationStatusSchema,
  LeadTrustStatusSchema,
  LocalSocketCommandSchema,
  RevokeBindingResponseSchema,
  RuntimeRecheckRequestSchema,
  RuntimeRecheckResponseSchema,
  ScopeSchema,
  SupervisorCommandSchema,
  TICKET_LIST_VIEWS,
  WORKER_NAME_PATTERN,
  WorkerPairResponseSchema,
} from "../src/index.js";

const binding = {
  id: 9, kind: "cli", name: "plc", status: "active",
  scopes: ["chat", "tickets:view", "tickets:create", "approvals:respond", "notices", "admin"],
  lastSeenAt: null, createdAt: "2026-10-13T04:00:00.000Z",
};

describe("the admin scope", () => {
  it("is a recognized scope that the gateway can check", () => {
    expect(ADMIN_SCOPE).toBe("admin");
    expect(Value.Check(ScopeSchema, "admin")).toBe(true);
    expect(ALL_SCOPES).toContain("admin");
  });

  it("covers pairing management", () => {
    expect(Value.Check(CreatePairingRequestSchema, { name: "phone", kind: "companion" })).toBe(true);
    expect(Value.Check(CreatePairingRequestSchema, {
      name: "phone", kind: "companion", endpoint: "ws://192.168.1.10:47130",
    })).toBe(true);
    expect(Value.Check(CreatePairingRequestSchema, { name: "phone", kind: "aish-slack" })).toBe(false);
    // 管理路由不接受 scope 参数：配对码只能换到缺省的 scope，换不到 admin。
    expect(Value.Check(CreatePairingRequestSchema, { name: "phone", kind: "cli", scopes: ["admin"] })).toBe(false);
    expect(Value.Check(CreatePairingResponseSchema, {
      pairingId: 3, code: "PLC-ABCD", expiresAt: "2026-10-13T04:15:00.000Z", uri: null,
    })).toBe(true);
    expect(Value.Check(AdminBindingListResponseSchema, { items: [binding] })).toBe(true);
    expect(Value.Check(RevokeBindingResponseSchema, { binding: { ...binding, status: "revoked" } })).toBe(true);
  });

  it("reports the aish credential without any token field", () => {
    const status = {
      stored: true,
      url: "wss://aish.example/ws/agent",
      failure: { reason: "AUTH_FAILED: Invalid token", at: "2026-10-13T04:00:00.000Z" },
      envToken: "marked_failed",
    };
    expect(Value.Check(AishCredentialStatusSchema, status)).toBe(true);
    expect(Value.Check(AishCredentialStatusSchema, { ...status, token: "secret" })).toBe(false);
    expect(Value.Check(AishForgetResponseSchema, { removed: true, envTokenSet: false })).toBe(true);
  });
});

describe("client routes that plc needs", () => {
  it("rechecks one runtime or all of them", () => {
    expect(KERNEL_RUNTIME_IDS).toEqual(["pi", "codex", "claude"]);
    expect(Value.Check(RuntimeRecheckRequestSchema, {})).toBe(true);
    expect(Value.Check(RuntimeRecheckRequestSchema, { runtime: "codex" })).toBe(true);
    expect(Value.Check(RuntimeRecheckRequestSchema, { runtime: "gemini" })).toBe(false);
    expect(Value.Check(RuntimeRecheckResponseSchema, {
      results: [{ incidentId: 4, runtime: "codex", outcome: "canary_armed", summary: "Codex 认证失败（故障 #4）：重检通过" }],
    })).toBe(true);
  });

  it("names the list views that the gateway serves", () => {
    expect(TICKET_LIST_VIEWS).toEqual(["tasks", "drafts", "reminders", "all"]);
  });

  it("describes the lead trust and delegation status", () => {
    const grant = {
      id: 2, capability: "confirm_item", granted_at: "2026-10-13 04:00:00", granted_via: "cli",
      revoked_at: null, revoked_via: null, note: null,
    };
    expect(Value.Check(LeadTrustStatusSchema, { capability: "confirm_item", grant })).toBe(true);
    expect(Value.Check(LeadTrustStatusSchema, { capability: "confirm_item", grant: null })).toBe(true);
    expect(Value.Check(LeadDelegationStatusSchema, { ticketId: 5, active: null, history: [] })).toBe(true);
  });
});

describe("plc.sock: local bootstrap and ops only", () => {
  it("accepts the credential exchange and the two ops commands", () => {
    expect(Value.Check(LocalSocketCommandSchema, { type: "status", id: "s1" })).toBe(true);
    expect(Value.Check(LocalSocketCommandSchema, { type: "shutdown" })).toBe(true);
    expect(Value.Check(LocalSocketCommandSchema, { type: "cli_credential", id: "c1", name: "plc" })).toBe(true);
    expect(Value.Check(LocalSocketCommandSchema, { type: "admin_token", id: "a1" })).toBe(true);
    // 停机前排空 Lead：supervisor 先发 drain，等回答再发 shutdown。
    expect(Value.Check(LocalSocketCommandSchema, { type: "drain", id: "d1", timeoutMs: 12_000 })).toBe(true);
    expect(Value.Check(LocalSocketCommandSchema, { type: "drain", timeoutMs: 600_000 })).toBe(false);
  });

  // plc worker pair：daemon 签一张只带 worker 权限的凭证，token 写进数据目录里的 0600 文件，回答里不带 token。
  it("accepts the worker pairing, with a name that is safe as a file name, and answers without a token", () => {
    for (const name of ["ethan-cc", "nina.codex_2", "A"]) {
      expect(Value.Check(LocalSocketCommandSchema, { type: "worker_pair", id: "w", name }), name).toBe(true);
      expect(new RegExp(WORKER_NAME_PATTERN).test(name), name).toBe(true);
    }
    for (const name of ["", "../x", "a/b", ".hidden", "-x", "has space", "x".repeat(65), "tab\tname"]) {
      expect(Value.Check(LocalSocketCommandSchema, { type: "worker_pair", name }), name).toBe(false);
    }
    expect(Value.Check(LocalSocketCommandSchema, { type: "worker_pair" })).toBe(false);
    expect(Value.Check(WorkerPairResponseSchema, { bindingId: 4, name: "ethan-cc", path: "/data/worker-tokens/ethan-cc.token" })).toBe(true);
    expect(Value.Check(WorkerPairResponseSchema, { bindingId: 4, name: "ethan-cc", path: "/x", accessToken: "t" })).toBe(false);
  });

  // Bytezard Lead 的 App 订阅桌面通知（P0-7 路径 A）：带口令订阅，daemon 推 DesktopNotificationEvent，发失败的那条交回。
  it("accepts the desktop app's notification subscription and its failure report", () => {
    expect(Value.Check(LocalSocketCommandSchema, { type: "subscribe_desktop_notifications", id: "s", key: "a".repeat(64) })).toBe(true);
    expect(Value.Check(LocalSocketCommandSchema, { type: "subscribe_desktop_notifications" })).toBe(false);
    expect(Value.Check(LocalSocketCommandSchema, { type: "desktop_notification_failed", body: "#12 需要你重新登录" })).toBe(true);
    expect(Value.Check(LocalSocketCommandSchema, { type: "desktop_notification_failed", body: "x".repeat(DESKTOP_NOTIFICATION_BODY_MAX + 1) })).toBe(false);
    expect(Value.Check(DesktopNotificationEventSchema, { type: "desktop_notification", title: "Paimon", body: "#12 需要你重新登录" })).toBe(true);
    expect(Value.Check(DesktopNotificationEventSchema, { type: "desktop_notification", title: "", body: "x" })).toBe(false);
  });

  it("rejects the client commands that moved to the gateway", () => {
    for (const command of [
      { type: "chat", message: "你好" },
      { type: "user_action", target: "item", action: "confirm", target_id: 1 },
      { type: "lead_trust", action: "grant", capability: "confirm_item" },
      { type: "runtime_recheck" },
    ]) {
      expect(Value.Check(LocalSocketCommandSchema, command), command.type).toBe(false);
    }
  });

  it("issues a short-lived admin token that is not a stored credential", () => {
    expect(ADMIN_TOKEN_TTL_MS).toBe(5 * 60_000);
    expect(Value.Check(AdminTokenResponseSchema, {
      accessToken: "tmp", expiresAt: "2026-10-13T04:05:00.000Z", gatewayUrl: "http://127.0.0.1:47130",
    })).toBe(true);
    expect(Value.Check(OwnBindingResponseSchema, { binding: { id: 9, kind: "cli", name: "plc", scopes: ["chat"] } })).toBe(true);
  });

  it("returns a credential and the gateway URL to use", () => {
    expect(Value.Check(CliCredentialResponseSchema, {
      accessToken: "tok",
      binding: { id: 9, kind: "cli", name: "plc", scopes: binding.scopes },
      gatewayUrl: "http://127.0.0.1:47130",
    })).toBe(true);
    expect(Value.Check(DaemonLocalStatusSchema, {
      model: "stub/model", busy: false, pid: 123, clients: 0, sessionId: "s",
      runningChildren: [], runningItemIds: [], aish: null, gatewayUrl: "http://127.0.0.1:47130",
      gatewayExposure: null,
    })).toBe(true);
    expect(Value.Check(DaemonLocalStatusSchema, {
      model: "stub/model", busy: false, pid: 123, clients: 0, sessionId: "s",
      runningChildren: [], runningItemIds: [], aish: null, gatewayUrl: "http://127.0.0.1:47130",
      gatewayExposure: {
        host: "100.64.0.7", port: 47130, state: "retrying", attempts: 2,
        lastError: "listen EADDRNOTAVAIL", nextRetryAt: "2026-10-13T04:00:02.000Z",
      },
    })).toBe(true);
  });
});

describe("supervisor.sock", () => {
  it("accepts the runtime control commands", () => {
    for (const command of [
      { type: "status" },
      { type: "ensure_running", id: "e" },
      { type: "stop_daemon" },
      { type: "request_maintenance", action: "restart", reason: "update aish token" },
      { type: "request_maintenance", action: "upgrade", reason: "schema", requiredSchemaVersion: 17 },
      { type: "shutdown" },
    ]) {
      expect(Value.Check(SupervisorCommandSchema, command), command.type).toBe(true);
    }
    expect(Value.Check(SupervisorCommandSchema, { type: "request_maintenance", action: "reboot", reason: "x" })).toBe(false);
  });
});
