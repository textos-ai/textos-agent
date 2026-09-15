-- =====================================================================
-- Migration 124: auto-repair hero folder + theme (largest coldcall category)
-- =====================================================================
-- Source: "Auto repair trade folder" brief, 2026-08-28.
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: the re-point is an idempotent UPDATE; the theme uses
-- ON CONFLICT DO NOTHING.
--
-- 'auto repair' is the single largest coldcall_leads category (1,242 leads) and
-- currently resolves to the GENERIC hero set. Images + a compressed hero video
-- now live in R2 at demo-heroes/auto-repair/ (served from assets.victora.ai),
-- so point the category at its own folder and give the folder a two-colour theme.
--
-- coldcall_hero_map was seeded in migration 120 as ('auto repair','generic')
-- under ON CONFLICT (category) DO NOTHING, so re-pointing it is an UPDATE, not an
-- INSERT. coldcall_demo_theme is keyed on folder (migration 122).
-- =====================================================================

-- 1. Re-point the category to its own hero folder (was 'generic').
UPDATE public.coldcall_hero_map
   SET folder = 'auto-repair'
 WHERE category = 'auto repair';

-- 2. Theme the folder: gunmetal steel + auto red. Two colours only — hero glow,
--    buttons, monogram, icons, dividers and the CTA band all derive from
--    --primary / --accent at render time. Change either hex directly in this row
--    later; it's just data. DO NOTHING so a re-apply never clobbers a manual retint.
INSERT INTO public.coldcall_demo_theme (folder, primary_hex, accent_hex) VALUES
  ('auto-repair', '#22344A', '#E23B3B')
ON CONFLICT (folder) DO NOTHING;

-- == Verify (paste after applying) =============================================
-- Category resolves to its own folder — expect 'auto-repair':
--   SELECT folder FROM public.coldcall_hero_map WHERE category = 'auto repair';
--
-- Folder has a theme — expect one steel/red row:
--   SELECT folder, primary_hex, accent_hex
--     FROM public.coldcall_demo_theme WHERE folder = 'auto-repair';
--
-- Every hero-map folder still has a theme — expect 0 rows:
--   SELECT DISTINCT m.folder
--     FROM public.coldcall_hero_map m
--     LEFT JOIN public.coldcall_demo_theme t ON t.folder = m.folder
--    WHERE t.folder IS NULL;
--
-- Node probe (asserts both post-conditions) — expect row 124 -> APPLIED:
--   node scripts/migration-state.mjs
-- =====================================================================
