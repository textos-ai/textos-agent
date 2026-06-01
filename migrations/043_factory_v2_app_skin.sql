-- =====================================================================
-- Migration 043: persisted Homer skin for the clean factory-v2 app
-- =====================================================================
-- Source: factory-v2 Phase 1 brief (2026-06-01) — "persist the random skin
--   ONCE and store it on the business's app metadata; same business → same
--   stored skin every render (not derived-from-name, not random per load)."
--
-- WHY A NEW OBJECT (verified against the live TEST DB 2026-06-01):
--   - app_configs has NO skin column ("column app_configs.skin does not exist")
--     and is keyed PER-APP (asset_id → business_assets.id). gaudet already has
--     ~18 asset_type='app' rows, so app_configs has no single row that means
--     "this business's factory-v2 strategy app skin."
--   - business_assets.metadata (JSONB) could hold a skin, but only on a
--     specific app-asset row; the clean factory-v2 /dev/ pipeline creates no
--     asset/config row of its own yet (it is pre-cutover, /dev/ only).
--   The clean pipeline is one strategy app PER BUSINESS, so the skin is a
--   per-business render setting. A small business-scoped table is the lightest
--   correct home with zero coupling to the per-asset app_configs model and no
--   overloading of the core `businesses` table.
--
-- ALTERNATIVE (Rob's call): if you'd rather the skin live with the per-app
--   render config, instead run `ALTER TABLE public.app_configs ADD COLUMN
--   IF NOT EXISTS skin text CHECK (...)` — but that requires the factory-v2 app
--   to first persist as a business_assets 'app' row + app_configs row, which
--   this /dev/ proof does not do. The table below needs no such row.
--
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: uses IF NOT EXISTS / CREATE OR REPLACE / guarded policy.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.factory_v2_app_skin (
  business_id  UUID PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  -- One of the six Homer skins (see public/homer/css/app.min.css [data-skin=…]).
  skin         TEXT NOT NULL CHECK (skin IN ('default','two','three','four','five','six')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: a business's skin is render metadata its owner may read (the frontend
-- reads with anon key + JWT). The Worker uses the service-role key and bypasses
-- RLS to upsert the once-picked skin.
ALTER TABLE public.factory_v2_app_skin ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Owners read own app skin"
    ON public.factory_v2_app_skin FOR SELECT
    USING (
      business_id IN (SELECT id FROM public.businesses WHERE user_id = auth.uid())
    );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- ── Verify (run after applying) ──────────────────────────────────────
-- Columns:  SELECT column_name, data_type, column_default
--           FROM information_schema.columns
--           WHERE table_name='factory_v2_app_skin' ORDER BY ordinal_position;
-- CHECK:    SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--           WHERE conrelid='public.factory_v2_app_skin'::regclass;
-- RLS:      SELECT tablename, rowsecurity FROM pg_tables
--           WHERE schemaname='public' AND tablename='factory_v2_app_skin';
-- Policy:   SELECT polname FROM pg_policy
--           WHERE polrelid='public.factory_v2_app_skin'::regclass;
