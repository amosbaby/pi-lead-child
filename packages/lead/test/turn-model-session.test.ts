// 「只这一条」（模型配置方案 C 的 D8）：daemon 用会话的 switchModel 换上单轮模型。带推理强度后缀的 id（m(high)）不在目录里，
// 以前只有写进 config.json 的分工才注册得上；单轮模型不改 config.json，所以换模型时要把它和分工的模型一起注册。
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb } from "@pi-lead-child/store";
import { createLeadSession } from "../src/session.js";

let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

async function openAiStub(): Promise<string> {
  server = createServer((req, res) => {
    req.resume();
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`;
}

describe("switching the Lead session to a model outside the chain", () => {
  it("registers an effort suffix that config.json does not list, and leaves config.json alone", async () => {
    const baseUrl = await openAiStub();
    const dataDir = tempDir("plc-lead-turn-model-");
    const config = JSON.stringify({
      lead: {
        providers: { stub: { api: "openai-completions", baseUrl, apiKey: { value: "test" }, discover: false, models: ["m", "n"] } },
        models: ["stub/m"],
      },
    });
    writeFileSync(join(dataDir, "config.json"), config);
    const db = openDb(join(dataDir, "plc.db"));
    const lead = await createLeadSession({ dataDir, dbPath: join(dataDir, "plc.db"), db });
    const session = lead.session as unknown as { dispose(): void };
    try {
      await lead.switchModel("stub/n(high)");
      expect(lead.currentModel()).toBe("stub/n(high)");
      await lead.switchModel("stub/m");
      expect(lead.currentModel()).toBe("stub/m");
      expect(readFileSync(join(dataDir, "config.json"), "utf8")).toBe(config);
    } finally {
      session.dispose();
      db.close();
    }
  }, 30_000);
});
