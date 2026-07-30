-- =====================================================================
-- Migration 094: drop trust_bar from trades-v1's home page
-- =====================================================================
-- Source: WEBSITE MANAGER — PHASE 1C follow-up (2026-07-29). Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Requires: migrations 091 + 092.
-- Safe to re-run: both statements are idempotent by construction.
-- =====================================================================
--
-- WHY
--
-- The reference mockup folds the trust items (license, hours, service area)
-- INTO the hero. Phase 1C moved them there: hero_home now composes the
-- `hero-media` catalog component, which renders them inline beneath the CTAs.
--
-- That left `trust_bar` as a section that can never have content — its renderer
-- returns an empty string, so the public page correctly shows nothing, but the
-- site manager's Sections tab listed it as a permanently-empty slot with no way
-- to fill it. An empty slot should mean "add content here"; this one meant
-- "this will never do anything".
--
-- Two changes, in order:
--   1. Remove trust_bar from trades-v1's home page_type in section_catalog and
--      renumber the remaining sections so `order` stays contiguous.
--   2. Delete the site_sections rows already provisioned from the old catalog.
--
-- NOT DELETED: the `trust_bar` renderer in src/lib/site-render/sections.ts, and
-- nothing stops another template from using the section. This drops it from ONE
-- page of ONE template — it is not a retirement of the concept.
--
-- DESTRUCTIVE STATEMENT DISCLOSURE (migrations/CLAUDE.md gates these):
-- statement 2 is a scoped DELETE. It removes site_sections rows WHERE
-- section_key = 'trust_bar' AND the page belongs to a trades-v1 home page.
-- No other section, page, template or business is touched. site_fields rows
-- cascade from site_sections (ON DELETE CASCADE, migration 091) — trust_bar has
-- never had an authored field, since its renderer takes no input, so this
-- cascades over zero rows. Verification query 4 below confirms that before you
-- apply, and query 5 confirms it after.
-- =====================================================================


-- ── 1. Remove trust_bar from the catalog, renumbering what remains ────
-- jsonb_agg over the surviving sections with a fresh ordinal, so `order` has no
-- gap where trust_bar used to sit. Only the 'home' page_type is rewritten;
-- every other page_type object passes through untouched.
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
                       COALESCE((
                         SELECT jsonb_agg(
                                  jsonb_set(sec, '{order}', to_jsonb(new_order))
                                  ORDER BY new_order
                                )
                         FROM (
                           SELECT sec,
                                  ROW_NUMBER() OVER (ORDER BY (sec->>'order')::int) AS new_order
                           FROM jsonb_array_elements(pt->'sections') AS sec
                           WHERE sec->>'section_key' <> 'trust_bar'
                         ) AS renumbered
                       ), '[]'::jsonb)
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
  -- Idempotent: once trust_bar is gone the predicate is false and this is a no-op.
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(t.section_catalog->'page_types') AS pt,
         jsonb_array_elements(pt->'sections') AS sec
    WHERE pt->>'page_type' = 'home'
      AND sec->>'section_key' = 'trust_bar'
  );


-- ── 2. Drop the already-provisioned rows ─────────────────────────────
-- Scoped: only trust_bar, only on home pages, only for sites on trades-v1.
DELETE FROM public.site_sections ss
USING public.site_pages sp,
      public.sites s,
      public.site_templates t
WHERE ss.page_id       = sp.id
  AND sp.site_id       = s.id
  AND s.template_id    = t.id
  AND t.template_key   = 'trades-v1'
  AND sp.page_type     = 'home'
  AND ss.section_key   = 'trust_bar';


-- =====================================================================
-- Verification (paste after applying)
-- =====================================================================
--
-- 1. trust_bar is gone from the catalog:
--   SELECT count(*) AS trust_bar_in_catalog
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') AS pt,
--        jsonb_array_elements(pt->'sections') AS sec
--   WHERE t.template_key='trades-v1' AND pt->>'page_type'='home'
--     AND sec->>'section_key'='trust_bar';
--   -- expect 0
--
-- 2. The home section list is contiguous 1..13 with no gap:
--   SELECT (sec->>'order')::int AS ord, sec->>'section_key' AS section_key
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') AS pt,
--        jsonb_array_elements(pt->'sections') AS sec
--   WHERE t.template_key='trades-v1' AND pt->>'page_type'='home'
--   ORDER BY ord;
--   -- expect 13 rows, ord 1..13, no trust_bar, starting site_nav / hero_home
--
-- 3. Other page types are untouched:
--   SELECT pt->>'page_type' AS page_type,
--          jsonb_array_length(pt->'sections') AS sections
--   FROM public.site_templates t,
--        jsonb_array_elements(t.section_catalog->'page_types') AS pt
--   WHERE t.template_key='trades-v1'
--   ORDER BY 1;
--   -- expect 9 page types; only 'home' changed (14 -> 13)
--
-- 4. BEFORE applying — confirm no authored field would cascade away:
--   SELECT count(*) AS fields_on_trust_bar
--   FROM public.site_fields f
--   JOIN public.site_sections ss ON ss.id = f.section_id
--   WHERE ss.section_key = 'trust_bar';
--   -- expect 0. If this is NOT 0, stop and report before applying.
--
-- 5. AFTER applying — the provisioned rows are gone:
--   SELECT count(*) AS trust_bar_rows FROM public.site_sections
--   WHERE section_key = 'trust_bar';
--   -- expect 0
--
-- 6. Re-provisioning does not bring it back (idempotency of 1):
--   -- POST /api/internal/provision-site {"businessSlug":"jkqualityelectric"}
--   SELECT count(*) FROM public.site_sections WHERE section_key = 'trust_bar';
--   -- expect 0
-- =====================================================================
