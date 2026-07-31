-- =====================================================================
-- Migration 112: retire the standalone area_map section
-- =====================================================================
-- Source: Rob's brief, 2026-07-30 ("map as the hero background, not a
--   separate section below")
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: the section is removed by key and the delete is scoped to
--   area_map rows, so a second run finds nothing to do.
-- =====================================================================
--
-- WHAT THIS REMOVES AND WHY
--
-- Migration 111 added area_map as its own band under the hero. The map is now the
-- hero BACKGROUND instead — a third background variant of page-hero alongside a
-- photo and the solid surface — so the standalone band is a second copy of the
-- same map, immediately below the first.
--
-- THE REPLACEMENT IS ALREADY LIVE AND VERIFIED before this runs: the hero
-- variant renders on all 14 of JK's area pages, each centred on its own
-- coordinates, with attribution and the larger-map link. Removing this section
-- therefore never leaves a page with no map.
--
-- DESTRUCTIVE STATEMENT, EXPLICITLY AUTHORIZED. The brief says "keep the
-- standalone area_map section until the hero variant is verified, then remove
-- it". The DELETE below is scoped to site_sections rows whose section_key is
-- 'area_map' and nothing else. area_map never had authored site_fields — it read
-- geo coordinates from business_service_areas — so no operator copy is lost.
-- No table, column, or business fact is touched.
--
-- ORDERING: the section keys shift back down, so area_services_grid returns to 4
-- and everything below it follows. Re-provisioning after this rewrites
-- display_order on the existing rows.
--
-- AFTER APPLYING, re-provision so the remaining sections take their new order:
--
--   POST /internal/provision-site
--   { "businessSlug": "jkqualityelectric", "templateKey": "trades-v1",
--     "pageTypes": ["area_detail"] }

-- 1. Drop the section from the template and close the gap in the ordering.
UPDATE public.site_templates t
SET section_catalog = jsonb_set(
  t.section_catalog,
  '{page_types}',
  (
    SELECT jsonb_agg(
             CASE WHEN pt->>'page_type' = 'area_detail'
                  THEN jsonb_set(
                         pt,
                         '{sections}',
                         (
                           SELECT COALESCE(jsonb_agg(
                                    jsonb_set(s, '{order}', to_jsonb(new_order))
                                    ORDER BY new_order
                                  ), '[]'::jsonb)
                           FROM (
                             SELECT s,
                                    row_number() OVER (ORDER BY (s->>'order')::int) AS new_order
                             FROM jsonb_array_elements(pt->'sections') s
                             WHERE s->>'section_key' <> 'area_map'
                           ) renumbered
                         )
                       )
                  ELSE pt END
             ORDER BY ord
           )
    FROM jsonb_array_elements(t.section_catalog->'page_types')
         WITH ORDINALITY AS a(pt, ord)
  )
)
WHERE t.template_key = 'trades-v1';

-- 2. Remove the provisioned rows. Scoped to this section key only.
DELETE FROM public.site_sections
WHERE section_key = 'area_map';

-- ── Verification ─────────────────────────────────────────────────────
--
-- The template no longer declares it, and the remaining orders are contiguous
-- from 1 with no gap where area_map was:
--   SELECT s->>'order' AS ord, s->>'section_key' AS section_key
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') pt,
--        jsonb_array_elements(pt->'sections') s
--   WHERE t.template_key = 'trades-v1' AND pt->>'page_type' = 'area_detail'
--   ORDER BY (s->>'order')::int;
--   -- expect site_nav 1 .. site_footer 9, no area_map
--
-- No rows survive anywhere:
--   SELECT count(*) FROM public.site_sections WHERE section_key = 'area_map';
--   -- expect 0
--
-- The hero still carries the map (this is the thing that must NOT have changed):
--   curl -s "https://textos-agent-test.rgaudet2023.workers.dev/api/sites/jkqualityelectric\
-- ?path=/areas/chalmette-la-electrician" | grep -c 'page-hero__bg--map'
--   -- expect 1
