-- =====================================================================
-- Migration 035: businesses.is_active flag
-- =====================================================================
-- Adds a soft-delete / deactivation toggle to businesses. Existing rows
-- default to TRUE. Admin can flip to FALSE to hide a business from the
-- owning user's UI without destroying any data — token history,
-- subscriptions, business_context, etc. all stay intact.
--
-- All user-facing business queries gain .eq('is_active', true). Admin
-- queries DO NOT filter on this column so admins can see + reactivate
-- inactive businesses.
--
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- =====================================================================

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- Most reads filter active=true scoped to a user_id. Partial index keeps
-- it tiny — only active rows are indexed, which is the hot path.
CREATE INDEX IF NOT EXISTS idx_businesses_user_active
  ON public.businesses(user_id, is_active)
  WHERE is_active = true;

-- ── Verify ──
-- SELECT column_name, data_type, column_default, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'businesses' AND column_name = 'is_active';
--
-- SELECT COUNT(*) FROM public.businesses WHERE is_active = true;
-- SELECT COUNT(*) FROM public.businesses WHERE is_active = false;
