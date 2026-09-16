-- =====================================================================
-- Migration 129: the sellable-area list for the exclusivity manager
-- =====================================================================
-- Source: TrustLight build brief, step 9 (exclusivity manager), 2026-09-16
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: CREATE OR REPLACE.
-- =====================================================================
--
-- WHY A VIEW AND NOT A QUERY IN THE WORKER
--
-- Step 9 has to show "which counties are claimed and which are open". The
-- claimed side is tiny (only verified + plan='exclusive' rows). The OPEN side
-- needs the full list of areas we operate in, which means DISTINCT over
-- coldcall_leads.parish.
--
-- PostgREST has no DISTINCT and caps a select at 1000 rows, so the Worker
-- would have to page the whole 15,822-row table — about sixteen round trips —
-- every time the screen loads, just to learn fourteen parish names. One
-- grouped view answers it in a single request and keeps getting cheaper
-- relative to the table as leads grow.
--
-- `parish` is the county column for this data set: these are Louisiana
-- parishes plus a few Mississippi counties carrying an _ms suffix
-- (pearl_river_ms, hancock_ms). The exclusivity columns added in 126 call the
-- same concept `exclusive_county`, so the view exposes it as `county` and the
-- two line up without the Worker renaming anything.
--
-- No new tables, no column changes, no data written. Dropping this view would
-- cost the "open areas" panel and nothing else.
-- =====================================================================

CREATE OR REPLACE VIEW public.coldcall_areas AS
SELECT
  lower(btrim(l.parish))     AS county,
  upper(btrim(l.state))      AS state,
  COUNT(*)::int              AS lead_count,
  COUNT(*) FILTER (WHERE l.vetting_status = 'verified')::int AS verified_count
FROM public.coldcall_leads l
WHERE l.parish IS NOT NULL
  AND btrim(l.parish) <> ''
  AND l.state IS NOT NULL
  AND btrim(l.state) <> ''
GROUP BY lower(btrim(l.parish)), upper(btrim(l.state));

COMMENT ON VIEW public.coldcall_areas IS
  'Distinct (county, state) areas we hold leads in, with lead counts. Feeds the '
  'open/claimed panel of the TrustLight exclusivity manager. Read-only.';

-- The Worker reads with the service-role key, which bypasses RLS; this grant
-- is here so the view is also readable by the dashboard roles that can already
-- read coldcall_leads. It exposes nothing that table does not.
GRANT SELECT ON public.coldcall_areas TO authenticated, service_role;

-- ── Verify after applying ────────────────────────────────────────────
--   SELECT * FROM public.coldcall_areas ORDER BY lead_count DESC;
-- Expected at time of writing: 14 rows, LA and MS, jefferson/LA largest.
--
--   -- the exclusivity index from 126 is what actually enforces the race:
--   SELECT indexname FROM pg_indexes
--    WHERE tablename='coldcall_leads' AND indexname LIKE '%exclusive%';
-- =====================================================================
