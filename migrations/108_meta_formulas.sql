-- =====================================================================
-- Migration 108: per-page-type title and description formulas (2C, B1)
-- =====================================================================
-- Requires: 100, 102, 107.  Safe to re-run.
-- =====================================================================
--
-- Titles and descriptions become FORMULAS on the template, interpolated from
-- facts at render time, so a vertical can change how its pages describe
-- themselves without a deploy.
--
-- This supersedes meta_defaults (migration 100) as the source of head meta.
-- meta_defaults stays on the rows as the fallback and as the seed for
-- site_pages.meta, but it was a snapshot taken once at provision time: correct on
-- the day, stale the moment a service area is added. A formula reads live facts on
-- every request and cannot drift from what the page contains.
--
-- Tokens available (metaTokens in src/lib/site-render/meta-formula.ts):
--   {business_name} {locality} {region} {trade_noun} {trade_noun_plural}
--   {primary_service} {service_count} {service_list} {area_count} {area_list}
--
-- An absent fact resolves to an empty token and the surrounding punctuation is
-- tidied, so a business with no trade_noun yet gets a shorter title rather than
-- "Electrician in , LA". An UNKNOWN token is left verbatim — a template typo
-- shows as "{buiness_name}" on the page instead of a hole in the title.
--
-- Lengths: titles are written under 60 characters and descriptions in the
-- 140–160 band. They are CHECKED, not truncated — a title cut mid-word reads as
-- broken, and the honest fix is a shorter formula. compose returns meta_warnings
-- for the manager to surface.
UPDATE public.site_templates AS t
SET section_catalog = jsonb_set(
      t.section_catalog,
      '{page_types}',
      (
        SELECT jsonb_agg(
                 CASE pt->>'page_type'
                   WHEN 'home' THEN pt || jsonb_build_object('meta_formula', jsonb_build_object(
                     'title', '{business_name} — {trade_noun} in {locality}, {region}',
                     'description', '{business_name} is a {trade_noun} serving {area_list} and the surrounding area. {service_list} and more. Call for a quote.'))
                   WHEN 'services' THEN pt || jsonb_build_object('meta_formula', jsonb_build_object(
                     'title', 'Services — {business_name}',
                     'description', 'What {business_name} does: {service_list} and more, across {area_list}. Every job by a local {trade_noun}. Call to talk it through.'))
                   WHEN 'projects' THEN pt || jsonb_build_object('meta_formula', jsonb_build_object(
                     'title', 'Our Work — {business_name}',
                     'description', 'Photos of recent jobs by {business_name}, a {trade_noun} working across {area_list}. See the standard of work before you book.'))
                   WHEN 'why_us' THEN pt || jsonb_build_object('meta_formula', jsonb_build_object(
                     'title', 'Why Choose {business_name}',
                     'description', 'Why customers pick {business_name} as their {trade_noun} in {locality} — how we work, what we cover, and the areas we serve across {area_list}.'))
                   WHEN 'faq' THEN pt || jsonb_build_object('meta_formula', jsonb_build_object(
                     'title', 'Questions & Answers — {business_name}',
                     'description', 'Answers to the questions customers ask {business_name} most often, before booking a {trade_noun} in {locality} and the surrounding area.'))
                   WHEN 'contact' THEN pt || jsonb_build_object('meta_formula', jsonb_build_object(
                     'title', 'Contact {business_name}',
                     'description', 'Phone, email and opening hours for {business_name}, a {trade_noun} covering {area_list}. Get in touch to book a visit or ask a question.'))
                   WHEN 'area_index' THEN pt || jsonb_build_object('meta_formula', jsonb_build_object(
                     'title', 'Service Areas — {business_name}',
                     'description', 'The {area_count} areas {business_name} covers as a local {trade_noun}, including {area_list}. Find the page for your town.'))
                   ELSE pt END
                 ORDER BY ord
               )
        FROM jsonb_array_elements(t.section_catalog->'page_types')
             WITH ORDINALITY AS x(pt, ord)
      )
    ),
    updated_at = now()
WHERE t.template_key = 'trades-v1';

-- area_detail gets its formula in Part C, where {city} and {region_code} become
-- available per page. legal is deliberately excluded: those pages are noindex, so
-- a search-facing formula would be writing copy nobody reads.


-- =====================================================================
-- Verification
-- =====================================================================
-- 1. Seven page types have a formula, and none of them is blank:
--   SELECT pt->>'page_type',
--          length(pt->'meta_formula'->>'title') AS t_len,
--          length(pt->'meta_formula'->>'description') AS d_len
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') pt
--   WHERE t.template_key='trades-v1' AND pt ? 'meta_formula'
--   ORDER BY 1;
--   -- expect 7 rows: area_index, contact, faq, home, projects, services, why_us
--
-- 2. legal and area_detail deliberately have none:
--   SELECT pt->>'page_type' FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') pt
--   WHERE t.template_key='trades-v1' AND NOT (pt ? 'meta_formula');
--   -- expect exactly: legal, area_detail
--
-- 3. STANDING POST-CONDITION for any migration touching section_catalog
--    (see 104/105/106/107). Section counts and key order per page type:
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
