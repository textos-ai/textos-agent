-- Migration 022: Add 'logo' to business_assets.asset_type check constraint
--
-- Root cause: migration 008 defined asset_type CHECK without 'logo'.
-- The logo task (B.3) inserts asset_type='logo' which violates the constraint.
-- The SVG file lands in R2 cleanly; only the DB row fails.
--
-- Apply via: https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new

-- Step 1: drop the existing check constraint
ALTER TABLE public.business_assets
  DROP CONSTRAINT business_assets_asset_type_check;

-- Step 2: recreate with 'logo' added (all original values preserved)
ALTER TABLE public.business_assets
  ADD CONSTRAINT business_assets_asset_type_check
  CHECK (asset_type IN (
    'document', 'image', 'website', 'email', 'tweet',
    'lean_canvas', 'mission_dashboard', 'daycycle_locations',
    'logo'
  ));

-- ── Verify ────────────────────────────────────────────────────────────────────
-- SELECT conname, pg_get_constraintdef(oid) AS definition
-- FROM pg_constraint
-- WHERE conrelid = 'public.business_assets'::regclass
--   AND contype = 'c';
--
-- Expected: definition includes 'logo' in the IN list.
