-- =====================================================================
-- Migration 048: Document lock / finalize columns on business_assets
-- =====================================================================
-- Adds is_locked (finalise flag) and locked_at (timestamp) to
-- business_assets. Used by the document edit + lock feature:
--   - is_locked = true  → document is finalized; editing is disabled
--   - locked_at         → when the lock was applied (display only)
--   - asset_text        → already exists; used to store the user's
--                         edited HTML override for document assets
--
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS.
-- Apply via Supabase dashboard SQL editor.
-- =====================================================================

ALTER TABLE public.business_assets
  ADD COLUMN IF NOT EXISTS is_locked  BOOLEAN      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS locked_at  TIMESTAMPTZ;

-- =====================================================================
-- Verification
-- =====================================================================
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'business_assets'
--   AND column_name IN ('is_locked', 'locked_at', 'asset_text')
-- ORDER BY column_name;
-- =====================================================================
