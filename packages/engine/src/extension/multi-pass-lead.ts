// Lead 的 pi-multi-pass 入口（模型配置方案 C 的 S2，.scratch/model-config-c/spec.md D1）：Lead 的 SDK 会话经
// additionalExtensionPaths 加载本文件（lead 的 session.ts）。它读 PLC_MULTI_PASS_ENTRY（multi-pass-package.ts 设置），
// 经 pi 的扩展加载器 import 装好的 pi-multi-pass：pi-multi-pass 引用的 pi 包由加载器提供。
// 每次加载都现读：daemon 运行中第一次装好以后，重新加载 Lead 的扩展就能用上，不用重建会话。
// 没装、加载失败时什么也不做：第 2 个以后的订阅账号用不了，Lead 照常工作。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// multi-pass-package.ts 的 MULTI_PASS_ENTRY_ENV。不 import 它：那会把 pi 的包管理器打进这个扩展的 bundle。
const MULTI_PASS_ENTRY_ENV = "PLC_MULTI_PASS_ENTRY";

export default async function (pi: ExtensionAPI): Promise<void> {
  const entry = process.env[MULTI_PASS_ENTRY_ENV]?.trim();
  if (!entry) return;
  try {
    const loaded = await import(entry) as { default?: unknown };
    if (typeof loaded.default !== "function") throw new Error(`${entry} has no default export`);
    await (loaded.default as (api: ExtensionAPI) => unknown)(pi);
  } catch (error) {
    console.error(`[multi-pass] ${error instanceof Error ? error.message : String(error)}; extra subscription accounts are off`);
  }
}
