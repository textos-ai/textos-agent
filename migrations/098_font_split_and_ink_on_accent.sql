-- =====================================================================
-- Migration 098: split display/body font, add optional ink_on_accent
-- =====================================================================
-- Source: WEBSITE MANAGER — 1D VISUAL FIDELITY PASS, parts C + D (2026-07-29).
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Requires: 092. SUPERSEDES 095 — see note below.
-- Safe to re-run: `||` merge with create_missing; no-op once all keys exist.
-- =====================================================================
--
-- WHY — FONT SPLIT (part D)
--
-- The mockup uses two faces doing two different jobs, declared in its own CSS:
--
--   @import ...family=Bebas+Neue&family=Inter:wght@300..700&family=Libre+Baskerville
--   --font-display: 'Bebas Neue', 'Anton', sans-serif;   /* headings, eyebrows */
--   --font-body:    'Inter', 'DM Sans', sans-serif;      /* everything else   */
--   --font-serif:   'Libre Baskerville', Georgia, serif; /* pull-quote only   */
--
-- Bebas Neue is a heavy condensed display face and does most of the visual work;
-- Inter is a normal-weight sans for reading. One `font_family` token cannot
-- express that — setting it to Bebas would render body copy in condensed caps.
--
-- So: display_font and body_font, both site-authored. --font-serif stays
-- STRUCTURAL: it appears in exactly one place (the positioning pull-quote) and
-- is part of the template's voice, not a per-client choice.
--
-- SUPERSEDES 095. 095 added `font_family`, which this replaces. It is harmless
-- if already applied — the key simply stops being read. If 095 has NOT been
-- applied, skip it; this migration is the one you want. Applying both in either
-- order is safe.
--
-- WHY — ink_on_accent (part C)
--
-- theme_color is currently #f9fde7 (near-white) and the primary button forced
-- color:#fff, giving 1.04:1 — an invisible CTA. The mockup hardcodes #0F1115 for
-- text on accent, which works for its orange and breaks for a dark accent.
--
-- The fix is DERIVATION, not a required token: the Worker computes the accent's
-- WCAG relative luminance where the per-client :root block is generated and
-- emits --site-ink-on-accent as near-black or near-white. This key exists only
-- as an OPTIONAL override for the rare case the derived value is not wanted.
-- Left unset — the normal case — the derived value applies.
-- =====================================================================

UPDATE public.site_templates
SET field_derivation_map = jsonb_set(
      field_derivation_map,
      '{site_fields}',
      (field_derivation_map->'site_fields')
        || jsonb_build_object(
             'display_font', jsonb_build_object(
               'site_authored', true,
               'note', 'heading/eyebrow face; closed list. Template default Bebas Neue.'),
             'body_font', jsonb_build_object(
               'site_authored', true,
               'note', 'reading face; closed list. Template default Inter.'),
             'ink_on_accent', jsonb_build_object(
               'site_authored', true,
               'note', 'OPTIONAL override. Left blank, the Worker derives near-black or near-white from the accent luminance so contrast always clears 4.5:1.')
           ),
      true    -- create_missing
    ),
    updated_at = now()
WHERE template_key = 'trades-v1'
  AND NOT (
        field_derivation_map->'site_fields' ? 'display_font'
    AND field_derivation_map->'site_fields' ? 'body_font'
    AND field_derivation_map->'site_fields' ? 'ink_on_accent'
  );


-- =====================================================================
-- Verification (paste after applying)
-- =====================================================================
--
-- 1. Three new keys present and site-authored:
--   SELECT key, val->>'site_authored' AS site_authored
--   FROM public.site_templates t,
--        jsonb_each(t.field_derivation_map->'site_fields') AS f(key, val)
--   WHERE t.template_key='trades-v1'
--     AND key IN ('display_font','body_font','ink_on_accent')
--   ORDER BY key;
--   -- expect 3 rows, all true
--
-- 2. Full site-authored list:
--   SELECT string_agg(key, ', ' ORDER BY key) AS site_authored
--   FROM public.site_templates t,
--        jsonb_each(t.field_derivation_map->'site_fields') AS f(key, val)
--   WHERE t.template_key='trades-v1' AND val ? 'site_authored';
--   -- with 096 + 098 (095 skipped): 15 keys —
--   --   body_font, booking_url, canonical_origin, display_font, home_base_area,
--   --   ink_on_accent, ink_on_dark, ink_on_light, price_range, radius_scale,
--   --   scrim_opacity, surface_color, tagline, theme_color, years_in_business
--   -- with 095 also applied: 16 (font_family, now unread)
--
-- 3. Derived count unchanged — nothing reclassified:
--   SELECT count(*) FROM public.site_templates t,
--        jsonb_each(t.field_derivation_map->'site_fields') AS f(key, val)
--   WHERE t.template_key='trades-v1' AND val ? 'derives_from';
--   -- expect 25
--
-- 4. The manager surfaces them with no code change (the point of the map):
--   -- open /business/{slug}/marketing/custom-website -> Site settings
--   -- expect two font selects and an ink_on_accent colour field marked optional
-- =====================================================================
