-- =====================================================================
-- Migration 057b: Tighten content_assets.content_type → FK → content_types.slug
-- =====================================================================
-- PREREQUISITE: 057_content_types.sql must be applied AND verified first.
--
-- Pre-flight checklist before running:
--   1. content_types table exists with a 'social_post' row
--      SELECT slug FROM content_types;
--   2. Every content_assets row has a content_type value that exists in content_types
--      SELECT DISTINCT content_type FROM content_assets
--      WHERE content_type NOT IN (SELECT slug FROM content_types);
--      Expect: 0 rows. If any rows appear, they must be fixed first.
--
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- =====================================================================

ALTER TABLE public.content_assets
  ADD CONSTRAINT content_assets_content_type_fkey
  FOREIGN KEY (content_type) REFERENCES public.content_types(slug)
  ON DELETE RESTRICT;

-- ── Verification ──────────────────────────────────────────────────────────────
-- SELECT conname FROM pg_constraint
-- WHERE conrelid = 'public.content_assets'::regclass
--   AND conname = 'content_assets_content_type_fkey';
-- Expect: 1 row
