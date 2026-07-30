-- =====================================================================
-- Migration 100: clean URLs + per-page meta
-- =====================================================================
-- Source: WEBSITE MANAGER — PHASE 2A, steps 1 + 4 (2026-07-29). Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Requires: 091 (site_pages), 092 (trades-v1).
-- Safe to re-run: guarded ADD COLUMN, and the route rewrite is idempotent
--   (it only strips a suffix that is no longer there after the first run).
-- =====================================================================
--
-- WHY — CLEAN URLS
--
-- trades-v1's page routes carried `.html` suffixes: /services.html,
-- /why-us.html, /faq.html and so on. That is an artifact of the reference
-- mockup being a static file tree. Under SSR the suffix means nothing, and it
-- would end up in every canonical tag, sitemap entry and nav href.
--
--   /services.html      ->  /services
--   /projects.html      ->  /projects
--   /why-us.html        ->  /why-us
--   /faq.html           ->  /faq
--   /contact.html       ->  /contact
--   /{doc_slug}.html    ->  /{doc_slug}      (legal, instances in 2B:
--                                             terms-of-service, privacy-policy)
--
-- home (/), area_index (/areas/) and area_detail (/areas/{area_slug}) already
-- had no suffix and are untouched.
--
-- WHY — site_pages.meta
--
-- Each page needs its own title, description, canonical and OG tags. There was
-- nowhere to put them: site_pages has route_path and title, but no description
-- and no OG. `meta jsonb` holds the resolved per-page set. Provisioning seeds it
-- from the catalog's per-page-type defaults (added below), substituting
-- {business_name}; nothing else is templated, so substitution stays predictable.
--
-- NOTE ON RESERVED ROUTES (step 1 recon): /sites/{slug}/app,
-- /sites/{slug}/apps/* and /sites/{slug}/llms.txt are already claimed — the
-- first two by live _redirects rules serving generated mini-apps, the third by
-- an existing Astro route. A page may never be minted at those paths. That guard
-- lives in code (RESERVED_PAGE_SLUGS in lib/site-render/provision.ts) because it
-- is a property of the deployed routing table, not of any one template.
-- =====================================================================


-- ── 1. meta column ───────────────────────────────────────────────────
ALTER TABLE public.site_pages ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.site_pages.meta IS
  'Resolved per-page head meta: {title, description, og_image}. Seeded from the template''s per-page-type defaults at provision time.';


-- ── 2. strip .html from every page_type route ────────────────────────
UPDATE public.site_templates AS t
SET section_catalog = jsonb_set(
      t.section_catalog,
      '{page_types}',
      (
        SELECT jsonb_agg(
                 CASE
                   WHEN pt->>'route' LIKE '%.html'
                     THEN jsonb_set(pt, '{route}',
                            to_jsonb(left(pt->>'route', length(pt->>'route') - 5)))
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
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(t.section_catalog->'page_types') AS pt
    WHERE pt->>'route' LIKE '%.html'
  );


-- ── 3. per-page-type meta defaults ───────────────────────────────────
-- {business_name} is the only placeholder. Home deliberately has none: it falls
-- back to businesses.seo_title / seo_description, which business-landing-page
-- already generates and which reads better than anything generic here.
WITH m(page_type, title, description) AS (
  VALUES
  ('services', 'Our Services — {business_name}',
   'Full details of every service {business_name} offers, what each one covers, and how to book.'),
  ('why_us', 'Why Choose {business_name}',
   'Licensing, guarantees and the areas we cover — why customers choose {business_name}.'),
  ('faq', 'Frequently Asked Questions — {business_name}',
   'Answers to the questions customers ask {business_name} most often, before they book.'),
  ('projects', 'Recent Work — {business_name}',
   'A gallery of completed projects by {business_name}.'),
  ('contact', 'Contact {business_name}',
   'Phone, email, opening hours and how to reach {business_name}.'),
  ('legal', '{business_name}',
   'Legal information for {business_name}.'),
  ('area_index', 'Areas We Serve — {business_name}',
   'Every town and city {business_name} covers.'),
  ('area_detail', '{business_name}',
   'Local service information from {business_name}.')
)
UPDATE public.site_templates AS t
SET section_catalog = jsonb_set(
      t.section_catalog,
      '{page_types}',
      (
        SELECT jsonb_agg(
                 CASE WHEN m.page_type IS NULL THEN pt
                      ELSE pt || jsonb_build_object('meta_defaults',
                             jsonb_build_object('title', m.title, 'description', m.description))
                 END
                 ORDER BY ord
               )
        FROM jsonb_array_elements(t.section_catalog->'page_types')
             WITH ORDINALITY AS x(pt, ord)
        LEFT JOIN m ON m.page_type = pt->>'page_type'
      )
    ),
    updated_at = now()
WHERE t.template_key = 'trades-v1';


-- =====================================================================
-- Verification (paste after applying)
-- =====================================================================
--
-- 1. No .html left, and the clean routes are what we expect:
--   SELECT pt->>'page_type' AS page_type, pt->>'route' AS route
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') AS pt
--   WHERE t.template_key='trades-v1'
--   ORDER BY 1;
--   -- expect 9 rows, none ending .html:
--   --   area_detail /areas/{area_slug} · area_index /areas/ · contact /contact
--   --   faq /faq · home / · legal /{doc_slug} · projects /projects
--   --   services /services · why_us /why-us
--
-- 2. meta column exists with the right default:
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name='site_pages' AND column_name='meta';
--   -- expect jsonb, NO, '{}'::jsonb
--
-- 3. Every page type has meta defaults except home (deliberate):
--   SELECT pt->>'page_type' AS page_type,
--          pt->'meta_defaults'->>'title' AS title
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') AS pt
--   WHERE t.template_key='trades-v1'
--   ORDER BY 1;
--   -- expect 8 with a title, home NULL
--
-- 4. Existing home page row untouched and still routable:
--   SELECT route_path, page_type, meta FROM public.site_pages ORDER BY page_type;
--   -- expect home route_path='/', meta={}
--
-- 5. Section lists survived both rewrites (nothing dropped):
--   SELECT pt->>'page_type', jsonb_array_length(pt->'sections')
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') AS pt
--   WHERE t.template_key='trades-v1' ORDER BY 1;
--   -- expect: area_detail 9, area_index 4, contact 5, faq 5, home 14,
--   --         legal 5, projects 5, services 5, why_us 8
--
-- 6. Labels/descriptions from 099 survived (home only):
--   SELECT count(*) FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') AS pt,
--        jsonb_array_elements(pt->'sections') AS sec
--   WHERE t.template_key='trades-v1' AND pt->>'page_type'='home'
--     AND sec ? 'label';
--   -- expect 14 if 099 is applied, 0 if not — either way unchanged by this file
-- =====================================================================
