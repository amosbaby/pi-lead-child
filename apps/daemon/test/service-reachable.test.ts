// serviceReachable（network.ts，2026-11-16）：模型熔断放一次调用以前，免费看一眼模型服务的地址连不连得上。只做 TCP 连接，不发请求。
import { createServer, type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { serviceReachable } from "../src/network.js";

describe("serviceReachable", () => {
  it("is true while something listens on the address, and false after it stops, without sending a request", async () => {
    let received = 0;
    const server = createServer((socket) => {
      socket.on("data", (chunk) => { received += chunk.length; });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    expect(await serviceReachable(`http://127.0.0.1:${port}/v1`)).toBe(true);
    expect(received).toBe(0);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await serviceReachable(`http://127.0.0.1:${port}/v1`)).toBe(false);
  });

  it("is false for an address that cannot be parsed", async () => {
    expect(await serviceReachable("not a url")).toBe(false);
  });
});
