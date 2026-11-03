// 测试用的本地 MCP 服务器：一行一条 JSON-RPC（stdio 传输）。只做 initialize、tools/list、tools/call。
// 参数：--no-tools 没有工具；--crash 一启动就退出（stderr 写一句）。
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--crash")) {
  process.stderr.write("fake server: missing configuration\n");
  process.exit(1);
}
const tools = args.includes("--no-tools") ? [] : [
  { name: "echo", description: "Echo the text back.", inputSchema: { type: "object", properties: { text: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "env", description: "Report the process environment.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
];

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools } });
  } else if (message.method === "tools/call") {
    const { name, arguments: input } = message.params;
    const text = name === "echo" ? String(input?.text ?? "")
      : JSON.stringify({
        pid: process.pid,
        hasSecret: process.env.PLC_FAKE_SECRET !== undefined,
        ignoreScripts: process.env.npm_config_ignore_scripts ?? null,
        cwd: process.cwd(),
      });
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }] } });
  } else {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
  }
});
