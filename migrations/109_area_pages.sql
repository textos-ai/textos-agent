-- =====================================================================
-- Migration 109: area pages (2C Part C) + duplicate-content threshold (Part D)
-- =====================================================================
-- Requires: 104, 107, 108.  Safe to re-run.
-- =====================================================================

-- ── 1. area_detail is generated from business_service_areas ───────────
--
-- One page per row: three areas means three pages, twenty means twenty, one
-- means one. `instance_source` tells the provisioner where the instances come
-- from, so the count is never fixed in code.
--
-- The route is built at PROVISION time and stored on site_pages.route_path:
-- /areas/{city}-{region}-{trade_noun}. It is never recomputed at render. Editing
-- trade_noun later therefore cannot silently rewrite a live URL and break inbound
-- links — the manager surfaces those pages as stale and regenerating is a
-- deliberate action.
--
-- Area pages are the only keyword-rich URLs. /services and /why-us stay clean:
-- geographic competition happens on area pages, and nobody searches "why us".
UPDATE public.site_templates AS t
SET section_catalog = jsonb_set(
      t.section_catalog,
      '{page_types}',
      (
        SELECT jsonb_agg(
                 CASE pt->>'page_type'
                   WHEN 'area_detail' THEN pt
                     || jsonb_build_object('instance_source', 'service_areas')
                     || jsonb_build_object('meta_formula', jsonb_build_object(
                          'title', '{trade_noun} in {city}, {region_code} — {business_name}',
                          'description', '{business_name} covers {city} and the surrounding streets. Local {trade_noun_plural} for {service_list} and more. Call for a quote.'))
                   ELSE pt END
                 ORDER BY ord
               )
        FROM jsonb_array_elements(t.section_catalog->'page_types')
             WITH ORDINALITY AS x(pt, ord)
      )
    ),
    updated_at = now()
WHERE t.template_key = 'trades-v1';


-- ── 2. Service Areas becomes a dropdown (C5) ──────────────────────────
--
-- Second instance of the nav-dd component built for About Us. Its children are
-- not listable in the template — they are one per service area, per business — so
-- the item declares WHERE its children come from and navLinks expands it at
-- render. The parent stays a real page link to the area index, unlike About Us
-- which is a button because it has no page of its own.
UPDATE public.site_templates AS t
SET section_catalog = jsonb_set(
      t.section_catalog,
      '{nav,items}',
      (
        SELECT jsonb_agg(
                 CASE WHEN item->>'label' = 'Service Areas'
                      THEN item || jsonb_build_object('children_from', 'area_pages')
                      ELSE item END
                 ORDER BY ord
               )
        FROM jsonb_array_elements(t.section_catalog->'nav'->'items')
             WITH ORDINALITY AS x(item, ord)
      )
    ),
    updated_at = now()
WHERE t.template_key = 'trades-v1';


-- ── 3. duplicate-content threshold (Part D) ───────────────────────────
--
-- Area pages generated from a template are doorway pages unless each says
-- something true about that specific place. The reference scores ~5% unique
-- tokens per area page; that is the failure case this exists to detect.
--
-- A TEMPLATE FIELD, not a constant: what counts as enough local writing differs
-- by vertical and by how much a client is willing to write.
UPDATE public.site_templates AS t
SET section_catalog = t.section_catalog || jsonb_build_object(
      'duplicate_content', jsonb_build_object(
        'unique_token_threshold', 0.25,
        'note', 'Warn below this ratio of unique tokens per area page, after masking '
             || 'the area name itself. Advisory only — there is no publish flow to block.'))
WHERE t.template_key = 'trades-v1';


-- ── 4. article + length corrections to 108's formulas ─────────────────
--
-- 108 shipped "{business_name} is a {trade_noun}", which renders "is a
-- electrician" for any vowel-initial trade. Rather than teach the renderer
-- English articles — where "a HVAC contractor" and "an HVAC contractor" are both
-- defensible depending on pronunciation — the copy avoids the indefinite article
-- entirely. Wording belongs in the template.
--
-- The services description also measured 163 characters against the 140-160
-- band; shortened here rather than truncated at render.
UPDATE public.site_templates AS t
SET section_catalog = jsonb_set(
      t.section_catalog,
      '{page_types}',
      (
        SELECT jsonb_agg(
                 CASE pt->>'page_type'
                   WHEN 'home' THEN jsonb_set(pt, '{meta_formula,description}',
                     to_jsonb('{business_name} is your local {trade_noun} for {area_list} and the surrounding area. {service_list} and more. Call for a quote.'::text))
                   WHEN 'services' THEN jsonb_set(pt, '{meta_formula,description}',
                     to_jsonb('What {business_name} does: {service_list} and more, across {area_list}. Every job by a local {trade_noun}. Call to talk it through.'::text))
                   WHEN 'area_detail' THEN jsonb_set(pt, '{meta_formula,description}',
                     to_jsonb('{business_name} covers {city} and the surrounding streets. Local {trade_noun_plural} for {service_list} and more. Call for a quote.'::text))
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
-- Verification
-- =====================================================================
-- 1. area_detail is source-driven and has a formula:
--   SELECT pt->>'instance_source', pt->'meta_formula'->>'title'
--   FROM public.site_templates t, jsonb_array_elements(t.section_catalog->'page_types') pt
--   WHERE t.template_key='trades-v1' AND pt->>'page_type'='area_detail';
--   -- expect service_areas, and a title containing {city}
--
-- 2. Service Areas draws its children from area pages:
--   SELECT item->>'label', item->>'page_type', item->>'children_from'
--   FROM public.site_templates t, jsonb_array_elements(t.section_catalog->'nav'->'items') item
--   WHERE t.template_key='trades-v1';
--   -- expect Service Areas / area_index / area_pages; the other three unchanged
--
-- 3. No indefinite article before a vowel-initial trade noun:
--   SELECT pt->>'page_type' FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') pt
--   WHERE t.template_key='trades-v1'
--     AND pt->'meta_formula'->>'description' LIKE '%is a {trade_noun}%';
--   -- expect 0 rows
--
-- 4. Threshold present:
--   SELECT section_catalog->'duplicate_content'->>'unique_token_threshold'
--   FROM public.site_templates WHERE template_key='trades-v1';
--   -- expect 0.25
--
-- 5. STANDING POST-CONDITION for any migration touching section_catalog
--    (see 104/105/106/107/108):
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
