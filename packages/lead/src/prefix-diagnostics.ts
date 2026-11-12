// 提示缓存的前缀诊断（2026-11-12，用户：Lead 用 DeepSeek 时缓存命中率低）。
// DeepSeek 一类的模型按前缀自动缓存：只有从第一个 token 起逐字相同的部分才能命中。
// 这个扩展在每次发请求前给 system、工具表和每一条消息各算一个哈希，和上一次请求比，日志里记第一处不同在哪：
//   append        只在末尾追加，前缀没变（正常）
//   system        系统提示词变了
//   tools:...     工具表变了（加了、删了、说明变了、或者只是顺序变了）
//   message i/n   第 i 条消息被改写了（role 写在后面）
//   shorter i/n   消息变少了，从第 i 条起不一样（压缩以后正常）
// 只记位置和名字，不记内容。PLC_LEAD_PREFIX_DIAGNOSTICS=off 关掉。
import { createHash } from "node:crypto";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export interface PrefixFingerprint {
  model: string;
  system: string;
  tools: Array<{ name: string; hash: string }>;
  messages: Array<{ role: string; hash: string }>;
}

function hash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value) ?? "").digest("hex").slice(0, 12);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function toolName(tool: unknown): string {
  const item = record(tool);
  const fn = record(item?.function);
  const name = fn?.name ?? item?.name;
  return typeof name === "string" ? name : "?";
}

/**
 * 从发给模型的请求体里取指纹。认 OpenAI Chat Completions（messages 开头的 system/developer 消息）和
 * Anthropic Messages（顶层 system）两种形状；都不是时返回 null。
 */
export function fingerprintPayload(payload: unknown): PrefixFingerprint | null {
  const body = record(payload);
  if (!body || !Array.isArray(body.messages)) return null;
  const messages = body.messages as unknown[];
  const leading: unknown[] = [];
  let index = 0;
  for (; index < messages.length; index++) {
    const role = record(messages[index])?.role;
    if (role !== "system" && role !== "developer") break;
    leading.push(messages[index]);
  }
  return {
    model: typeof body.model === "string" ? body.model : "?",
    system: hash(body.system !== undefined ? [body.system, leading] : leading),
    tools: (Array.isArray(body.tools) ? body.tools : []).map((tool) => ({ name: toolName(tool), hash: hash(tool) })),
    messages: messages.slice(index).map((message) => {
      const role = record(message)?.role;
      return { role: typeof role === "string" ? role : "?", hash: hash(message) };
    }),
  };
}

function describeToolChange(before: PrefixFingerprint["tools"], after: PrefixFingerprint["tools"]): string {
  const old = new Map(before.map((tool) => [tool.name, tool.hash]));
  const now = new Map(after.map((tool) => [tool.name, tool.hash]));
  const added = after.filter((tool) => !old.has(tool.name)).map((tool) => `+${tool.name}`);
  const removed = before.filter((tool) => !now.has(tool.name)).map((tool) => `-${tool.name}`);
  const changed = after.filter((tool) => old.has(tool.name) && old.get(tool.name) !== tool.hash).map((tool) => `~${tool.name}`);
  const parts = [...added, ...removed, ...changed];
  return `tools:${parts.length > 0 ? parts.join(",") : "order"}`;
}

/** 两次请求的前缀从哪里开始不一样。没有上一次时是 first；换了模型时是 model（缓存本来就不共享）。 */
export function firstDivergence(before: PrefixFingerprint | null, after: PrefixFingerprint): string {
  if (!before) return "first";
  if (before.model !== after.model) return "model";
  if (before.system !== after.system) return "system";
  const toolsSame = before.tools.length === after.tools.length
    && before.tools.every((tool, i) => tool.name === after.tools[i]!.name && tool.hash === after.tools[i]!.hash);
  if (!toolsSame) return describeToolChange(before.tools, after.tools);
  const shared = Math.min(before.messages.length, after.messages.length);
  for (let i = 0; i < shared; i++) {
    if (before.messages[i]!.hash !== after.messages[i]!.hash) {
      return `message ${i}/${before.messages.length} role=${after.messages[i]!.role}`;
    }
  }
  return after.messages.length >= before.messages.length ? "append" : `shorter ${shared}/${before.messages.length}`;
}

export function prefixDiagnosticsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.PLC_LEAD_PREFIX_DIAGNOSTICS?.trim().toLowerCase() !== "off";
}

export function prefixDiagnosticsExtension(options: { log?: (line: string) => void } = {}): ExtensionFactory {
  const log = options.log ?? ((line: string) => console.error(line));
  return (pi) => {
    let previous: PrefixFingerprint | null = null;
    pi.on("before_provider_request", (event) => {
      try {
        const next = fingerprintPayload(event.payload);
        if (!next) return undefined;
        const where = firstDivergence(previous, next);
        previous = next;
        log(`[lead] prefix model=${next.model} tools=${next.tools.length} messages=${next.messages.length} diverge=${where}`);
      } catch (error) {
        log(`[lead] prefix diagnostics failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return undefined;
    });
  };
}
