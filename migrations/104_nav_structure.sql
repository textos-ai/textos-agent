-- =====================================================================
-- Migration 104: nav structure as template data
-- =====================================================================
-- Requires: 092, 100, 102, 103.  Safe to re-run.
-- =====================================================================
--
-- The nav was a hardcoded PAGE_ORDER + ANCHOR_ONLY pair in sections.ts, so a
-- different vertical could not group its menu without a code change. It moves here.
--
--   Services · About Us [Our Work · Why Us · FAQ · Reviews] · Service Areas · Contact
--
-- Each item resolves in the same order the code used to: prefer a real PAGE of
-- page_type; fall back to an ANCHOR on section_key when that page does not exist;
-- drop out entirely when neither resolves. A group whose children all drop stops
-- being a dropdown. That behaviour is unchanged — only its source is.
--
-- About Us is a GROUP, not a page: it has no page_type, so it renders as a button
-- parent exactly like the reference's Service Areas dropdown.
--
-- Service Areas stays top-level. In 2C the area index becomes a real page and gains
-- its own children — the same component, a second instance, which is why this had
-- to be data rather than a constant.
UPDATE public.site_templates AS t
SET section_catalog = t.section_catalog || jsonb_build_object('nav', jsonb_build_object(
      'items', jsonb_build_array(
        jsonb_build_object('label', 'Services',  'page_type', 'services',   'section_key', 'services_grid'),
        jsonb_build_object('label', 'About Us',  'children', jsonb_build_array(
          jsonb_build_object('label', 'Our Work', 'page_type', 'projects', 'section_key', 'featured_work'),
          jsonb_build_object('label', 'Why Us',   'page_type', 'why_us'),
          jsonb_build_object('label', 'FAQ',      'page_type', 'faq',      'section_key', 'faq_teaser'),
          jsonb_build_object('label', 'Reviews',  'section_key', 'reviews')
        )),
        jsonb_build_object('label', 'Service Areas', 'page_type', 'area_index', 'section_key', 'service_area_chips'),
        jsonb_build_object('label', 'Contact',       'page_type', 'contact',    'section_key', 'cta_band')
      )
    )),
    updated_at = now()
WHERE t.template_key = 'trades-v1';

-- =====================================================================
-- Verification
-- =====================================================================
-- 1. The nav itself, which is what this migration meant to change:
--   SELECT jsonb_pretty(section_catalog->'nav') FROM public.site_templates
--   WHERE template_key='trades-v1';
--   -- expect 4 items, the second with 4 children and no page_type
--
-- 2. STANDING POST-CONDITION for any migration touching section_catalog.
--
--    This file originally carried query 1 alone. That would have passed
--    identically if page_types had been wiped, so when the CTA band was reported
--    missing after 104, nothing here could rule this migration out. 094 dropped
--    trust_bar through exactly that blind spot. A migration that verifies only
--    its own intent cannot catch its blast radius.
--
--    This one merges at the TOP LEVEL (section_catalog || {nav}), so page_types
--    is untouched by construction. Assert it rather than reason about it:
--
--   SELECT pt->>'page_type' AS page_type,
--          count(*) AS n,
--          string_agg(sec->>'section_key', ',' ORDER BY (sec->>'order')::int) AS keys
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') pt,
--        jsonb_array_elements(pt->'sections') sec
--   WHERE t.template_key='trades-v1'
--   GROUP BY 1 ORDER BY 1;
--
--    Expected AT 104, before 105 adds the contact CTA:
--      home 14, services 5, projects 5, why_us 8, faq 5, contact 4,
--      legal 5, area_index 4, area_detail 9
--    Any change to a page type this migration did not name is a fault.
