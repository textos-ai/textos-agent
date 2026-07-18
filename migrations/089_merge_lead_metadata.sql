-- 089_merge_lead_metadata.sql
--
-- Atomic shallow-merge of a jsonb patch into connection_leads.metadata.
--
-- The lead pipeline's enrichment stages each write a DISTINCT top-level key on
-- the same row's metadata jsonb:
--   verify    -> metadata.age_days
--   understand-> metadata.alignment_read
--   reach     -> metadata.reach_package
-- A read-modify-write in JS (SELECT metadata; spread; UPDATE) loses a sibling
-- stage's write whenever two writers overlap — and queue at-least-once
-- redelivery (a run marked 'failed' by a per-lead LLM timeout is retried) makes
-- that overlap real. `metadata || p_patch` performs the merge inside a single
-- UPDATE, atomic per row, so no sibling key is ever clobbered.
--
-- Called from src/lib/tasks/lead-metadata.ts (mergeLeadMetadata). That helper
-- falls back to read-modify-write if this function is absent, so the code runs
-- before this DDL lands; once applied, the merge is fully atomic.

CREATE OR REPLACE FUNCTION public.merge_lead_metadata(p_id uuid, p_patch jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.connection_leads
  SET metadata = COALESCE(metadata, '{}'::jsonb) || p_patch
  WHERE id = p_id;
$$;

GRANT EXECUTE ON FUNCTION public.merge_lead_metadata(uuid, jsonb) TO service_role;
