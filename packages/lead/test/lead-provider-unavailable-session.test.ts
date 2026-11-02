// 分工里的服务商启动时拉不到目录（key 错，401）：用真实的 createLeadSession，服务商接到本机的桩上。
// 只有正在用的模型的服务商拉不到时，会话才报告 modelUnavailable（daemon 据此把 Lead 记成降级）；
// 只是备用模型的服务商拉不到时，Lead 照常能用，不报告（以前报告了，健康的主用也显示红点、触发停摆通知）。
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb } from "@pi-lead-child/store";
import { createLeadSession } from "../src/session.js";

let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

// /good/v1/models 给一个模型；/broken/ 下面都是 401。
async function catalogStub(): Promise<string> {
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/broken/")) { res.statusCode = 401; res.end("{}"); return; }
    res.end(JSON.stringify({ data: [{ id: "m" }] }));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

async function startWith(models: string[]) {
  const base = await catalogStub();
  const dataDir = tempDir("plc-lead-provider-unavailable-");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    lead: {
      providers: {
        good: { api: "openai-completions", baseUrl: `${base}/good/v1`, apiKey: { value: "test" }, discover: true },
        broken: { api: "openai-completions", baseUrl: `${base}/broken/v1`, apiKey: { value: "test" }, discover: true },
      },
      models,
    },
  }));
  const db = openDb(join(dataDir, "plc.db"));
  const lead = await createLeadSession({ dataDir, dbPath: join(dataDir, "plc.db"), db });
  (lead.session as unknown as { dispose(): void }).dispose();
  db.close();
  return lead;
}

describe("a chosen provider whose catalog fails at start", () => {
  it("does not mark Lead unavailable when only a fallback model's provider fails", async () => {
    const lead = await startWith(["good/m", "broken/x"]);
    expect(lead.modelName).toBe("good/m");
    expect(lead.modelUnavailable).toBeNull();
  });

  it("marks Lead unavailable, naming the provider, when the model in use is on it", async () => {
    const lead = await startWith(["broken/x", "good/m"]);
    expect(lead.modelName).toBe("broken/x");
    expect(lead.modelUnavailable).toMatch(/^broken: model catalog failed .*401/);
  });
});
