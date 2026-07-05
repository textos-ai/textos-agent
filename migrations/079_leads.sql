-- =====================================================================
-- Migration 079: connection_leads (external-retrieval lead-finding)
-- =====================================================================
-- Store for the Connection Report: the external-retrieval engine inserts
-- candidates (status 'found'); match-verify-leads verifies + scores
-- ('verified'/'rejected'); draft-reply fills drafted_message ('drafted').
-- Source-agnostic: every platform normalizes to this one shape.
--
-- NOTE the name: the table is connection_leads, NOT leads. `leads` already
-- exists (the voice-receptionist call-capture feature). Pre-flight collision
-- probe run before handoff: GET /rest/v1/connection_leads?limit=0 -> 404 (free).
--
-- Uses a BARE CREATE TABLE on purpose: if the name is ever taken, this must
-- fail LOUDLY, not silently no-op (which is exactly how the first 079 hid a
-- collision and then failed on the index). Pure ASCII, no doubled-quote escapes.
-- Apply via the Supabase SQL editor.
-- =====================================================================

CREATE TABLE public.connection_leads (
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
CREATE UNIQUE INDEX connection_leads_business_source_external
  ON public.connection_leads (business_id, source, external_id);

CREATE INDEX connection_leads_business_status
  ON public.connection_leads (business_id, status);

-- == Verify (paste after applying) =============================================
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='connection_leads'
--   ORDER BY ordinal_position;
