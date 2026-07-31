-- =====================================================================
-- Migration 111: area_map section, directly under the area page hero
-- =====================================================================
-- Source: Rob's brief, 2026-07-30 ("map under the hero on area pages")
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: rebuilds the area_detail sections array from a VALUES
--   list keyed on section_key, so a second run produces the same JSON.
-- =====================================================================
--
-- WHAT THIS ADDS
--
-- A map centred on each area's own geo_lat/geo_lng, between the hero and the
-- services grid. This was skipped in 2B because the reference site's embed
-- hardcoded one set of coordinates; business_service_areas now carries a point
-- per area, so it generalises.
--
-- ITS OWN SECTION, ORDER 4. 092 listed `map_embed_or_placeholder` as a field of
-- area_map_nearby at order 7 — the FOOT of the page. That section is a list of
-- links to sibling areas and belongs there; a map belongs under the hero. This
-- supersedes that placement and leaves area_map_nearby otherwise untouched.
-- Everything from the old order 4 down shifts by one.
--
-- NOT DESTRUCTIVE: no table, column or row is dropped. The area_detail page_type
-- entry is rewritten in place; every other page_type is passed through unchanged.
--
-- AFTER APPLYING: existing area pages do NOT have a site_sections row for the new
-- section. The facts-save hook only provisions areas that have no page at all, so
-- it will not add one. Re-provision explicitly:
--
--   POST /internal/provision-site
--   { "businessSlug": "jkqualityelectric", "templateKey": "trades-v1",
--     "pageTypes": ["area_detail"] }
--
-- provisionSite upserts section rows from the catalog and never touches
-- site_fields, so authored copy survives.

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
                           SELECT jsonb_agg(
                                    CASE
                                      -- Everything at or below the insertion
                                      -- point moves down one.
                                      WHEN (s->>'order')::int >= 4
                                        THEN jsonb_set(s, '{order}',
                                               to_jsonb(((s->>'order')::int) + 1))
                                      ELSE s
                                    END
                                    ORDER BY (s->>'order')::int
                                  )
                           FROM jsonb_array_elements(pt->'sections') s
                           -- Drop any previously-inserted copy first, so a
                           -- re-run cannot shift the orders a second time or
                           -- leave two area_map entries behind.
                           WHERE s->>'section_key' <> 'area_map'
                         )
                         || jsonb_build_array(
                              jsonb_build_object(
                                'order', 4,
                                'section_key', 'area_map',
                                'label', 'Area Map',
                                'description',
                                  'A map of this service area, shown just under the heading. '
                                  || 'It centres on the coordinates saved for the area on your '
                                  || 'Business Facts page — an area with no coordinates simply '
                                  || 'shows no map.',
                                'fields', jsonb_build_array('area_geo_lat', 'area_geo_lng')
                              )
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

-- ── Verification ─────────────────────────────────────────────────────
--
-- The area_detail section list, in order — expect area_map at 4, and
-- area_services_grid / area_positioning / area_faq / area_map_nearby /
-- cta_band / site_footer shifted to 5..10:
--   SELECT s->>'order' AS ord, s->>'section_key' AS section_key
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') pt,
--        jsonb_array_elements(pt->'sections') s
--   WHERE t.template_key = 'trades-v1' AND pt->>'page_type' = 'area_detail'
--   ORDER BY (s->>'order')::int;
--
-- Exactly one area_map entry (guards against a double-run):
--   SELECT count(*) FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') pt,
--        jsonb_array_elements(pt->'sections') s
--   WHERE t.template_key='trades-v1' AND pt->>'page_type'='area_detail'
--     AND s->>'section_key'='area_map';
--   -- expect 1
--
-- After the re-provision call above, the rows exist on every area page:
--   SELECT count(*) FROM public.site_sections sec
--   JOIN public.site_pages p ON p.id = sec.page_id
--   WHERE p.page_type='area_detail' AND sec.section_key='area_map';
--   -- expect one per area page (14 for JK)
