-- =====================================================================
-- Migration 105: a closing CTA on the contact page
-- =====================================================================
-- Requires: 102, 104.  Safe to re-run (guarded on section_key).
-- =====================================================================
--
-- /contact ended with the contact details and nothing else. It is the page
-- someone reaches already intending to book, so it gets the same closing band
-- every other page has.
--
-- LEGAL PAGES DELIBERATELY EXCLUDED. A "Book Online" band under a Privacy Policy
-- is wrong, so terms-of-service and privacy-policy keep no closing CTA. This
-- migration touches the contact page_type only.
--
-- cta_band goes AFTER contact_direct and BEFORE the footer: order 4, with
-- site_footer pushed to 5.
UPDATE public.site_templates AS t
SET section_catalog = jsonb_set(
      t.section_catalog,
      '{page_types}',
      (
        SELECT jsonb_agg(
                 CASE WHEN pt->>'page_type' = 'contact'
                       AND NOT (pt->'sections' @> '[{"section_key":"cta_band"}]'::jsonb) THEN
                   jsonb_set(pt, '{sections}', (
                     SELECT jsonb_agg(x ORDER BY (x->>'order')::int)
                     FROM (
                       SELECT CASE WHEN sec->>'section_key' = 'site_footer'
                                   THEN jsonb_set(sec, '{order}', '5')
                                   ELSE sec END AS x
                       FROM jsonb_array_elements(pt->'sections') AS sec
                       UNION ALL
                       SELECT jsonb_build_object(
                         'order', 4,
                         'section_key', 'cta_band',
                         'anchor', 'cta-band',
                         'label', 'Call To Action',
                         'description', 'The band near the bottom inviting people to call or book.',
                         'fields', '[]'::jsonb,
                         'field_help', '{}'::jsonb)
                     ) AS s(x)
                   ))
                 ELSE pt END
                 ORDER BY ord
               )
        FROM jsonb_array_elements(t.section_catalog->'page_types')
             WITH ORDINALITY AS x2(pt, ord)
      )
    ),
    updated_at = now()
WHERE t.template_key = 'trades-v1';

-- =====================================================================
-- Verification
-- =====================================================================
-- 1. Contact now ends nav / hero / details / CTA / footer:
--   SELECT sec->>'order', sec->>'section_key'
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') pt,
--        jsonb_array_elements(pt->'sections') sec
--   WHERE t.template_key='trades-v1' AND pt->>'page_type'='contact'
--   ORDER BY (sec->>'order')::int;
--   -- expect 1 site_nav, 2 page_hero, 3 contact_direct, 4 cta_band, 5 site_footer
--
-- 2. Legal is untouched, no closing CTA:
--   SELECT count(*) FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') pt,
--        jsonb_array_elements(pt->'sections') sec
--   WHERE t.template_key='trades-v1' AND pt->>'page_type'='legal'
--     AND sec->>'section_key'='cta_band';
--   -- expect 0
--
-- 3. STANDING POST-CONDITION for any migration touching section_catalog.
--    Every page type, its section count and its key list, so a jsonb rebuild
--    that silently drops or reorders an entry somewhere this migration never
--    named is caught. 094 lost trust_bar through exactly that blind spot.
--   SELECT pt->>'page_type' AS page_type,
--          count(*) AS n,
--          string_agg(sec->>'section_key', ',' ORDER BY (sec->>'order')::int) AS keys
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') pt,
--        jsonb_array_elements(pt->'sections') sec
--   WHERE t.template_key='trades-v1'
--   GROUP BY 1 ORDER BY 1;
--
--    Expected AFTER this migration (contact goes 4 -> 5):
--      home 14, services 5, projects 5, why_us 8, faq 5, contact 5,
--      legal 5, area_index 4, area_detail 9
--    Any change to a page type this migration did not name is a fault.
-- =====================================================================
