-- =====================================================================
-- Migration 114: drop the orphaned business_profile.analytics_id
-- =====================================================================
-- Source: Website Manager Phase 3A brief, 2026-07-31 (Part D)
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: DROP COLUMN IF EXISTS.
-- =====================================================================
--
-- DESTRUCTIVE, AND EXPLICITLY AUTHORIZED. The brief says "analytics_id — retire
-- it, as you recommended... One-time backfill for anyone who already typed one."
-- This drops a column. It is deliberately a SEPARATE migration from 113 so the
-- backfill can be inspected before anything is destroyed.
--
-- APPLY 113 FIRST, AND RUN ITS LAST VERIFICATION QUERY. That query lists any
-- analytics_id value the backfill could NOT carry across — a malformed ID, or a
-- business with no site yet. Every one of those is lost when this runs. Expect
-- zero rows; if there are any, deal with them before applying this.
--
-- WHY RETIRE RATHER THAN WIRE IT UP: the column had a write path (the Facts
-- form) and no consumer anywhere — the same shape as the font_family bug, where
-- an operator fills a box that nothing reads. Keeping it AND adding the GA4
-- provider would mean one setting with two homes and nothing deciding which
-- wins. It also sits wrong in Business Facts: a GA4 measurement ID is a setting
-- for one website, not a fact about a company.
--
-- The Worker stopped reading and writing this column in the same deploy that
-- introduced the provider registry, so dropping it breaks no running code.

-- Refuse to run while any un-migrated value is still sitting here. Better a
-- loud failure than silently destroying the one thing an operator typed.
DO $$
DECLARE stranded int;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='business_profile' AND column_name='analytics_id'
  ) THEN
    EXECUTE $q$
      SELECT count(*) FROM public.business_profile p
      WHERE p.analytics_id IS NOT NULL
        AND btrim(p.analytics_id) <> ''
        AND NOT EXISTS (
          SELECT 1 FROM public.sites s
          JOIN public.site_integrations si ON si.site_id = s.id AND si.provider = 'ga4'
          WHERE s.business_id = p.business_id
        )
    $q$ INTO stranded;

    IF stranded > 0 THEN
      RAISE EXCEPTION
        'analytics_id: % business(es) still hold a value with no matching ga4 integration. '
        'Apply migration 113 and check its last verification query before dropping this column.',
        stranded;
    END IF;
  END IF;
END $$;

ALTER TABLE public.business_profile DROP COLUMN IF EXISTS analytics_id;

-- ── Verification ─────────────────────────────────────────────────────
--
-- The column is gone:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name='business_profile' AND column_name='analytics_id';
--   -- expect 0 rows
--
-- And the setting still exists, in its new home:
--   SELECT s.slug, si.config->>'measurement_id' AS measurement_id, si.status
--   FROM public.site_integrations si JOIN public.sites s ON s.id = si.site_id
--   WHERE si.provider = 'ga4';
