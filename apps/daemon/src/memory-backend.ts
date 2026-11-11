// Hindsight 记忆服务的两样启动参数（memory-controller.ts 用）：launchd 运行的命令，和 Hindsight 的摘要模型。
import { existsSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { distDir, isClaudeTarget, packageSource, projectRoot } from "@pi-lead-child/core";
import { claudeGuardMessages, loadLeadModelConfig, parseModelName, resolveLeadApiKey } from "@pi-lead-child/lead";
import type { Locale, SummaryModelSlot, SummaryModelSource } from "@pi-lead-child/protocol";
import { AGENT_MEMORY_LAUNCH_NAME } from "@pi-lead-child/supervisor";

// supervisor 运行 Hindsight 的命令（写进 run.json）。和 supervisor 运行 daemon 的方式一样：有构建产物用它，PLC_DEV 或者
// 没构建时经 tsx 跑源码。程序是 Node 旁边的软链接 Bytezard Lead Memory（运行包和装过后台服务的开发机都有，supervisor 的
// agent-binary.ts），ps 和日志里一眼看得出是记忆服务。它以前是独立的 launchd 任务，「允许在后台」显示程序的文件名
// （用户 2026-11-05）。没有这个软链接时用 Node 本身。
export function hindsightProgram(env: Record<string, string | undefined> = process.env, execPath: string = process.execPath): string[] {
  const node = memoryLauncher(execPath) ?? execPath;
  const dist = join(distDir(), "hindsight.mjs");
  if (existsSync(dist) && !env.PLC_DEV) return [node, dist];
  return [node, join(projectRoot(), "node_modules", "tsx", "dist", "cli.mjs"), packageSource("daemon", "hindsight-main.ts")];
}

function memoryLauncher(execPath: string): string | null {
  const launcher = join(dirname(execPath), AGENT_MEMORY_LAUNCH_NAME);
  try {
    return lstatSync(launcher).isSymbolicLink() ? launcher : null;
  } catch {
    return null;
  }
}

// 一个摘要模型：服务商、模型 id、地址和 key。地址和 key 在 daemon 里按 Lead 的服务商配置解析好（key 进 secrets.sealed）：
// hindsight-main 不读 config.json，也不把 Keychain 读进 Hindsight 的环境（2026-10-16 发布评审）。
export interface HindsightLlm {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string | null;
}

// 一个槽的模型和它是怎样选出来的（protocol 的 memory-hindsight.ts）。
export interface SummaryModelChoice {
  slot: SummaryModelSlot;
  // 现在用的模型（provider/id）。
  spec: string | null;
  source: SummaryModelSource;
  // 存在设置里的选择（config.json 的 memory.llm）。
  setting: string | null;
  problem: string | null;
  llm: HindsightLlm | null;
}

export type SummaryModels = Record<SummaryModelSlot, SummaryModelChoice>;

// config.json 的 memory.llm：每个槽存一个 provider/id。没有时缺省槽自动选，整理观察槽跟缺省一样。
export interface SummaryModelSettings {
  default?: string | null;
  consolidation?: string | null;
}

/**
 * Hindsight 的两个摘要模型（.scratch/hindsight-primary-memory/spec.md D16）。
 * - 缺省：环境变量 PLC_HINDSIGHT_LLM > 设置页的选择。都没有时是 none：Hindsight 只召回，不提取新事实。
 *   以前缺省自动选 Lead 目录里最新的 haiku；daemon 不向 Claude 系的模型发请求，这一步删掉了。
 * - 整理观察：设置页的选择；没选时跟缺省一样（inherit）。
 * 选的模型用不了（服务商不在 lead.providers 里，或者是 Claude 系的）时写明原因，再按下一个来源选。
 * 一个 Claude 系的模型不会变成 llm：这个槽没有模型，Hindsight 只召回（plc doctor 报出配置里的 Claude 模型）。
 */
export async function summaryModels(
  dir: string, settings: SummaryModelSettings = {},
  env: Record<string, string | undefined> = process.env, locale: Locale = "en",
): Promise<SummaryModels> {
  const config = loadLeadModelConfig(dir, env);
  const resolve = (spec: string): HindsightLlm | string => {
    let parsed: { provider: string; id: string };
    try {
      parsed = parseModelName(spec);
    } catch {
      return `${spec} 不是 provider/model 的写法`;
    }
    const provider = config.providers[parsed.provider];
    if (!provider) return `服务商 ${parsed.provider} 不在设置 → 模型的服务商里（config.json 的 lead.providers）`;
    if (isClaudeTarget({ provider: parsed.provider, model: parsed.id, baseUrl: provider.baseUrl })) return claudeGuardMessages(locale).modelRefused(spec);
    return { provider: parsed.provider, model: parsed.id, baseUrl: provider.baseUrl, apiKey: resolveLeadApiKey(provider, env, parsed.provider) ?? null };
  };
  const chosen = (slot: SummaryModelSlot, spec: string, source: SummaryModelSource, setting: string | null, problem: string | null): SummaryModelChoice | string => {
    const llm = resolve(spec);
    return typeof llm === "string" ? llm : { slot, spec, source, setting, problem, llm };
  };

  const problems: string[] = [];
  const settingDefault = settings.default?.trim() || null;
  let picked: SummaryModelChoice | null = null;
  const explicit = env.PLC_HINDSIGHT_LLM?.trim();
  if (explicit) {
    const result = chosen("default", explicit, "env", settingDefault,
      settingDefault ? `环境变量 PLC_HINDSIGHT_LLM 盖住了这里的选择（${settingDefault}）` : null);
    if (typeof result === "string") problems.push(`PLC_HINDSIGHT_LLM=${explicit}：${result}`);
    else picked = result;
  }
  if (!picked && settingDefault) {
    const result = chosen("default", settingDefault, "settings", settingDefault, null);
    if (typeof result === "string") problems.push(result);
    else picked = result;
  }
  const fallbackProblem = problems.length ? problems.join("；") : null;
  const defaultChoice: SummaryModelChoice = picked
    ? { ...picked, problem: [picked.problem, fallbackProblem].filter(Boolean).join("；") || null }
    : { slot: "default", spec: null, source: "none", setting: settingDefault, problem: fallbackProblem, llm: null };

  const settingConsolidation = settings.consolidation?.trim() || null;
  let consolidation: SummaryModelChoice | null = null;
  let consolidationProblem: string | null = null;
  if (settingConsolidation) {
    const result = chosen("consolidation", settingConsolidation, "settings", settingConsolidation, null);
    if (typeof result === "string") consolidationProblem = result;
    else consolidation = result;
  }
  consolidation ??= {
    slot: "consolidation", spec: defaultChoice.spec, source: defaultChoice.llm ? "inherit" : "none",
    setting: settingConsolidation, problem: consolidationProblem, llm: defaultChoice.llm,
  };
  return { default: defaultChoice, consolidation };
}
