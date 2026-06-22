-- =====================================================================
-- Migration 054: content_assets table
-- =====================================================================
-- New table for marketing content lifecycle (social posts, emails, ads,
-- etc.). Separate from business_assets because:
--   • business_assets.asset_type has a CHECK constraint on a fixed set
--   • content_assets needs lifecycle state (draft/approved/scheduled/published/failed)
--   • content_assets can reference a source document (source_asset_id)
--     while business_assets has no such concept
--
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
--
-- Safe to re-run: uses IF NOT EXISTS / CREATE TABLE IF NOT EXISTS.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.content_assets (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  source_asset_id  UUID        REFERENCES public.business_assets(id) ON DELETE SET NULL,
  task_run_id      UUID        REFERENCES public.task_runs(id) ON DELETE SET NULL,
  content_type     TEXT        NOT NULL,       -- e.g. 'social_post', 'email', 'ad_copy'
  target_platform  TEXT,                        -- e.g. 'LinkedIn', 'Twitter', 'Instagram'
  generated_body   TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'draft'
                               CHECK (status IN ('draft','approved','scheduled','published','failed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_content_assets_business_id
  ON public.content_assets(business_id);

CREATE INDEX IF NOT EXISTS idx_content_assets_source_asset_id
  ON public.content_assets(source_asset_id);

CREATE INDEX IF NOT EXISTS idx_content_assets_business_status
  ON public.content_assets(business_id, status);

-- ── Row-level security ────────────────────────────────────────────────────────
-- Owner can SELECT their own content assets via businesses.user_id = auth.uid().
-- Worker uses service-role key and bypasses RLS; the business_id ownership
-- check is enforced in application code (business-task-run.ts).

ALTER TABLE public.content_assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_select_content_assets"
  ON public.content_assets
  FOR SELECT
  USING (
    business_id IN (
      SELECT id FROM public.businesses WHERE user_id = auth.uid()
    )
  );

-- ── Verification ──────────────────────────────────────────────────────────────
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'content_assets'
--   ORDER BY ordinal_position;
--
-- SELECT schemaname, tablename, policyname
--   FROM pg_policies
--   WHERE tablename = 'content_assets';
