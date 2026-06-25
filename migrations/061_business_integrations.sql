-- =====================================================================
-- Migration 061: business_integrations table
-- =====================================================================
-- Source: Zernio publish slice brief, 2026-06-24
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: uses IF NOT EXISTS / ON CONFLICT.
-- =====================================================================
-- Stores per-business third-party integration credentials and state.
-- Each row = one integration provider for one business.
-- Worker reads/writes via service-role (bypasses RLS).
-- Frontend reads via anon+JWT (RLS: owner-select only).
--
-- Zernio config shape (JSONB):
-- {
--   "profileId": "prof_abc123",
--   "accounts": [
--     {
--       "accountId": "acc_xyz789",
--       "platform": "bluesky",
--       "handle": "@handle.bsky.social",
--       "connectedAt": "2026-06-24T15:00:00Z"
--     }
--   ]
-- }
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.business_integrations (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  provider     TEXT        NOT NULL
                           CHECK (char_length(provider) > 0),
  config       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  is_active    BOOLEAN     NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, provider)
);

-- ── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_business_integrations_business_id
  ON public.business_integrations(business_id);

CREATE INDEX IF NOT EXISTS idx_business_integrations_provider
  ON public.business_integrations(provider);

-- ── Row-level security ────────────────────────────────────────────────────────
-- Owner can SELECT their own integration rows via businesses.user_id = auth.uid().
-- No direct INSERT/UPDATE from the frontend — all writes go through the Worker
-- (service-role key bypasses RLS).

ALTER TABLE public.business_integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_select_business_integrations"
  ON public.business_integrations
  FOR SELECT
  USING (
    business_id IN (
      SELECT id FROM public.businesses WHERE user_id = auth.uid()
    )
  );

-- ── Updated_at trigger ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER trg_business_integrations_updated_at
    BEFORE UPDATE ON public.business_integrations
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Verification ──────────────────────────────────────────────────────────────
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'business_integrations'
--   ORDER BY ordinal_position;
--
-- SELECT schemaname, tablename, policyname, cmd
--   FROM pg_policies
--   WHERE tablename = 'business_integrations';
--
-- SELECT indexname FROM pg_indexes
--   WHERE tablename = 'business_integrations';
