-- =====================================================================
-- Migration 069: content_assets — soft-delete column
-- =====================================================================
-- deleted_at NULL = active row (shown in queue)
-- deleted_at SET  = soft-deleted (excluded from queue, recoverable)
-- The list query filters .is("deleted_at", null); publish/hook routes
-- do not check deleted_at (published posts are already status=published,
-- which excludes them from the draft queue regardless).
-- =====================================================================

ALTER TABLE public.content_assets
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Partial index: only non-deleted rows — speeds up the list query filter
CREATE INDEX IF NOT EXISTS idx_content_assets_active
  ON public.content_assets(business_id, status, created_at DESC)
  WHERE deleted_at IS NULL;
