-- =====================================================================
-- Migration 095: mark font_family site-authored in trades-v1
-- =====================================================================
-- Source: WEBSITE MANAGER — site-authored field audit (2026-07-29). Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Requires: migration 092.
-- Safe to re-run: guarded UPDATE, no-op once applied.
-- =====================================================================
--
-- WHY
--
-- /sites/[slug] reads the heading font from site_fields.font_family (the 1C D2
-- fix, which stopped the site borrowing businesses.hero_font — that column is
-- business-landing-page's output for its own rendering, not this site's brand).
--
-- But font_family was never listed in trades-v1's field_derivation_map. The site
-- manager builds its editable-field list FROM that map, so nothing could ever
-- write font_family and it stayed null forever — read by the renderer, writable
-- by nobody.
--
-- theme_color had the same end result for a different reason: it WAS marked
-- site_authored, but the manager only surfaced fields it could attach to a
-- section, and the site-level ones were never grouped anywhere. Six of the seven
-- site-authored fields had no input at all. That is fixed in the route, not
-- here; this migration only closes the data gap for font_family.
--
-- The route unions "font_family" into its site-level list regardless, so the
-- input works before and after this is applied. Applying it makes the map the
-- honest record of what is site-authored, which is what the manager and any
-- future readiness scoring should read.
-- =====================================================================

UPDATE public.site_templates
SET field_derivation_map = jsonb_set(
      field_derivation_map,
      '{site_fields,font_family}',
      jsonb_build_object(
        'site_authored', true,
        'note', 'heading font stack; closed list of the families /sites/[slug] can render'
      ),
      true    -- create_missing
    ),
    updated_at = now()
WHERE template_key = 'trades-v1'
  AND NOT (field_derivation_map->'site_fields' ? 'font_family');


-- =====================================================================
-- Verification (paste after applying)
-- =====================================================================
--
-- 1. font_family is present and marked site-authored:
--   SELECT field_derivation_map->'site_fields'->'font_family'
--   FROM public.site_templates WHERE template_key = 'trades-v1';
--   -- expect {"note": "...", "site_authored": true}
--
-- 2. The site-authored list is now 8:
--   SELECT count(*) AS site_authored_count
--   FROM public.site_templates t,
--        jsonb_each(t.field_derivation_map->'site_fields') AS f(key, val)
--   WHERE t.template_key = 'trades-v1' AND val ? 'site_authored';
--   -- expect 8 (was 7: tagline, theme_color, canonical_origin, booking_url,
--   --           price_range, years_in_business, home_base_area)
--
-- 3. The derived count is unchanged — nothing was reclassified:
--   SELECT count(*) AS derived_count
--   FROM public.site_templates t,
--        jsonb_each(t.field_derivation_map->'site_fields') AS f(key, val)
--   WHERE t.template_key = 'trades-v1' AND val ? 'derives_from';
--   -- expect 25
-- =====================================================================
