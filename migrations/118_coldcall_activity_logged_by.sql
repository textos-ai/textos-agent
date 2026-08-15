-- =====================================================================
-- Migration 118: coldcall_call_activity — who typed the entry
-- =====================================================================
-- Source: "call logging in the lead modal" brief, 2026-08-15.
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
--
-- caller_id answers "whose call was this" and stays NOT NULL — every attempt
-- belongs to a real caller. This column answers a different question: "who
-- entered it". They are the same person when a caller logs their own call,
-- and differ when an admin logs one on someone's behalf from the lead modal.
--
-- NULLABLE ON PURPOSE, and null is the common case:
--   NULL  = the caller logged it themselves (caller_id is the typist)
--   set   = someone else entered it; this is who
-- Backfilling the existing rows would be a guess, so they stay NULL — which
-- reads correctly as "logged by the caller", the only behaviour that existed
-- before this migration.
--
-- ON DELETE SET NULL: losing the audit of who typed it is acceptable if a
-- user row is ever removed; losing the call record itself is not. Contrast
-- caller_id, which is RESTRICT precisely so history cannot be erased.
-- =====================================================================

ALTER TABLE public.coldcall_call_activity
  ADD COLUMN IF NOT EXISTS logged_by_user_id UUID
    REFERENCES public.users(id) ON DELETE SET NULL;

-- Partial: only the on-behalf-of rows are worth indexing, and they are rare.
CREATE INDEX IF NOT EXISTS coldcall_call_activity_logged_by
  ON public.coldcall_call_activity (logged_by_user_id)
  WHERE logged_by_user_id IS NOT NULL;

-- == Verify (paste after applying) =============================================
-- Column exists and is nullable:
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='coldcall_call_activity'
--      AND column_name='logged_by_user_id';
--   Expect: uuid / YES
--
-- FK behaviour (expect ON DELETE SET NULL on logged_by_user_id, and the
-- existing RESTRICT on caller_id / CASCADE on lead_id, unchanged):
--   SELECT con.conname, pg_get_constraintdef(con.oid)
--     FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
--    WHERE rel.relname='coldcall_call_activity' AND con.contype='f';
--
-- Existing rows untouched (every pre-118 row stays NULL = logged by caller):
--   SELECT count(*) FILTER (WHERE logged_by_user_id IS NULL)     AS by_caller,
--          count(*) FILTER (WHERE logged_by_user_id IS NOT NULL) AS on_behalf
--     FROM public.coldcall_call_activity;
