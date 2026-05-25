/**
 * Single source of truth mapping the user-facing llm_tier choice
 * (Haiku / Sonnet / Opus) to the concrete Anthropic model ID used at
 * messages.create() call time.
 *
 * Add a new tier here AND in any zod schema that validates user input
 * (see src/routes/generated-apps.ts PATCH /config). Removing a tier
 * here without updating callers will cause resolveModelForTier to
 * throw at runtime — which is the intended fail-fast behavior.
 */

export const LLM_TIER_TO_MODEL: Record<string, string> = {
  haiku:  "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-20250514",
  opus:   "claude-opus-4-20250514",
};

export type LlmTier = keyof typeof LLM_TIER_TO_MODEL;

/**
 * Resolve a user-supplied tier string to the Anthropic model ID.
 * Throws on unknown input — do NOT fall back silently to Sonnet.
 * Callers are expected to validate tier earlier (zod schema, defaults
 * at config-read time, etc.). This is the last-line check.
 */
export function resolveModelForTier(tier: string): string {
  const model = LLM_TIER_TO_MODEL[tier];
  if (!model) {
    throw new Error(
      `unknown_llm_tier: '${tier}' (valid: ${Object.keys(LLM_TIER_TO_MODEL).join(", ")})`,
    );
  }
  return model;
}
