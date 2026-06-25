-- =====================================================================
-- Migration 062: add publish-tracking columns to content_assets
-- =====================================================================
-- Source: Zernio publish slice brief, 2026-06-24
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: ADD COLUMN IF NOT EXISTS is idempotent.
-- =====================================================================
-- zernio_post_id: the _id returned by Zernio POST /posts — keyed for
--   per-post analytics lookups later. NULL until successfully published.
-- published_at:   timestamp when status flipped to 'published'.
--   NULL until published. Separate from created_at (when draft was made).
-- =====================================================================

ALTER TABLE public.content_assets
  ADD COLUMN IF NOT EXISTS zernio_post_id TEXT,
  ADD COLUMN IF NOT EXISTS published_at   TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_content_assets_zernio_post_id
  ON public.content_assets(zernio_post_id)
  WHERE zernio_post_id IS NOT NULL;

-- ── Verification ──────────────────────────────────────────────────────────────
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'content_assets'
--     AND column_name IN ('zernio_post_id', 'published_at');
--
-- Expected:
--   zernio_post_id | text      | YES
--   published_at   | timestamp | YES
