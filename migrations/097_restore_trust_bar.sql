-- =====================================================================
-- Migration 097: restore trust_bar to trades-v1's home page
-- =====================================================================
-- Source: WEBSITE MANAGER — 1D VISUAL FIDELITY PASS, part A (2026-07-29).
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Requires: 092. Reverses migration 094.
-- Safe to re-run: guarded, no-op once trust_bar is present.
-- =====================================================================
--
-- WHY — THIS REVERSES 094
--
-- 094 removed trust_bar from trades-v1's home page. That was wrong, and the
-- error was mine: I read "trust items are folded into the hero" as "the separate
-- band is redundant". Re-reading the mockup, it has BOTH — trust chips inside
-- hero-media AND a distinct trust band immediately below it, with accent icons:
--
--   Licensed #75122 · A Decade in the Parish · Satisfaction Guaranteed
--   · Mon–Sat 7am–7pm · Online Booking
--
-- The mockup's own CSS confirms it is a real section, not a duplicate:
--   .trust-bar        { background: var(--color-surface);
--                       border-bottom: 1px solid var(--color-border);
--                       padding: 1rem 0; }
--   .trust-bar__item  { text-transform: uppercase; letter-spacing: .05em;
--                       font-size: .8rem; font-weight: 600;
--                       color: var(--color-muted); }
--   .trust-bar__item .icon { color: var(--color-accent); width:16px; height:16px; }
--
-- Restored at its ORIGINAL position — order 3, between hero_home and
-- services_grid — which is where 092 seeded it and where the mockup puts it.
--
-- Sections at order >= 3 shift up by one, so the list stays contiguous 1..14.
--
-- NO DESTRUCTIVE STATEMENTS. This only inserts a section into the catalog and
-- renumbers. The site_sections rows 094 deleted are recreated by re-provisioning
-- (POST /api/internal/provision-site), which reads the catalog — see
-- verification 4.
-- =====================================================================

UPDATE public.site_templates AS t
SET section_catalog = jsonb_set(
      t.section_catalog,
      '{page_types}',
      (
        SELECT jsonb_agg(
                 CASE
                   WHEN pt->>'page_type' = 'home' THEN
                     jsonb_set(
                       pt,
                       '{sections}',
                       (
                         SELECT jsonb_agg(sec ORDER BY (sec->>'order')::int)
                         FROM (
                           -- existing sections, shifted up where they sit at 3+
                           SELECT CASE
                                    WHEN (s->>'order')::int >= 3
                                      THEN jsonb_set(s, '{order}', to_jsonb((s->>'order')::int + 1))
                                    ELSE s
                                  END AS sec
                           FROM jsonb_array_elements(pt->'sections') AS s
                           UNION ALL
                           -- trust_bar back at its original slot
                           SELECT jsonb_build_object(
                                    'order', 3,
                                    'section_key', 'trust_bar',
                                    'fields', jsonb_build_array(
                                      'trust_items[5] (license, tenure, guarantee, hours, booking)')
                                  )
                         ) AS merged
                       )
                     )
                   ELSE pt
                 END
                 ORDER BY ord
               )
        FROM jsonb_array_elements(t.section_catalog->'page_types')
             WITH ORDINALITY AS x(pt, ord)
      )
    ),
    updated_at = now()
WHERE t.template_key = 'trades-v1'
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(t.section_catalog->'page_types') AS pt,
         jsonb_array_elements(pt->'sections') AS sec
    WHERE pt->>'page_type' = 'home'
      AND sec->>'section_key' = 'trust_bar'
  );


-- =====================================================================
-- Verification (paste after applying)
-- =====================================================================
--
-- 1. trust_bar is back, at order 3:
--   SELECT sec->>'order' AS ord, sec->>'section_key' AS section_key
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') AS pt,
--        jsonb_array_elements(pt->'sections') AS sec
--   WHERE t.template_key='trades-v1' AND pt->>'page_type'='home'
--   ORDER BY (sec->>'order')::int;
--   -- expect 14 rows, contiguous 1..14, trust_bar at 3, hero_home at 2
--
-- 2. No duplicate:
--   SELECT count(*) FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') AS pt,
--        jsonb_array_elements(pt->'sections') AS sec
--   WHERE t.template_key='trades-v1' AND pt->>'page_type'='home'
--     AND sec->>'section_key'='trust_bar';
--   -- expect exactly 1
--
-- 3. Other page types untouched:
--   SELECT pt->>'page_type', jsonb_array_length(pt->'sections')
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') AS pt
--   WHERE t.template_key='trades-v1' ORDER BY 1;
--   -- expect 9 page types; only home changed (13 -> 14)
--
-- 4. Re-provision to recreate the site_sections rows 094 deleted:
--   -- POST /api/internal/provision-site {"businessSlug":"jkqualityelectric"}
--   SELECT count(*) FROM public.site_sections WHERE section_key='trust_bar';
--   -- expect 1 (0 before re-provisioning — the catalog drives it)
-- =====================================================================
