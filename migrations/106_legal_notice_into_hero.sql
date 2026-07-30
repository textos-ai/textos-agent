-- =====================================================================
-- Migration 106: retire legal_notice; the date moves into the hero
-- =====================================================================
-- Requires: 102, 103.  Safe to re-run (removal is idempotent).
-- =====================================================================
--
-- legal_notice was a whole trades-section carrying one line of text, so it
-- inherited full section padding and left a large gap between the H1 and
-- "Last updated". The reference puts that line inside the hero, directly beneath
-- the heading, as a <p> with margin-top:0.75rem — no section of its own.
--
-- So the section goes, and page_hero renders the date from the same
-- legal_last_updated field. The field is unchanged; only where it is edited and
-- where it appears move. Its help text follows it onto page_hero.
--
-- The renderer for legal_notice is kept as a no-op, so a page still carrying the
-- section row renders nothing rather than the date twice.

-- ── 1. drop the section, renumber the ones after it ───────────────────
UPDATE public.site_templates AS t
SET section_catalog = jsonb_set(
      t.section_catalog,
      '{page_types}',
      (
        SELECT jsonb_agg(
                 CASE WHEN pt->>'page_type' = 'legal' THEN
                   jsonb_set(pt, '{sections}', (
                     SELECT COALESCE(jsonb_agg(
                              jsonb_set(sec, '{order}', to_jsonb(rn)) ORDER BY rn
                            ), '[]'::jsonb)
                     FROM (
                       SELECT sec, row_number() OVER (ORDER BY (sec->>'order')::int) AS rn
                       FROM jsonb_array_elements(pt->'sections') AS sec
                       WHERE sec->>'section_key' <> 'legal_notice'
                     ) AS ordered
                   ))
                 ELSE pt END
                 ORDER BY ord
               )
        FROM jsonb_array_elements(t.section_catalog->'page_types')
             WITH ORDINALITY AS x(pt, ord)
      )
    ),
    updated_at = now()
WHERE t.template_key = 'trades-v1';

-- ── 2. the date field is now edited on page_hero ──────────────────────
UPDATE public.site_templates AS t
SET section_catalog = jsonb_set(
      t.section_catalog,
      '{page_types}',
      (
        SELECT jsonb_agg(
                 CASE WHEN pt->>'page_type' = 'legal' THEN
                   jsonb_set(pt, '{sections}', (
                     SELECT jsonb_agg(
                              CASE WHEN sec->>'section_key' = 'page_hero' THEN
                                sec || jsonb_build_object('field_help',
                                  COALESCE(sec->'field_help', '{}'::jsonb)
                                  || jsonb_build_object(
                                       'legal_last_updated',
                                       'The date you last revised this document. It appears just under '
                                       || 'the title. Written as 2026-07-30 or 7/30/2026 it is shown as '
                                       || 'July 30, 2026; anything else is shown exactly as you type it. '
                                       || 'Leave it empty and no date appears.'))
                              ELSE sec END
                              ORDER BY (sec->>'order')::int
                            )
                     FROM jsonb_array_elements(pt->'sections') AS sec
                   ))
                 ELSE pt END
                 ORDER BY ord
               )
        FROM jsonb_array_elements(t.section_catalog->'page_types')
             WITH ORDINALITY AS x(pt, ord)
      )
    ),
    updated_at = now()
WHERE t.template_key = 'trades-v1';

-- ── 3. remove the now-orphaned section rows from provisioned sites ────
DELETE FROM public.site_sections
WHERE section_key = 'legal_notice';

-- =====================================================================
-- Verification
-- =====================================================================
-- 1. legal is nav / hero / body / footer, contiguously ordered:
--   SELECT sec->>'order', sec->>'section_key'
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') pt,
--        jsonb_array_elements(pt->'sections') sec
--   WHERE t.template_key='trades-v1' AND pt->>'page_type'='legal'
--   ORDER BY (sec->>'order')::int;
--   -- expect 1 site_nav, 2 page_hero, 3 legal_body, 4 site_footer
--
-- 2. No legal_notice rows survive:
--   SELECT count(*) FROM public.site_sections WHERE section_key='legal_notice';
--   -- expect 0
--
-- 3. STANDING POST-CONDITION for any migration touching section_catalog
--    (see 104/105). Every page type, its section count and key order:
--   SELECT pt->>'page_type' AS page_type,
--          count(*) AS n,
--          string_agg(sec->>'section_key', ',' ORDER BY (sec->>'order')::int) AS keys
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') pt,
--        jsonb_array_elements(pt->'sections') sec
--   WHERE t.template_key='trades-v1'
--   GROUP BY 1 ORDER BY 1;
--
--    Expected AFTER 105 and this migration (legal goes 5 -> 4):
--      home 14, services 5, projects 5, why_us 8, faq 5, contact 5,
--      legal 4, area_index 4, area_detail 9
--    Any change to a page type this migration did not name is a fault.
-- =====================================================================
