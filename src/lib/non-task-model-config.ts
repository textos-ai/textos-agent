/**
 * Non-task feature model config — registry + resolver.
 *
 * Every NON-TASK LLM surface must appear in FEATURE_REGISTRY so it shows
 * in /admin/models and resolves its model from config.
 *
 * Resolution order (per REGISTER-EVERY-LLM-SURFACE rule):
 *   feature override tier ?? feature-default tier → models[tier] → model ID
 *
 * Per NO-FALLBACKS: throws loudly if feature-default is missing or invalid.
 * Never silently falls back to a hardcoded model.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ModelConfig } from "./model-config";

export type FeatureTier = keyof ModelConfig;

/**
 * Every non-task LLM surface. key = DB slug, label = admin UI display.
 * When adding a new LLM-using feature, append here AND add the row via migration.
 */
export const FEATURE_REGISTRY = [
  { key: "feature-chat",                label: "Chat / Morning Line" },
  { key: "feature-anonymous-research",  label: "Anonymous Research" },
  { key: "feature-visual-picker",       label: "Visual Identity Picker" },
  { key: "feature-story-cards",         label: "Story Card Generator" },
  { key: "feature-admin-seo",           label: "Admin SEO Backfill" },
  { key: "feature-app-builder",         label: "Generated App Build Step" },
  { key: "feature-app-result",          label: "Generated App Runtime Result" },
] as const;

export type FeatureKey = typeof FEATURE_REGISTRY[number]["key"];

const FEATURE_DEFAULT_SLUG = "feature-default";
const VALID_TIERS = new Set<string>(["haiku", "sonnet", "opus"]);

function isValidTier(s: string): s is FeatureTier {
  return VALID_TIERS.has(s);
}

export interface FeatureConfig {
  defaultTier: FeatureTier;
  overrides: Partial<Record<FeatureKey, FeatureTier>>;
}

/**
 * Loads non-task feature model config from external_apis.
 * feature-default row is required — throws if missing or has invalid tier.
 * Per-feature rows may omit metadata.tier (means: use default).
 */
export async function loadFeatureConfig(supabase: SupabaseClient): Promise<FeatureConfig> {
  const slugs = [FEATURE_DEFAULT_SLUG, ...FEATURE_REGISTRY.map((f) => f.key)];
  const { data, error } = await supabase
    .from("external_apis")
    .select("slug, metadata")
    .in("slug", slugs);

  if (error) throw new Error(`feature_config_load_failed: ${error.message}`);

  const bySlug: Record<string, FeatureTier | undefined> = {};
  for (const row of data ?? []) {
    const tier = (row.metadata as Record<string, unknown> | null)?.tier;
    if (typeof tier === "string" && isValidTier(tier)) {
      bySlug[row.slug as string] = tier;
    }
  }

  const defaultTier = bySlug[FEATURE_DEFAULT_SLUG];
  if (!defaultTier) {
    throw new Error(
      `feature_config_missing: 'feature-default' row has no valid metadata.tier — ` +
      `set it in /admin/models (haiku|sonnet|opus)`
    );
  }

  const overrides: Partial<Record<FeatureKey, FeatureTier>> = {};
  for (const { key } of FEATURE_REGISTRY) {
    const tier = bySlug[key];
    if (tier) overrides[key] = tier;
  }

  return { defaultTier, overrides };
}

/**
 * Resolves the model ID for a non-task feature.
 * Per NO-FALLBACKS: throws if the resolved tier has no model ID in config.
 */
export function resolveFeatureModel(
  featureKey: FeatureKey,
  featureConfig: FeatureConfig,
  models: ModelConfig,
): string {
  const tier = featureConfig.overrides[featureKey] ?? featureConfig.defaultTier;
  const model = models[tier];
  if (!model) {
    throw new Error(
      `feature_model_missing: tier '${tier}' resolved for '${featureKey}' ` +
      `but has no model ID in models config`
    );
  }
  return model;
}
