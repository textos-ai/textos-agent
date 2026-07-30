-- =====================================================================
-- Migration 099: section labels, descriptions + field help for trades-v1
-- =====================================================================
-- Source: WEBSITE MANAGER — ORIENTATION PASS, parts A + D (2026-07-29).
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Requires: 092, 097 (trust_bar present).
-- Safe to re-run: rewrites the home sections idempotently from the key.
-- =====================================================================
--
-- WHY
--
-- A client opening the site manager saw "Section eyebrow / Section headline"
-- under "Services Grid" with no way to know where that lands on their page. The
-- manager was deriving display names from the section KEY ("faq_teaser" ->
-- "Faq Teaser") and had no description at all.
--
-- Three fields per section, all VERTICAL-SPECIFIC and therefore template data,
-- not code — a future vertical writes its own without touching the Worker:
--
--   label        the display name. Fixes "Faq Teaser" -> "FAQ", "Cta Band" ->
--                "Call To Action". Key-derived title-casing cannot know that FAQ
--                and CTA are acronyms, so the catalog carries the real name.
--   description  what the section IS and WHERE it sits, in client language.
--                Deliberately no designer vocabulary — no "eyebrow", no
--                "hero", no section keys.
--   field_help   per-field help for fields whose meaning depends on THIS
--                template. Universal field help stays in FIELD_UI in the route.
--
-- Written as a full rebuild of the home page_types entry keyed on section_key,
-- so re-running is a no-op and the order/`fields` arrays already there survive.
-- =====================================================================

WITH meta(section_key, label, description, field_help) AS (
  VALUES
  ('site_nav', 'Top Navigation',
   'The bar across the top of every page: your logo, the menu links, your phone number and the booking button.',
   '{"tagline":"The small line under your business name in the top bar, e.g. \"Licensed Electricians\".","nav_cta_label":"Wording on the button at the top right of the page."}'::jsonb),

  ('hero_home', 'Opening Panel',
   'The big opening panel at the very top of the page, with your background photo or video behind it.',
   '{"hero_eyebrow":"A short line above the main headline, usually a few words in your brand colour.","hero_headline":"The largest text on the page. Keep it short — four to seven words reads best.","hero_subhead":"One sentence under the headline explaining what you do and where.","hero_cta_label":"Wording on the main button, e.g. \"Book Online\".","hero_cta_secondary_label":"Wording on the second button. Leave blank to show Call plus your phone number."}'::jsonb),

  ('trust_bar', 'Trust Strip',
   'The thin strip of short credentials directly under the opening panel — licence number, years in business, opening hours. Filled automatically from your Business Facts.',
   '{}'::jsonb),

  ('services_grid', 'Services',
   'The service cards below the trust strip. Each card comes from a service in your Business Facts.',
   '{"section_eyebrow":"A short line above this section''s heading.","section_headline":"The heading above your service cards."}'::jsonb),

  ('positioning_band', 'Positioning Quote',
   'The large italic quote about who you serve, between the service cards and your project photos.',
   '{"section_eyebrow":"A short line above the quote.","positioning_quote":"One or two sentences about who you work for and why they choose you. Shown in large italic type."}'::jsonb),

  ('featured_work', 'Project Photos',
   'Your project photo gallery, below the quote. Each photo comes from a project in your Business Facts — a project needs a photo to appear here.',
   '{"section_eyebrow":"A short line above the gallery heading.","section_headline":"The heading above your project photos."}'::jsonb),

  ('reviews', 'Reviews',
   'Where customer reviews appear, below your project photos. Stays empty until you connect your Google listing — we never write reviews for you.',
   '{"section_headline":"The heading above the reviews area."}'::jsonb),

  ('service_area_chips', 'Service Areas',
   'The grid of town and city names showing where you work, taken from the service areas in your Business Facts.',
   '{"section_eyebrow":"A short line above the list of areas.","section_headline":"The heading above your service areas."}'::jsonb),

  ('differentiator_band', 'Highlights',
   'A band of short highlight tags that set you apart, below your service areas. The tags come from the differentiators in your Business Facts.',
   '{"section_eyebrow":"A short line above the highlights.","section_headline":"The heading for the highlights band.","band_body":"A sentence or two introducing what makes you different."}'::jsonb),

  ('faq_teaser', 'FAQ',
   'The expandable question-and-answer list near the bottom of the page. Questions come from the FAQs in your Business Facts.',
   '{"section_eyebrow":"A short line above the questions.","section_headline":"The heading above your questions."}'::jsonb),

  ('cta_band', 'Call To Action',
   'The full-width coloured band near the bottom of the page, just above the footer.',
   '{"cta_headline":"The large heading inside the coloured band.","cta_primary_label":"Wording on the button in the coloured band."}'::jsonb),

  ('site_footer', 'Footer',
   'The dark block at the very bottom of every page: contact details, opening hours, quick links and your licence line.',
   '{"footer_tagline":"A short line under your business name in the footer."}'::jsonb),

  ('chat_widget', 'Chat Placeholder',
   'A reserved spot for a chat button. Nothing appears on your site yet.',
   '{}'::jsonb),

  ('mobile_sticky_bar', 'Mobile Buttons',
   'The call and book buttons that stay fixed to the bottom of the screen on phones. Not shown on desktop.',
   '{"sticky_call_label":"Wording on the call button on phones.","sticky_book_label":"Wording on the book button on phones."}'::jsonb)
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
                                 ELSE jsonb_build_object(
                                        'label', m.label,
                                        'description', m.description,
                                        'field_help', m.field_help)
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


-- =====================================================================
-- Verification (paste after applying)
-- =====================================================================
--
-- 1. Every home section has a label and a description:
--   SELECT (sec->>'order')::int AS ord,
--          sec->>'section_key'  AS section_key,
--          sec->>'label'        AS label,
--          left(sec->>'description', 54) || '…' AS description
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') AS pt,
--        jsonb_array_elements(pt->'sections') AS sec
--   WHERE t.template_key='trades-v1' AND pt->>'page_type'='home'
--   ORDER BY ord;
--   -- expect 14 rows, no NULL label, no NULL description
--
-- 2. The acronym labels are right (the "Faq Teaser" bug):
--   SELECT sec->>'section_key', sec->>'label'
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') AS pt,
--        jsonb_array_elements(pt->'sections') AS sec
--   WHERE t.template_key='trades-v1' AND pt->>'page_type'='home'
--     AND sec->>'section_key' IN ('faq_teaser','cta_band');
--   -- expect faq_teaser -> FAQ, cta_band -> Call To Action
--
-- 3. No description contains designer vocabulary:
--   SELECT sec->>'section_key'
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') AS pt,
--        jsonb_array_elements(pt->'sections') AS sec
--   WHERE t.template_key='trades-v1' AND pt->>'page_type'='home'
--     AND (sec->>'description' ILIKE '%eyebrow%' OR sec->>'description' ILIKE '%hero%');
--   -- expect 0 rows
--
-- 4. Order is still contiguous 1..14 and nothing was dropped:
--   SELECT count(*) AS sections,
--          bool_and((sec->>'order')::int = rn) AS contiguous
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') AS pt,
--        LATERAL (SELECT sec, row_number() OVER (ORDER BY (sec->>'order')::int) AS rn
--                 FROM jsonb_array_elements(pt->'sections') AS sec) AS s
--   WHERE t.template_key='trades-v1' AND pt->>'page_type'='home';
--   -- expect 14, true
--
-- 5. Other page types untouched:
--   SELECT pt->>'page_type', jsonb_array_length(pt->'sections')
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') AS pt
--   WHERE t.template_key='trades-v1' ORDER BY 1;
--   -- expect 9 rows; home 14, others unchanged (no label/description added there)
-- =====================================================================
