// Where the configuration still names a Claude model. The daemon refuses every one of them (it never sends requests to
// Claude), so nothing here is called; `plc doctor` lists them so the user can pick another model. Read-only.
import { isClaudeTarget, loadPlcConfig } from "@pi-lead-child/core";
import { isClaudeLeadSpec, loadLeadModelConfig, refusedLeadModels } from "@pi-lead-child/lead";
import { readServiceFile } from "@pi-lead-child/supervisor";
import { decisionEntryInputs, loadDecisionModels } from "./decision-models.js";

export interface ClaudeModelTarget {
  where: string;
  spec: string;
}

export function collectClaudeModelTargets(
  dataDir: string, env: Record<string, string | undefined> = process.env,
): ClaudeModelTarget[] {
  const found: ClaudeModelTarget[] = [];
  const add = (where: string, spec: string | null | undefined) => {
    if (spec) found.push({ where, spec });
  };
  const lead = loadLeadModelConfig(dataDir, env);
  for (const spec of refusedLeadModels(lead, env)) add("Lead model", spec);
  for (const [name, provider] of Object.entries(lead.providers)) {
    if (isClaudeTarget({ provider: name, baseUrl: provider.baseUrl })) add(`lead.providers.${name}`, provider.baseUrl);
  }
  const smart = env.PLC_SMART_MODEL?.trim();
  if (smart && isClaudeLeadSpec(smart, lead)) add("PLC_SMART_MODEL", smart);
  const fallback = loadDecisionModels(dataDir).llmFallback;
  if (fallback && isClaudeLeadSpec(fallback, lead)) add("decision.llmFallback", fallback);
  // Decision (intuition) entries are loaded as "problem" entries when they are Claude: read the raw config here.
  for (const entry of decisionEntryInputs(dataDir)) {
    if (isClaudeTarget({ model: entry.model, baseUrl: entry.baseUrl })) add(`decision.models.${entry.id}`, `${entry.model} (${entry.baseUrl})`);
  }
  const memory = loadPlcConfig(dataDir).memory?.llm ?? {};
  for (const slot of ["default", "consolidation"] as const) {
    const spec = memory[slot];
    if (spec && isClaudeLeadSpec(spec, lead)) add(`memory.llm.${slot}`, spec);
  }
  const hindsight = env.PLC_HINDSIGHT_LLM?.trim();
  if (hindsight && isClaudeLeadSpec(hindsight, lead)) add("PLC_HINDSIGHT_LLM", hindsight);
  // service.json is what hindsight-main reads; an older daemon may have written a Claude model there.
  const service = readServiceFile(dataDir);
  for (const [slot, target] of [["llm", service?.llm], ["consolidationLlm", service?.consolidationLlm]] as const) {
    if (target && isClaudeTarget(target)) add(`hindsight service.json ${slot}`, `${target.provider}/${target.model}`);
  }
  return found;
}
