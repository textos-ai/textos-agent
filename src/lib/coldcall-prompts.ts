// =============================================================
// Cold-call demo prompt resolver.
//
// WHY THIS EXISTS RATHER THAN resolvePrompt():
// prompt_definitions.task_slug is a FOREIGN KEY to tasks(slug) — verified by
// effect against the live schema (23503 prompt_definitions_task_slug_fkey).
// A prompt row there cannot exist without a client-catalog tasks row, and
// creating one would pull the demo generator into the client task catalog,
// which is the coupling this whole feature exists to avoid.
//
// So the demo prompts live in coldcall_demo_prompts: same semantics
// (versioned, exactly one active row per slug, never overwritten), no FK.
//
// The CONTRACT matches resolvePrompt deliberately — throws loudly when a slug
// has no active row, never falls back to a default or an older version. A
// missing prompt is a deployment fault and must read as one.
// =============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export interface ColdcallPrompt {
  id: string;
  slug: string;
  version: number;
  system_prompt: string | null;
  user_prompt_template: string;
  max_output_tokens: number | null;
}

/**
 * Resolve the active demo prompt for a slug.
 *
 * Throws coldcall_demo_prompt_missing:<slug> when no active row exists —
 * the same loud-failure contract resolvePrompt() gives the task runner.
 */
export async function resolveColdcallPrompt(
  supabase: SupabaseClient,
  slug: string,
): Promise<ColdcallPrompt> {
  const { data, error } = await supabase
    .from("coldcall_demo_prompts")
    .select("id, slug, version, system_prompt, user_prompt_template, max_output_tokens")
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw new Error(
      `coldcall_demo_prompt_resolve_failed: DB error for '${slug}': ${error.message}`,
    );
  }
  if (!data) {
    throw new Error(`coldcall_demo_prompt_missing: ${slug}`);
  }
  return data as ColdcallPrompt;
}
