// The daemon never sends a request to a Claude-family model (hub spec: it only routes tickets; the workers do the thinking).
// Every place that is about to pick or call a model through an HTTP endpoint asks this first: Lead's own model, the
// SmartModel LLM backend, Hindsight's summary model, and the provider catalog. A proxy that forwards to Claude is still
// Claude, so the model name counts as well as the provider and the host.
export interface ClaudeTargetInput {
  provider?: string | null | undefined;
  model?: string | null | undefined;
  baseUrl?: string | null | undefined;
}

const CLAUDE_PROVIDERS = new Set(["anthropic", "claude-code"]);
const CLAUDE_MODEL = /claude|haiku|sonnet|opus|fable/i;
const CLAUDE_HOSTS = new Set(["api.anthropic.com"]);

function hostOf(baseUrl: string): string | null {
  const text = baseUrl.trim();
  if (!text) return null;
  for (const candidate of [text, `https://${text}`]) {
    try {
      return new URL(candidate).hostname.toLowerCase();
    } catch {
      // try the next form
    }
  }
  return null;
}

/** True when the provider, the model name or the endpoint's host says the request would reach a Claude model. */
export function isClaudeTarget(target: ClaudeTargetInput): boolean {
  const provider = target.provider?.trim().toLowerCase();
  if (provider && CLAUDE_PROVIDERS.has(provider)) return true;
  if (target.model && CLAUDE_MODEL.test(target.model)) return true;
  const host = target.baseUrl ? hostOf(target.baseUrl) : null;
  return host !== null && CLAUDE_HOSTS.has(host);
}
