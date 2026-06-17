import type { SupabaseClient } from "@supabase/supabase-js";

export interface ActivePrompt {
  id: string;
  task_slug: string;
  version: number;
  system_prompt: string | null;
  user_prompt_template: string;
}

/**
 * Resolves the active prompt definition for a paid task.
 *
 * Throws task_missing_active_prompt:<slug> when no active row exists —
 * same loud-failure contract as the old prompt_template check.
 * Never silently falls back.
 */
export async function resolvePrompt(
  supabase: SupabaseClient,
  taskSlug: string,
): Promise<ActivePrompt> {
  const { data, error } = await supabase
    .from("prompt_definitions")
    .select("id, task_slug, version, system_prompt, user_prompt_template")
    .eq("task_slug", taskSlug)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    throw new Error(
      `prompt_resolve_failed: DB error for task '${taskSlug}': ${error.message}`,
    );
  }

  if (!data) {
    throw new Error(`task_missing_active_prompt: ${taskSlug}`);
  }

  return data as ActivePrompt;
}
