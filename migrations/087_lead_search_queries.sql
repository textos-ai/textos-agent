-- =====================================================================
-- Migration 087: lead_search_queries (persisted ICP-derived search phrases)
-- =====================================================================
-- Source: ICP->query derivation (2026-07-17). Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: guarded with IF NOT EXISTS.
-- =====================================================================
--
-- WHY: the finder must NEVER search a hand-authored query. `derive-search-queries`
-- reads the business's own stored customer context (business_context.target_customer
-- + the authoritative ICP doc's "Where They Gather & Words They Use") and produces
-- buyer-voice search phrases. Those phrases are persisted here so:
--   (1) the finder's query originates from stored context, not a human,
--   (2) the report can show "the exact phrases we searched",
--   (3) every derivation run is inspectable (provenance in `sources`).
--
-- One row per derivation run; the latest row per business is authoritative
-- (ORDER BY created_at DESC, id DESC).
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.lead_search_queries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  -- [{ "text": "<buyer-voice phrase>", "rationale": "<why, from which signal>" }, ...]
  phrases      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- provenance: { icp_asset_id, icp_title, used_target_customer: bool, used_icp_gather: bool }
  sources      jsonb NOT NULL DEFAULT '{}'::jsonb,
  task_run_id  uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_search_queries_business_created_idx
  ON public.lead_search_queries (business_id, created_at DESC);

-- =====================================================================
-- Verification (paste after applying)
-- =====================================================================
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'lead_search_queries' ORDER BY ordinal_position;
--   -- expect: id uuid, business_id uuid, phrases jsonb, sources jsonb,
--   --         task_run_id uuid, created_at timestamptz
-- =====================================================================
