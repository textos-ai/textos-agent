-- =====================================================================
-- Migration 079: leads (external-retrieval lead-finding)
-- =====================================================================
-- Shared table the lead tasks write/read, and the store a future Connection
-- Report renders. The external-retrieval engine inserts candidates (status
-- 'found'); match-verify-leads verifies + scores (status 'verified'/'rejected');
-- draft-reply fills drafted_message (status 'drafted'). Source-agnostic: every
-- platform normalizes to this one shape.
--
-- Additive + idempotent. Pure ASCII. Apply via the Supabase SQL editor:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.leads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  source           text NOT NULL,                 -- provider slug, e.g. 'bluesky'
  external_id      text,                           -- platform id (dedup key)
  url              text NOT NULL,                  -- working public permalink
  title            text,
  snippet          text,                           -- quoted-proof excerpt
  published_at     timestamptz,                    -- true freshness
  match_reason     text,
  match_score      integer CHECK (match_score BETWEEN 0 AND 100),
  drafted_message  text,
  status           text NOT NULL DEFAULT 'found'
                     CHECK (status IN ('found','verified','drafted','rejected')),
  task_run_id      uuid,                           -- provenance
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Idempotent upsert / dedup: same post never double-inserted per business.
CREATE UNIQUE INDEX IF NOT EXISTS leads_business_source_external
  ON public.leads (business_id, source, external_id);

CREATE INDEX IF NOT EXISTS leads_business_status
  ON public.leads (business_id, status);

-- == Verify (paste after applying) =============================================
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='leads' ORDER BY ordinal_position;
