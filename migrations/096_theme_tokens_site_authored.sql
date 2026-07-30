-- =====================================================================
-- Migration 096: surface/ink/scrim/radius theme tokens for trades-v1
-- =====================================================================
-- Source: hero-headline contrast fix (2026-07-29). Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Requires: migration 092. Independent of 095 (both use create_missing and
--   touch different keys, so either order works).
-- Safe to re-run: guarded UPDATE, no-op once every key is present.
-- =====================================================================
--
-- WHY
--
-- The theme had exactly two tokens an operator could set: accent (theme_color)
-- and font_family. Everything else — text colour, section background, hero
-- overlay strength, corner radius — was hardcoded in trades-v1.css with a single
-- assumption baked in: text sits on a LIGHT surface.
--
-- hero-media breaks that assumption. It is deliberately dark (media + scrim, or
-- an accent-derived gradient when there is no media), so its headline needs an
-- ON-DARK colour. With no such token the sheet had nothing to reach for.
--
-- Five tokens, each with a template default so an unset site still renders
-- correctly — no site is required to fill these in:
--
--   ink_on_dark    #F7F8FA   headline/body over dark media
--   ink_on_light   #16181D   headline/body over light surfaces (was --site-ink)
--   surface_color  #FFFFFF   background for content sections (was --site-bg)
--   scrim_opacity  0.55      dark overlay strength over hero media
--   radius_scale   soft      sharp | soft -> drives --site-radius
--
-- The manager's Site settings group builds its field list FROM this map, so
-- these get inputs automatically once applied — no route change is needed to
-- surface them.
--
-- NOT CHANGED: theme_color and font_family keep their existing entries.
-- =====================================================================

UPDATE public.site_templates
SET field_derivation_map = jsonb_set(
      field_derivation_map,
      '{site_fields}',
      (field_derivation_map->'site_fields')
        || jsonb_build_object(
             'ink_on_dark', jsonb_build_object(
               'site_authored', true,
               'note', 'headline/body colour over dark media; template default #F7F8FA'),
             'ink_on_light', jsonb_build_object(
               'site_authored', true,
               'note', 'headline/body colour over light surfaces; template default #16181D'),
             'surface_color', jsonb_build_object(
               'site_authored', true,
               'note', 'background for content sections; template default #FFFFFF'),
             'scrim_opacity', jsonb_build_object(
               'site_authored', true,
               'note', 'dark overlay strength over hero media, 0..1; template default 0.55'),
             'radius_scale', jsonb_build_object(
               'site_authored', true,
               'note', 'sharp | soft -> drives --site-radius; template default soft')
           ),
      true    -- create_missing
    ),
    updated_at = now()
WHERE template_key = 'trades-v1'
  AND NOT (
        field_derivation_map->'site_fields' ? 'ink_on_dark'
    AND field_derivation_map->'site_fields' ? 'ink_on_light'
    AND field_derivation_map->'site_fields' ? 'surface_color'
    AND field_derivation_map->'site_fields' ? 'scrim_opacity'
    AND field_derivation_map->'site_fields' ? 'radius_scale'
  );


-- =====================================================================
-- Verification (paste after applying)
-- =====================================================================
--
-- 1. All five keys present and site-authored:
--   SELECT key, val->>'site_authored' AS site_authored
--   FROM public.site_templates t,
--        jsonb_each(t.field_derivation_map->'site_fields') AS f(key, val)
--   WHERE t.template_key = 'trades-v1'
--     AND key IN ('ink_on_dark','ink_on_light','surface_color','scrim_opacity','radius_scale')
--   ORDER BY key;
--   -- expect 5 rows, all true
--
-- 2. Site-authored total:
--   SELECT count(*) FROM public.site_templates t,
--        jsonb_each(t.field_derivation_map->'site_fields') AS f(key, val)
--   WHERE t.template_key = 'trades-v1' AND val ? 'site_authored';
--   -- expect 13 with 095 applied (7 original + font_family + these 5),
--   --        12 without it
--
-- 3. theme_color and font_family were NOT disturbed:
--   SELECT field_derivation_map->'site_fields'->'theme_color'  AS theme_color,
--          field_derivation_map->'site_fields'->'font_family'  AS font_family
--   FROM public.site_templates WHERE template_key = 'trades-v1';
--   -- theme_color: {"note": "site skin token", "site_authored": true}
--   -- font_family: present only if 095 has been applied
--
-- 4. Derived count unchanged — nothing reclassified:
--   SELECT count(*) FROM public.site_templates t,
--        jsonb_each(t.field_derivation_map->'site_fields') AS f(key, val)
--   WHERE t.template_key = 'trades-v1' AND val ? 'derives_from';
--   -- expect 25
--
-- 5. The manager surfaces them WITHOUT a code change (the point of the map):
--   -- open /business/{slug}/marketing/custom-website -> Site settings
--   -- expect 13 inputs, incl. three colour pickers, a slider and a select
-- =====================================================================
