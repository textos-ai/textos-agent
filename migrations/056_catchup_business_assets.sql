-- =====================================================================
-- Migration 056: Catch-up drift — business_assets untracked columns + constraint
-- =====================================================================
-- Source of truth: C:\code\textos-agent\db_schema\schema_columns.csv
--   app_slug at ordinal 14, app_icon at ordinal 15 — already in live DB
-- Source of truth: schema_check_constraints.csv
--   live CHECK already includes 'app' and 'app_draft'
--
-- This migration is PURELY DOCUMENTARY — it makes the migration history
-- match the live DB state. All statements are idempotent (IF NOT EXISTS /
-- IF EXISTS guards). Safe to apply to a DB where these already exist.
--
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- =====================================================================

-- ── 1. Untracked columns ─────────────────────────────────────────────────────

ALTER TABLE public.business_assets
  ADD COLUMN IF NOT EXISTS app_slug TEXT,
  ADD COLUMN IF NOT EXISTS app_icon TEXT;

-- ── 2. Expand asset_type CHECK to match live DB ──────────────────────────────
-- Live constraint already allows 'app' and 'app_draft'. DROP + recreate is
-- safe because the new CHECK is identical to what is already live. The pair
-- runs inside an implicit transaction in Supabase's SQL editor; if ADD fails,
-- DROP rolls back.

ALTER TABLE public.business_assets
  DROP CONSTRAINT IF EXISTS business_assets_asset_type_check;

ALTER TABLE public.business_assets
  ADD CONSTRAINT business_assets_asset_type_check
  CHECK (asset_type IN (
    'document', 'image', 'website', 'email', 'tweet',
    'lean_canvas', 'mission_dashboard', 'daycycle_locations',
    'logo', 'app', 'app_draft'
  ));

-- ── 3. Partial unique index: one 'app' row per slug per business ──────────────
-- Used by generate-business-app-html + generate-business-app-v2 for slug dedup.
-- Index not found in schema_foreign_keys.csv → confirmed untracked.

CREATE UNIQUE INDEX IF NOT EXISTS idx_business_assets_app_slug
  ON public.business_assets(business_id, app_slug)
  WHERE asset_type = 'app';

-- ── Verification ──────────────────────────────────────────────────────────────
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'business_assets' AND column_name IN ('app_slug','app_icon');
-- Expect: 2 rows
--
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint
-- WHERE conrelid = 'public.business_assets'::regclass
--   AND conname = 'business_assets_asset_type_check';
-- Expect: definition containing 'app' and 'app_draft'
--
-- SELECT indexname FROM pg_indexes
-- WHERE tablename = 'business_assets' AND indexname = 'idx_business_assets_app_slug';
-- Expect: 1 row
