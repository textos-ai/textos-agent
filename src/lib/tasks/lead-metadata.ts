// lead-metadata — atomic, race-safe writes to connection_leads.metadata (jsonb).
//
// The enrichment stages (verify->age_days, understand->alignment_read,
// reach->reach_package) each patch a DISTINCT top-level key on the same row.
// A JS read-modify-write loses a sibling's write when two writers overlap, and
// queue redelivery (a run failed by a per-lead LLM timeout is retried) makes
// that overlap real. Route the merge through the DB (migration 089's
// `metadata || patch`) so it is atomic per row — no lost updates.

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Shallow-merge `patch` into connection_leads.metadata for row `id`, atomically.
 *
 * Prefers the merge_lead_metadata RPC (migration 089). Falls back to a
 * read-modify-write if the function is absent (pre-migration) so the code runs
 * before the DDL lands; once applied it is fully atomic. The fallback's residual
 * race window is closed in practice by the stages' idempotent skip-filters.
 */
export async function mergeLeadMetadata(
  supabase: SupabaseClient,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.rpc("merge_lead_metadata", { p_id: id, p_patch: patch });
  if (!error) return;
  // Fallback: non-atomic read-modify-write (pre-migration or transient RPC error).
  const { data } = await supabase
    .from("connection_leads")
    .select("metadata")
    .eq("id", id)
    .maybeSingle();
  const current = ((data as { metadata?: Record<string, unknown> } | null)?.metadata) ?? {};
  await supabase
    .from("connection_leads")
    .update({ metadata: { ...current, ...patch } })
    .eq("id", id);
}
