-- =====================================================================
-- Migration 102: Phase 2B — projects, contact, legal (×2 instances)
-- =====================================================================
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Requires: 092, 097, 099, 100, 101.
-- Safe to re-run: rewrites the three page_types idempotently, keyed on
--                 section_key / instance_key.
-- =====================================================================
--
-- WHAT THIS DOES
--
--   1. legal gets two INSTANCES with clean URLs: /terms-of-service and
--      /privacy-policy. The page_type's route was the placeholder '/{doc_slug}';
--      instances carry the real paths, titles and clause structure.
--   2. contact_form is REMOVED from the contact page. Leads from client sites
--      belong in Go High Level (Phase 3); a form-to-email path built now would be
--      built twice and one of them thrown away. The catalog should say what the
--      page actually is, so the section comes out rather than being left to log
--      "no_renderer_for_section" on every request.
--   3. Labels, descriptions and field help for every section on all four new
--      pages. 099 covered home, 101 covered the 2A pages; without this the
--      manager falls back to title-casing keys ("Legal Body", "Faq Accordion").
--   4. 13 new site-authored fields: legal_last_updated and clause_1..clause_12.
--
-- LEGAL: STRUCTURE YES, WORDS NO
--
-- The reference ToS ships 12 numbered clauses with full prose, an
-- "⚠️ Attorney Review Required" banner, and three explicit client blanks
-- ([DATE — insert before launch], payment terms, cancellation policy). NONE of
-- that prose is copied here.
--
-- What this migration ships is the STRUCTURE: the clause headings and their
-- order, per instance. Every clause BODY is a site-authored field with NO
-- DEFAULT. A clause whose body is empty renders NOTHING — heading included — so
-- the public page can never show a half-written legal term, and the manager shows
-- the gap. This is a licensed contractor's public legal page: an absent clause is
-- recoverable, a fabricated payment term is not. Same rule as never generating
-- review text.
--
-- The clause headings are the reference document's own, because the numbering IS
-- the structure a lawyer will review against. The words inside them are Rob's to
-- source.
--
-- The attorney-review banner is deliberately NOT reproduced: it is a note to the
-- builder, not to the client's visitors, and it has no place on a public page.
-- legal_notice renders the "Last updated" line instead — the only public
-- notice-like element on the reference page — and renders nothing when the date
-- is unset.
-- =====================================================================

-- ── 1. projects / contact / legal: sections, labels, help, instances ───
WITH meta(page_type, section_key, label, description, field_help) AS (
  VALUES
  -- PROJECTS ---------------------------------------------------------------
  ('projects', 'site_nav', 'Top Navigation',
   'The bar across the top of every page. Edit it once under Home and it changes everywhere.', '{}'::jsonb),
  ('projects', 'page_hero', 'Page opening',
   'The title block at the top of your work page.',
   '{"page_hero_label":"A short line above the title, two or three words.","page_hero_headline":"The big title at the top of this page.","page_hero_subhead":"One or two sentences under the title."}'::jsonb),
  ('projects', 'project_gallery', 'Photo wall',
   'Every job photo you have added, in a column layout that keeps each photo''s own shape. The photo and its caption come from your Business Facts; you write the heading above them.',
   '{"section_headline":"The heading above your photo wall."}'::jsonb),
  ('projects', 'gallery_cta', 'Invitation below the photos',
   'A short line and a booking button under the photo wall, for someone who has just finished looking through your work.',
   '{"section_headline":"The line above the booking button."}'::jsonb),
  ('projects', 'site_footer', 'Footer',
   'The bottom of every page: your hours, address, licence and links. Edit it once under Home.', '{}'::jsonb),

  -- CONTACT ----------------------------------------------------------------
  ('contact', 'site_nav', 'Top Navigation',
   'The bar across the top of every page. Edit it once under Home and it changes everywhere.', '{}'::jsonb),
  ('contact', 'page_hero', 'Page opening',
   'The title block at the top of your contact page.',
   '{"page_hero_label":"A short line above the title, two or three words.","page_hero_headline":"The big title at the top of this page.","page_hero_subhead":"One or two sentences under the title."}'::jsonb),
  ('contact', 'contact_direct', 'Ways to reach you',
   'Your phone number, email, address, opening hours and a directions link, all in one block. Every part of it comes from your Business Facts — there is nothing to write here.',
   '{"section_headline":"The heading above your contact details."}'::jsonb),
  ('contact', 'site_footer', 'Footer',
   'The bottom of every page: your hours, address, licence and links. Edit it once under Home.', '{}'::jsonb),

  -- LEGAL ------------------------------------------------------------------
  ('legal', 'site_nav', 'Top Navigation',
   'The bar across the top of every page. Edit it once under Home and it changes everywhere.', '{}'::jsonb),
  ('legal', 'page_hero', 'Page opening',
   'The title of this legal document.',
   '{"page_hero_subhead":"An optional sentence under the title."}'::jsonb),
  ('legal', 'legal_notice', 'Last updated',
   'The date this document was last changed, shown under the title. Leave it empty and no date is shown.',
   '{"legal_last_updated":"The date you last revised this document, written how you want it read, e.g. \"12 March 2026\"."}'::jsonb),
  ('legal', 'legal_body', 'Clauses',
   'The numbered sections of this document. Each one is empty until you paste the reviewed wording in. An empty clause does not appear on your site at all — nothing is ever written for you here.', '{}'::jsonb),
  ('legal', 'site_footer', 'Footer',
   'The bottom of every page: your hours, address, licence and links. Edit it once under Home.', '{}'::jsonb)
)
UPDATE public.site_templates AS t
SET section_catalog = jsonb_set(
      t.section_catalog,
      '{page_types}',
      (
        SELECT jsonb_agg(
                 CASE WHEN pt->>'page_type' IN ('projects', 'contact', 'legal') THEN
                   jsonb_set(pt, '{sections}', (
                     SELECT COALESCE(jsonb_agg(
                              sec
                              || CASE WHEN m.section_key IS NULL THEN '{}'::jsonb
                                 ELSE jsonb_build_object(
                                        'label', m.label,
                                        'description', m.description,
                                        'field_help', m.field_help)
                                 END
                              ORDER BY (sec->>'order')::int
                            ), '[]'::jsonb)
                     FROM jsonb_array_elements(pt->'sections') AS sec
                     LEFT JOIN meta m
                            ON m.section_key = sec->>'section_key'
                           AND m.page_type   = pt->>'page_type'
                     -- contact_form comes OUT (see header note 2).
                     WHERE sec->>'section_key' <> 'contact_form'
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


-- ── 2. legal instances: clean URLs, titles, clause STRUCTURE ───────────
--
-- Two documents from one page_type. `instances` is read by the provisioner (one
-- site_pages row per entry, instance_key set) and by the legal_body renderer,
-- which takes its clause headings from the instance it is rendering.
--
-- Every clause has a heading and a field key. No clause has body text.
UPDATE public.site_templates AS t
SET section_catalog = jsonb_set(
      t.section_catalog,
      '{page_types}',
      (
        SELECT jsonb_agg(
                 CASE WHEN pt->>'page_type' = 'legal' THEN
                   pt || jsonb_build_object('instances', jsonb_build_array(
                     jsonb_build_object(
                       'instance_key', 'terms-of-service',
                       'route', '/terms-of-service',
                       'title', 'Terms of Service',
                       'clauses', jsonb_build_array(
                         jsonb_build_object('field', 'clause_1',  'heading', '1. Overview'),
                         jsonb_build_object('field', 'clause_2',  'heading', '2. Services'),
                         jsonb_build_object('field', 'clause_3',  'heading', '3. Quotes and Estimates'),
                         jsonb_build_object('field', 'clause_4',  'heading', '4. Satisfaction Guarantee'),
                         jsonb_build_object('field', 'clause_5',  'heading', '5. Payment Terms'),
                         jsonb_build_object('field', 'clause_6',  'heading', '6. Limitation of Liability'),
                         jsonb_build_object('field', 'clause_7',  'heading', '7. Booking and Cancellations'),
                         jsonb_build_object('field', 'clause_8',  'heading', '8. Intellectual Property'),
                         jsonb_build_object('field', 'clause_9',  'heading', '9. Third-Party Links and Services'),
                         jsonb_build_object('field', 'clause_10', 'heading', '10. Governing Law'),
                         jsonb_build_object('field', 'clause_11', 'heading', '11. Changes to Terms'),
                         jsonb_build_object('field', 'clause_12', 'heading', '12. Contact')
                       )
                     ),
                     jsonb_build_object(
                       'instance_key', 'privacy-policy',
                       'route', '/privacy-policy',
                       'title', 'Privacy Policy',
                       'clauses', jsonb_build_array(
                         jsonb_build_object('field', 'clause_1',  'heading', '1. Who We Are'),
                         jsonb_build_object('field', 'clause_2',  'heading', '2. What Information We Collect'),
                         jsonb_build_object('field', 'clause_3',  'heading', '3. How We Use Your Information'),
                         jsonb_build_object('field', 'clause_4',  'heading', '4. Third-Party Service Providers'),
                         jsonb_build_object('field', 'clause_5',  'heading', '5. Cookies'),
                         jsonb_build_object('field', 'clause_6',  'heading', '6. Data Retention'),
                         jsonb_build_object('field', 'clause_7',  'heading', '7. Your Rights'),
                         jsonb_build_object('field', 'clause_8',  'heading', '8. Security'),
                         jsonb_build_object('field', 'clause_9',  'heading', '9. Children''s Privacy'),
                         jsonb_build_object('field', 'clause_10', 'heading', '10. Governing Law'),
                         jsonb_build_object('field', 'clause_11', 'heading', '11. Changes to This Policy'),
                         jsonb_build_object('field', 'clause_12', 'heading', '12. Contact for Privacy Questions')
                       )
                     )
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


-- ── 3. meta defaults for the legal instances ──────────────────────────
-- The page_type's meta_defaults cannot serve two documents, so each instance
-- carries its own. {business_name} is the only placeholder, as in 100.
UPDATE public.site_templates AS t
SET section_catalog = jsonb_set(
      t.section_catalog,
      '{page_types}',
      (
        SELECT jsonb_agg(
                 CASE WHEN pt->>'page_type' = 'legal' THEN
                   jsonb_set(pt, '{instances}', (
                     SELECT jsonb_agg(
                              inst || CASE inst->>'instance_key'
                                WHEN 'terms-of-service' THEN jsonb_build_object('meta_defaults', jsonb_build_object(
                                  'title', 'Terms of Service — {business_name}',
                                  'description', 'The terms that apply when you book work with {business_name}.'))
                                WHEN 'privacy-policy' THEN jsonb_build_object('meta_defaults', jsonb_build_object(
                                  'title', 'Privacy Policy — {business_name}',
                                  'description', 'How {business_name} handles the information you share.'))
                                ELSE '{}'::jsonb END
                              ORDER BY ord2
                            )
                     FROM jsonb_array_elements(pt->'instances') WITH ORDINALITY AS y(inst, ord2)
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


-- ── 4. 13 new site-authored fields, none with a default ───────────────
UPDATE public.site_templates AS t
SET field_derivation_map = jsonb_set(
      t.field_derivation_map,
      '{site_fields}',
      COALESCE(t.field_derivation_map->'site_fields', '{}'::jsonb)
      || jsonb_build_object(
           'legal_last_updated', jsonb_build_object('site_authored', true),
           'clause_1',  jsonb_build_object('site_authored', true),
           'clause_2',  jsonb_build_object('site_authored', true),
           'clause_3',  jsonb_build_object('site_authored', true),
           'clause_4',  jsonb_build_object('site_authored', true),
           'clause_5',  jsonb_build_object('site_authored', true),
           'clause_6',  jsonb_build_object('site_authored', true),
           'clause_7',  jsonb_build_object('site_authored', true),
           'clause_8',  jsonb_build_object('site_authored', true),
           'clause_9',  jsonb_build_object('site_authored', true),
           'clause_10', jsonb_build_object('site_authored', true),
           'clause_11', jsonb_build_object('site_authored', true),
           'clause_12', jsonb_build_object('site_authored', true)
         )
    ),
    updated_at = now()
WHERE t.template_key = 'trades-v1';


-- =====================================================================
-- Verification (paste after applying)
-- =====================================================================
--
-- 1. contact_form is gone; the three page types have their sections labelled:
--   SELECT pt->>'page_type', sec->>'section_key', sec->>'label'
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') pt,
--        jsonb_array_elements(pt->'sections') sec
--   WHERE t.template_key='trades-v1'
--     AND pt->>'page_type' IN ('projects','contact','legal')
--   ORDER BY 1, (sec->>'order')::int;
--   -- expect NO contact_form row, and no empty label
--
-- 2. Two legal instances with clean URLs and 12 clauses each:
--   SELECT inst->>'instance_key', inst->>'route', inst->>'title',
--          jsonb_array_length(inst->'clauses') AS clauses,
--          inst->'meta_defaults'->>'title' AS meta_title
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') pt,
--        jsonb_array_elements(pt->'instances') inst
--   WHERE t.template_key='trades-v1' AND pt->>'page_type'='legal';
--   -- expect terms-of-service /terms-of-service 12, privacy-policy /privacy-policy 12
--
-- 3. NO clause carries body text — structure only:
--   SELECT count(*) FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') pt,
--        jsonb_array_elements(pt->'instances') inst,
--        jsonb_array_elements(inst->'clauses') cl
--   WHERE t.template_key='trades-v1' AND pt->>'page_type'='legal'
--     AND cl ?| array['body','text','default'];
--   -- expect 0
--
-- 4. The 13 new fields are site-authored and have no default:
--   SELECT key, value
--   FROM public.site_templates t,
--        jsonb_each(t.field_derivation_map->'site_fields')
--   WHERE t.template_key='trades-v1'
--     AND (key LIKE 'clause_%' OR key = 'legal_last_updated')
--   ORDER BY 1;
--   -- expect 13 rows, each exactly {"site_authored": true}
--
-- 5. legal is still noindex (robots=Disallow), matching the reference
--    robots.txt which disallows /tos.html and /privacy.html:
--   SELECT pt->>'page_type', pt->>'robots'
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') pt
--   WHERE t.template_key='trades-v1' AND pt->>'page_type'='legal';
--   -- expect Disallow
-- =====================================================================
