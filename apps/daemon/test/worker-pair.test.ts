// plc worker pair：plc.sock 上的 worker_pair 给外部工人（Claude Code、Codex）签一张只带 worker 权限的凭证。
// token 由 daemon 写进数据目录里的 0600 文件，回答和日志里都没有它；撤销这张凭证放掉它领着的单。
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { WorkerPairResponseSchema, type LocalSocketResponse } from "@pi-lead-child/protocol";
import { authenticateToken, bindingScopes, createItem, getItem, getBinding, listRuns, openDb, type Db } from "@pi-lead-child/store";
import { runTicketAction } from "@pi-lead-child/engine";
import { attachJsonlReader } from "@pi-lead-child/runtime";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { pairWorker } from "../src/worker-pairing.js";

let dir: string;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
let logged: string[] = [];
let ledger: Db | null = null;

const sessionFactory = async () => ({
  modelName: "stub/model",
  session: {
    sessionId: "stub-session",
    subscribe() { return () => {}; },
    async prompt() {},
    async steer() {},
    async followUp() {},
    dispose() {},
  },
});

beforeEach(async () => {
  dir = tempDir("plc-worker-pair-");
  logged = [];
  daemon = await startDaemon({
    dataDir: dir, dbPath: join(dir, "plc.db"), sessionFactory: sessionFactory as never, log: (line: string) => { logged.push(line); },
  });
});

afterEach(async () => {
  ledger?.close();
  ledger = null;
  await daemon?.close();
  daemon = null;
});

const db = (): Db => (ledger ??= openDb(join(dir, "plc.db")));

function request<T>(command: object): Promise<LocalSocketResponse<T>> {
  return new Promise((resolve, reject) => {
    const socket = connect(daemon!.sockPath);
    socket.once("error", reject);
    attachJsonlReader(socket, (line) => {
      const message = JSON.parse(line) as LocalSocketResponse<T>;
      if (message.type !== "response") return;
      socket.end();
      resolve(message);
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(command)}\n`));
  });
}

type Paired = { bindingId: number; name: string; path: string };

describe("worker_pair on plc.sock", () => {
  it("signs a worker-only credential and writes the token to a 0600 file, never into the answer or the log", async () => {
    const response = await request<Paired>({ type: "worker_pair", id: "w", name: "ethan-cc" });
    expect(response.success).toBe(true);
    expect(Value.Check(WorkerPairResponseSchema, response.data)).toBe(true);
    const { bindingId, path } = response.data!;
    expect(path).toBe(join(dir, "worker-tokens", "ethan-cc.token"));

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "worker-tokens")).mode & 0o777).toBe(0o700);
    // no temporary file left behind
    expect(readdirSync(join(dir, "worker-tokens"))).toEqual(["ethan-cc.token"]);

    const token = readFileSync(path, "utf8").trim();
    expect(token.length).toBeGreaterThan(20);
    expect(JSON.stringify(response)).not.toContain(token);
    expect(logged.join("\n")).not.toContain(token);
    expect(logged.join("\n")).toContain(`binding #${bindingId}`);

    const binding = getBinding(db(), bindingId)!;
    expect(binding).toMatchObject({ kind: "cli", display_name: "ethan-cc", status: "active" });
    expect(bindingScopes(binding)).toEqual(["worker"]);
    expect(authenticateToken(db(), token)?.id).toBe(bindingId);
  });

  it("gives the worker no other access on the gateway", async () => {
    const { data } = await request<Paired>({ type: "worker_pair", name: "ethan-cc" });
    const token = readFileSync(data!.path, "utf8").trim();
    const gatewayUrl = `http://127.0.0.1:${daemon!.pairedPort}`;
    const headers = { authorization: `Bearer ${token}` };
    expect((await fetch(`${gatewayUrl}/v1/admin/bindings`, { headers })).status).toBe(403);
    expect((await fetch(`${gatewayUrl}/v1/execution-mode`, { headers })).status).toBe(403);
    expect((await fetch(`${gatewayUrl}/v1/tickets`, { headers })).status).toBe(403);
  });

  it("refuses a second live worker with the same name and keeps the first token file", async () => {
    const first = await request<Paired>({ type: "worker_pair", name: "ethan-cc" });
    const before = readFileSync(first.data!.path, "utf8");
    const second = await request({ type: "worker_pair", name: "ethan-cc" });
    expect(second.success).toBe(false);
    expect(second.error).toContain(`plc pair revoke ${first.data!.bindingId}`);
    expect(readFileSync(first.data!.path, "utf8")).toBe(before);
    expect((db().prepare("SELECT COUNT(*) AS n FROM bindings WHERE display_name = 'ethan-cc'").get() as { n: number }).n).toBe(1);
  });

  it("rejects a name that could leave the token directory, and writes nothing", async () => {
    for (const name of ["../escape", "a/b", ".hidden", ""]) {
      expect((await request({ type: "worker_pair", name })).success, name).toBe(false);
    }
    expect(existsSync(join(dir, "worker-tokens"))).toBe(false);
    expect(existsSync(join(dir, "escape.token"))).toBe(false);
  });

  it("revokes the credential it just signed when the token file cannot be written", () => {
    const blocked = tempDir("plc-worker-pair-blocked-");
    // a regular file where the token directory should be
    writeFileSync(join(blocked, "worker-tokens"), "not a directory");
    expect(() => pairWorker(db(), blocked, "ethan-cc")).toThrow();
    expect(db().prepare("SELECT status FROM bindings WHERE display_name = 'ethan-cc'").all()).toEqual([{ status: "revoked" }]);
  });

  it("revoking the credential over the admin route releases the tickets the worker holds", async () => {
    const paired = await request<Paired>({ type: "worker_pair", name: "ethan-cc" });
    const { bindingId } = paired.data!;
    const itemId = createItem(db(), { title: "fix the retry policy", brief: "drops the last attempt", createdBy: "user" });
    await runTicketAction(db(), { itemId, action: "worker.claim", input: {}, caller: { kind: "worker", bindingId, workerName: "ethan-cc" } });
    expect(getItem(db(), itemId)!.stage).toBe("active");

    const admin = await request<{ accessToken: string; gatewayUrl: string }>({ type: "admin_token" });
    const revoke = await fetch(`${admin.data!.gatewayUrl}/v1/admin/bindings/${bindingId}/revoke`, {
      method: "POST", headers: { authorization: `Bearer ${admin.data!.accessToken}` },
    });
    expect(revoke.status).toBe(200);

    expect(getBinding(db(), bindingId)?.status).toBe("revoked");
    expect(getItem(db(), itemId)!.stage).toBe("ready");
    expect(listRuns(db(), itemId)).toMatchObject([{ runtime: "external", state: "stopped" }]);
  });
});
