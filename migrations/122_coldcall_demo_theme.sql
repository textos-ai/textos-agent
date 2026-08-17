-- =====================================================================
-- Migration 122: per-trade colour theme for demo landing pages
-- =====================================================================
-- Source: "Cold-call demo landing page — styling pass" brief, 2026-08-16.
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: CREATE TABLE IF NOT EXISTS + ON CONFLICT DO NOTHING.
--
-- Keyed on FOLDER, not category. coldcall_hero_map already resolves the 53
-- categories down to 16 folders, so theming the folder means a plumber and a
-- plumbing-adjacent category that share a hero set also share a palette —
-- and adding a new trade means one row here, not 53.
--
-- Read at RENDER time from the demo's stored hero_folder, so re-theming an
-- existing demo is a page reload, not a regeneration.
--
-- Two colours only. Everything else in the design (hero glow, buttons,
-- monogram, icons, dividers, CTA band) derives from --primary / --accent, so
-- a trade is retinted by changing two hex values here.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.coldcall_demo_theme (
  folder      TEXT PRIMARY KEY,
  primary_hex TEXT NOT NULL,
  accent_hex  TEXT NOT NULL
);

INSERT INTO public.coldcall_demo_theme (folder, primary_hex, accent_hex) VALUES
  ('electrician',        '#2F6BFF', '#F6A821'),
  ('plumber',            '#0E7CC4', '#12B5A6'),
  ('roofing',            '#334155', '#EA6A25'),
  ('hvac',               '#0284C7', '#E24D4D'),
  ('landscaper',         '#2F8F3E', '#C9A227'),
  ('painter',            '#5A4CDB', '#F2653F'),
  ('tree-service',       '#1F7A46', '#A9702F'),
  ('fence',              '#5B7B93', '#B5773A'),
  ('pest-control',       '#0E9E8E', '#3F7D34'),
  ('general-contractor', '#C2560F', '#1E3A5F'),
  ('mover',              '#1E5FA8', '#F4A62A'),
  ('gutters',            '#2B7A9B', '#6B7280'),
  ('foundation-repair',  '#57534E', '#C2560F'),
  ('garage-door',        '#475569', '#D97706'),
  ('pressure-washer',    '#0891B2', '#22C55E'),
  -- generic is the documented fallback when a folder has no row of its own.
  -- The render resolves to THIS row explicitly rather than defaulting to a
  -- colour in code, so an unthemed folder is visibly generic, not invisibly
  -- hardcoded.
  ('generic',            '#1F4FD0', '#E0A32A')
ON CONFLICT (folder) DO NOTHING;

-- RLS deny-by-default, matching every other coldcall_* table. The Worker's
-- service-role key is the only reader; the public demo page gets its colours
-- through the Worker, never straight from the browser.
ALTER TABLE public.coldcall_demo_theme ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coldcall_demo_theme FROM anon, authenticated;

-- == Verify (paste after applying) =============================================
-- All 16 folders themed:
--   SELECT count(*) FROM public.coldcall_demo_theme;   -- expect 16
--
-- Every hero-map folder has a theme — expect 0 rows:
--   SELECT DISTINCT m.folder
--     FROM public.coldcall_hero_map m
--     LEFT JOIN public.coldcall_demo_theme t ON t.folder = m.folder
--    WHERE t.folder IS NULL;
--
-- Every colour is a valid 6-digit hex — expect 0 rows:
--   SELECT folder, primary_hex, accent_hex FROM public.coldcall_demo_theme
--    WHERE primary_hex !~* '^#[0-9a-f]{6}$' OR accent_hex !~* '^#[0-9a-f]{6}$';
--
-- No two trades share a primary (so demos are visibly different):
--   SELECT primary_hex, count(*) FROM public.coldcall_demo_theme
--    GROUP BY 1 HAVING count(*) > 1;
--
-- RLS on, zero policies:
--   SELECT tablename, rowsecurity FROM pg_tables
--    WHERE schemaname='public' AND tablename='coldcall_demo_theme';
