-- =====================================================================
-- Migration 101: reconcile manager section names with the Facts bands,
--                and label the three Phase 2A pages
-- =====================================================================
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Requires: 092, 097, 099, 100.
-- Safe to re-run: rewrites sections idempotently, keyed on section_key.
-- =====================================================================
--
-- WHY (part 1) — THE NAMES WERE COMPETING
--
-- The Facts page and the site manager looked like they duplicated Services, FAQ,
-- Featured Work and Reviews. They do not: Facts holds the CONTENT (service names,
-- blurbs, bullets; questions and answers), the manager holds the FRAMING (the
-- small label, the heading, the authored intro). But the names nearly collided
-- without matching, and neither page mentioned the other, so an operator could not
-- tell which was authoritative:
--
--   manager label      Facts eyebrow       Facts heading (registry)
--   ---------------    ----------------    ------------------------------
--   Services           Services            What you do
--   FAQ                FAQs                Questions you get asked
--   Reviews            Reviews & social    Where your proof lives
--   Service Areas      Service areas       Where you work
--   Project Photos     Projects            Work you've completed
--
-- Of the two options, this migration takes the manager side. The Facts headings are
-- plain-language and client-facing, they are single-sourced through
-- lib/site-render/facts-sections.ts, and changing them would churn the intake page
-- every client fills in first. So the MANAGER labels move instead, and they now name
-- the thing on the page — its form — rather than repeating the content noun:
--
--   Service cards / Question preview / Review panel / Area tags / Photo gallery
--
-- Facts answers "what is your content", the manager answers "where does it appear".
-- The manager's Content tab also shows each section's fact source verbatim from the
-- registry ("4 services from Business Facts -> What you do", with an Edit link), so
-- the relationship is stated on screen rather than left to be inferred. Those
-- strings are NOT in this migration — they come from the registry at request time.
--
-- WHY (part 2) — THE 2A PAGES HAD NO LABELS AT ALL
--
-- 099 covered the home page only. The services / why_us / faq pages shipped in 2A
-- with label = '' throughout, so the manager fell back to title-casing the key and
-- an operator saw "Page Hero" and "Faq Accordion". Now that the Content tab groups
-- by page, every group on three of the four pages was reading from that fallback.
--
-- Same three fields as 099, same rules: client language, no designer vocabulary,
-- no section keys, and per-field help only where meaning depends on THIS template.
-- =====================================================================

-- ── 1. home: rename the five labels that competed with a Facts band ────
WITH meta(section_key, label, description) AS (
  VALUES
  ('services_grid', 'Service cards',
   'The row of service cards on your home page. You write the heading above them; the services themselves come from your Business Facts.'),

  ('featured_work', 'Photo gallery',
   'Photos of completed work on your home page. Each photo and caption comes from your Business Facts; you write the heading above them.'),

  ('reviews', 'Review panel',
   'Where customer reviews appear on your home page. Connect your Google listing in Business Facts and the panel fills itself. We never write reviews.'),

  ('service_area_chips', 'Area tags',
   'The list of towns and neighbourhoods you cover, shown as small tags on your home page. The places come from your Business Facts.'),

  ('faq_teaser', 'Question preview',
   'A short list of common questions on your home page, with the full list on your questions page. The questions come from your Business Facts.')
)
UPDATE public.site_templates AS t
SET section_catalog = jsonb_set(
      t.section_catalog,
      '{page_types}',
      (
        SELECT jsonb_agg(
                 CASE WHEN pt->>'page_type' = 'home' THEN
                   jsonb_set(pt, '{sections}', (
                     SELECT jsonb_agg(
                              sec
                              || CASE WHEN m.section_key IS NULL THEN '{}'::jsonb
                                 ELSE jsonb_build_object('label', m.label, 'description', m.description)
                                 END
                              ORDER BY (sec->>'order')::int
                            )
                     FROM jsonb_array_elements(pt->'sections') AS sec
                     LEFT JOIN meta m ON m.section_key = sec->>'section_key'
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


-- ── 2. services / why_us / faq: the labels 099 never wrote ─────────────
WITH meta(page_type, section_key, label, description, field_help) AS (
  VALUES
  -- shared chrome, worded per page so a group header is never ambiguous
  ('services', 'site_nav', 'Top Navigation',
   'The bar across the top of every page. Edit it once under Home and it changes everywhere.', '{}'::jsonb),
  ('services', 'page_hero', 'Page opening',
   'The title block at the top of your services page.',
   '{"page_hero_label":"A short line above the title, two or three words.","page_hero_headline":"The big title at the top of this page.","page_hero_subhead":"One or two sentences under the title."}'::jsonb),
  ('services', 'service_detail', 'Service write-ups',
   'One block per service, with its description and bullet points. Everything in them comes from your Business Facts; you write the heading above them.', '{}'::jsonb),
  ('services', 'cta_band', 'Call To Action',
   'The band near the bottom inviting people to call or book.', '{}'::jsonb),
  ('services', 'site_footer', 'Footer',
   'The bottom of every page: your hours, address, licence and links. Edit it once under Home.', '{}'::jsonb),

  ('why_us', 'site_nav', 'Top Navigation',
   'The bar across the top of every page. Edit it once under Home and it changes everywhere.', '{}'::jsonb),
  ('why_us', 'page_hero', 'Page opening',
   'The title block at the top of your why-us page.',
   '{"page_hero_label":"A short line above the title, two or three words.","page_hero_headline":"The big title at the top of this page.","page_hero_subhead":"One or two sentences under the title."}'::jsonb),
  ('why_us', 'story_prose', 'Your story',
   'A few paragraphs in your own words about the business. This is the one section on the page you write from scratch.',
   '{"story_para_1":"How the business started.","story_para_2":"What you do differently.","story_para_3":"Optional third paragraph."}'::jsonb),
  ('why_us', 'differentiator_list', 'Reason cards',
   'The reasons customers choose you, one card each. The reasons come from your Business Facts.', '{}'::jsonb),
  ('why_us', 'license_callout', 'Licence panel',
   'Your licence number and issuing board, shown as a panel. It fills itself from your Business Facts.', '{}'::jsonb),
  ('why_us', 'service_area_chips', 'Area tags',
   'The towns and neighbourhoods you cover, shown as small tags. The places come from your Business Facts.', '{}'::jsonb),
  ('why_us', 'cta_band', 'Call To Action',
   'The band near the bottom inviting people to call or book.', '{}'::jsonb),
  ('why_us', 'site_footer', 'Footer',
   'The bottom of every page: your hours, address, licence and links. Edit it once under Home.', '{}'::jsonb),

  ('faq', 'site_nav', 'Top Navigation',
   'The bar across the top of every page. Edit it once under Home and it changes everywhere.', '{}'::jsonb),
  ('faq', 'page_hero', 'Page opening',
   'The title block at the top of your questions page.',
   '{"page_hero_label":"A short line above the title, two or three words.","page_hero_headline":"The big title at the top of this page.","page_hero_subhead":"One or two sentences under the title."}'::jsonb),
  ('faq', 'faq_accordion', 'Question list',
   'The full list of questions and answers, each one opening when a visitor taps it. Every question and answer comes from your Business Facts.', '{}'::jsonb),
  ('faq', 'faq_footer_cta', 'Contact box',
   'A short line and your phone number at the bottom of the questions page, for anything the list did not answer.',
   '{"faq_cta_line":"The line above your phone number and booking button."}'::jsonb),
  ('faq', 'site_footer', 'Footer',
   'The bottom of every page: your hours, address, licence and links. Edit it once under Home.', '{}'::jsonb)
)
UPDATE public.site_templates AS t
SET section_catalog = jsonb_set(
      t.section_catalog,
      '{page_types}',
      (
        SELECT jsonb_agg(
                 CASE WHEN pt->>'page_type' IN ('services', 'why_us', 'faq') THEN
                   jsonb_set(pt, '{sections}', (
                     SELECT jsonb_agg(
                              sec
                              || CASE WHEN m.section_key IS NULL THEN '{}'::jsonb
                                 ELSE jsonb_build_object(
                                        'label', m.label,
                                        'description', m.description,
                                        'field_help', m.field_help)
                                 END
                              ORDER BY (sec->>'order')::int
                            )
                     FROM jsonb_array_elements(pt->'sections') AS sec
                     LEFT JOIN meta m
                            ON m.section_key = sec->>'section_key'
                           AND m.page_type   = pt->>'page_type'
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


-- =====================================================================
-- Verification (paste after applying)
-- =====================================================================
--
-- 1. No section on the four live page types is missing a label:
--   SELECT pt->>'page_type' AS page_type,
--          sec->>'section_key' AS section_key,
--          sec->>'label' AS label
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') pt,
--        jsonb_array_elements(pt->'sections') sec
--   WHERE t.template_key='trades-v1'
--     AND pt->>'page_type' IN ('home','services','why_us','faq')
--     AND COALESCE(sec->>'label','') = ''
--   ORDER BY 1,2;
--   -- expect ZERO rows
--
-- 2. No manager label repeats a Facts eyebrow ("Services", "FAQs", "Reviews",
--    "Service areas", "Projects", "Differentiators"):
--   SELECT DISTINCT sec->>'label' AS label
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') pt,
--        jsonb_array_elements(pt->'sections') sec
--   WHERE t.template_key='trades-v1'
--     AND lower(sec->>'label') IN
--         ('services','faq','faqs','reviews','service areas','projects','differentiators')
--   ORDER BY 1;
--   -- expect ZERO rows
--
-- 3. The renamed home sections read as page elements:
--   SELECT sec->>'section_key', sec->>'label'
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') pt,
--        jsonb_array_elements(pt->'sections') sec
--   WHERE t.template_key='trades-v1' AND pt->>'page_type'='home'
--     AND sec->>'section_key' IN
--         ('services_grid','featured_work','reviews','service_area_chips','faq_teaser')
--   ORDER BY 1;
--   -- expect Service cards / Photo gallery / Review panel / Area tags /
--   --        Question preview
-- =====================================================================
