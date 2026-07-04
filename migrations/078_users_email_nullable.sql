-- =====================================================================
-- Migration 078: public.users.email nullable (anonymous sessions)
-- =====================================================================
-- Pre-signup flow Stage 1: a visitor gets a Supabase ANONYMOUS session that
-- owns a real business while they run the full build BEFORE registering. An
-- anonymous auth user has NO email until it converts to a permanent account on
-- register (Supabase updateUser keeps the SAME user id, so the business and all
-- built context are kept). To provision that anon user's public.users row, email
-- must be allowed NULL until conversion sets the real address.
--
-- Additive + safe: existing real users keep their emails; new real users still
-- get an email at /auth/callback (upsertUser). This only PERMITS null (for anon)
-- and does not change any existing row. Idempotent.
-- Apply via: https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- =====================================================================

ALTER TABLE public.users ALTER COLUMN email DROP NOT NULL;

-- ── Verify (paste after applying) ─────────────────────────────────────────────
-- SELECT is_nullable FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='users' AND column_name='email';
--   Expect: YES
