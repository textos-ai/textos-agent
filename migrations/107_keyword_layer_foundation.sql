-- =====================================================================
-- Migration 107: keyword layer foundation — claim rules, trade noun, storage
-- =====================================================================
-- Requires: 091, 092, 104.  Safe to re-run.
-- Phase 2C Part A. Three parts, one apply, because none of them is useful
-- without the others.
-- =====================================================================

-- ── PART 1 (A3) — the claim guardrail's rules, as CONFIG ──────────────
--
-- A keyword may only assert what the facts support. Every term below is a
-- service-delivery promise that trades marketing emits by default and that a
-- template or a model will happily reproduce; on a licensed contractor's public
-- site an unsupported one is the same category of problem as a fabricated review.
--
-- These live on the TEMPLATE, not in code, so a plumber's list can differ from an
-- electrician's without a deploy. src/lib/site-render/claim-guard.ts carries an
-- identical strict set as its fallback, so a template with no rules FAILS CLOSED
-- rather than permitting everything.
--
-- `unlocked_by` names the fact that earns the claim:
--   license           business_profile.license_number is present
--   hours_or_service  hours genuinely cover it, or a service names it
--   authored_text     the operator wrote THAT promise themselves (per term)
--   price_range       a price band has been set
UPDATE public.site_templates AS t
SET section_catalog = t.section_catalog || jsonb_build_object('claim_rules', jsonb_build_array(
      jsonb_build_object(
        'id', 'urgency',
        'unlocked_by', 'hours_or_service',
        'message', 'Only if your opening hours cover it, or one of your services says so.',
        'terms', jsonb_build_array('emergency','24/7','24-7','24 hour','24-hour','same day',
                                   'same-day','after hours','after-hours','round the clock','anytime')),
      jsonb_build_object(
        'id', 'credential',
        'unlocked_by', 'license',
        'message', 'Only once a licence number is on your business facts.',
        'terms', jsonb_build_array('licensed','certified','insured','bonded','accredited')),
      jsonb_build_object(
        'id', 'assurance',
        'unlocked_by', 'authored_text',
        'message', 'Only if you have written this promise yourself somewhere on the site.',
        'terms', jsonb_build_array('free estimate','free estimates','free quote','free quotes',
                                   'guaranteed','guarantee','warranty','warrantied','no obligation',
                                   'risk free','risk-free')),
      jsonb_build_object(
        'id', 'price',
        'unlocked_by', 'price_range',
        'message', 'Only once a price range is on your business facts.',
        'terms', jsonb_build_array('cheap','cheapest','affordable','lowest price','best price',
                                   'discount','budget','low cost','low-cost','unbeatable'))
    )),
    updated_at = now()
WHERE t.template_key = 'trades-v1';


-- ── PART 2 (A1) — trade noun, a BUSINESS FACT ─────────────────────────
--
-- URLs and keywords need the noun people actually search: "electrician", not
-- "Electrical Contracting Services". That is true of the business regardless of
-- whether it has a website, so it belongs beside services in business_profile,
-- not in the site manager.
--
-- NULLABLE, not NOT NULL: existing rows predate it and a backfill would mean
-- guessing. Area-page URL derivation HALTS LOUDLY when it is absent rather than
-- falling back to `industry`, which is a long descriptive string and not a search
-- term. An empty URL segment is worse than a refused provision.
ALTER TABLE public.business_profile
  ADD COLUMN IF NOT EXISTS trade_noun text,
  ADD COLUMN IF NOT EXISTS trade_noun_plural text;

COMMENT ON COLUMN public.business_profile.trade_noun IS
  'Singular search noun for the trade, e.g. "electrician". Used in area-page URLs '
  '(/areas/chalmette-la-electrician) and derived keywords. Required before area '
  'pages can be provisioned.';
COMMENT ON COLUMN public.business_profile.trade_noun_plural IS
  'Plural form, e.g. "electricians". Used in copy and keywords where the plural reads.';


-- ── PART 3 (A4) — derived keywords, with provenance ───────────────────
--
-- Shape follows lead_search_queries (business_id / phrases jsonb / sources jsonb /
-- created_at), which is the pattern this codebase already uses for a derived
-- phrase set. One row per derivation run; per-keyword provenance lives inside
-- `phrases`, exactly as `rationale` does there.
--
--   phrases   [{ text, service_id, area_id, kind }]
--             service_id / area_id are null when that axis was not involved.
--   sources   { trade_noun, service_ids[], area_ids[], rule_set }
--             What was read. Comparing it against current facts is what makes a
--             stale keyword set VISIBLE instead of silently persisting.
--   rejected  [{ text, rule_id, term }]
--             Deliberate addition beyond the lead-engine shape: what the guardrail
--             refused and why. Without it the manager can only show what was
--             generated, and "why is there no emergency keyword" has no answer.
CREATE TABLE IF NOT EXISTS public.site_keywords (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  site_id      uuid REFERENCES public.sites(id) ON DELETE CASCADE,
  phrases      jsonb NOT NULL DEFAULT '[]'::jsonb,
  sources      jsonb NOT NULL DEFAULT '{}'::jsonb,
  rejected     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS site_keywords_business_created_idx
  ON public.site_keywords (business_id, created_at DESC);

ALTER TABLE public.site_keywords ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'site_keywords'
      AND policyname = 'site_keywords_select_own'
  ) THEN
    CREATE POLICY site_keywords_select_own ON public.site_keywords
      FOR SELECT USING (
        business_id IN (SELECT id FROM public.businesses WHERE user_id = auth.uid())
      );
  END IF;
END $$;


-- =====================================================================
-- Verification
-- =====================================================================
-- 1. Four claim rules, none of them empty:
--   SELECT r->>'id', r->>'unlocked_by', jsonb_array_length(r->'terms')
--   FROM public.site_templates t, jsonb_array_elements(t.section_catalog->'claim_rules') r
--   WHERE t.template_key='trades-v1';
--   -- expect urgency / credential / assurance / price, each with terms > 0
--
-- 2. Trade noun columns exist and are still empty (no guessed backfill):
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name='business_profile' AND column_name LIKE 'trade_noun%';
--   SELECT count(*) FROM public.business_profile WHERE trade_noun IS NOT NULL;
--   -- expect 2 columns, 0 populated
--
-- 3. Keyword table exists with RLS on:
--   SELECT relrowsecurity FROM pg_class WHERE relname='site_keywords';
--   -- expect true
--
-- 4. STANDING POST-CONDITION for any migration touching section_catalog
--    (see 104/105/106). This one merges at the TOP LEVEL, so page_types is
--    untouched by construction — assert it rather than reason about it:
--   SELECT pt->>'page_type' AS page_type,
--          count(*) AS n,
--          string_agg(sec->>'section_key', ',' ORDER BY (sec->>'order')::int) AS keys
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') pt,
--        jsonb_array_elements(pt->'sections') sec
--   WHERE t.template_key='trades-v1'
--   GROUP BY 1 ORDER BY 1;
--
--    Expected, unchanged by this migration:
--      home 14, services 5, projects 5, why_us 8, faq 5, contact 5,
--      legal 4, area_index 4, area_detail 9
-- =====================================================================
