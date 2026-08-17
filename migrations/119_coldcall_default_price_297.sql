-- =====================================================================
-- Migration 119: coldcall_leads — default script price 279 -> 297
-- =====================================================================
-- Source: "change the default price to 297" brief, 2026-08-15.
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: SET DEFAULT is idempotent, and the backfill is scoped to
-- rows still holding the OLD default, so a second run matches nothing.
--
-- WHY A NEW MIGRATION RATHER THAN EDITING 117:
-- 117 is already applied. Changing its text would not alter the live column
-- default by one cent — it would only rewrite history and make the migration
-- log disagree with the database. 117 stays as the record of what was
-- actually applied; this file is the change.
--
-- THE BACKFILL IS DELIBERATELY NARROW:
--   WHERE script_price_monthly = 279
-- Only rows still sitting on the old default move. A lead priced by hand to
-- anything else is left exactly as the caller set it — re-pricing someone's
-- negotiated quote from under them is the one thing this must not do.
--
-- Known limitation, stated rather than hidden: a lead deliberately priced at
-- 279 by hand is indistinguishable from one that never moved, so it will be
-- swept to 297. At the time of writing no such lead exists (15,821 rows sit
-- on the default; 1 is hand-priced at 297 and is unaffected).
-- =====================================================================

-- 1. New rows get 297.
ALTER TABLE public.coldcall_leads
  ALTER COLUMN script_price_monthly SET DEFAULT 297;

-- 2. Existing rows still on the old default follow it. Hand-priced rows do not.
UPDATE public.coldcall_leads
   SET script_price_monthly = 297
 WHERE script_price_monthly = 279;

-- == Verify (paste after applying) =============================================
-- Column default is now 297:
--   SELECT column_default FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='coldcall_leads'
--      AND column_name='script_price_monthly';
--   Expect: 297
--
-- Nothing is left on the old default, and hand-priced rows survived:
--   SELECT script_price_monthly, count(*)
--     FROM public.coldcall_leads
--    GROUP BY 1 ORDER BY 2 DESC;
--   Expect: 297 -> 15822 (15,821 swept + the 1 already hand-set to 297),
--           and any other price a caller has since set, untouched.
--
-- The CHECK from 117 still guards the column:
--   SELECT pg_get_constraintdef(con.oid) FROM pg_constraint con
--     JOIN pg_class rel ON rel.oid = con.conrelid
--    WHERE rel.relname='coldcall_leads'
--      AND con.conname='coldcall_leads_script_price_chk';
