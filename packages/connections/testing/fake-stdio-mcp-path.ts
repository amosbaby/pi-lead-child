// 测试用的本地 MCP 服务器（fake-stdio-mcp.mjs）的路径：连接中心的 localCommand 用 node 直接跑它，不经过 npx。
import { fileURLToPath } from "node:url";

export const FAKE_STDIO_MCP = fileURLToPath(new URL("./fake-stdio-mcp.mjs", import.meta.url));
