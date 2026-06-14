import type { SupabaseClient } from "@supabase/supabase-js";

export interface ModelConfig {
  haiku:  string;
  sonnet: string;
  opus:   string;
}

const TIER_SLUGS: Record<keyof ModelConfig, string> = {
  haiku:  "anthropic-claude-haiku",
  sonnet: "anthropic-claude-sonnet",
  opus:   "anthropic-claude-opus",
};

/**
 * Load the active model ID for each Anthropic tier from external_apis.metadata.model.
 * Called once per orchestrator run; result is threaded into every TaskCtx as tc.models.
 *
 * Throws loudly if any tier row is missing or metadata.model is null/empty.
 * Per NO-FALLBACKS: callers must NOT catch and silently default — let the error
 * surface as a task failure so misconfiguration is visible immediately.
 *
 * To change which model a tier uses: update the row in Supabase via the admin
 * Models panel (/admin/models) — no code change or redeploy required.
 */
export async function loadModelConfig(supabase: SupabaseClient): Promise<ModelConfig> {
  const slugs = Object.values(TIER_SLUGS);
  const { data, error } = await supabase
    .from("external_apis")
    .select("slug, metadata")
    .in("slug", slugs);

  if (error) {
    throw new Error(`model_config_load_failed: ${error.message}`);
  }

  const bySlug: Record<string, string | undefined> = {};
  for (const row of data ?? []) {
    const model = (row.metadata as Record<string, unknown>)?.model;
    bySlug[row.slug as string] = typeof model === "string" && model.length > 0 ? model : undefined;
  }

  const result = {} as ModelConfig;
  for (const [tier, slug] of Object.entries(TIER_SLUGS) as [keyof ModelConfig, string][]) {
    const model = bySlug[slug];
    if (!model) {
      throw new Error(
        `model_config_missing: external_apis row '${slug}' has no metadata.model — ` +
        `configure it in the admin Models panel (/admin/models)`
      );
    }
    result[tier] = model;
  }

  return result;
}
