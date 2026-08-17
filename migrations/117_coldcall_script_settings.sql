-- =====================================================================
-- Migration 117: coldcall_leads — per-lead script settings
-- =====================================================================
-- Source: "editable settings row on the lead modal" brief, 2026-08-15.
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: ADD COLUMN IF NOT EXISTS + guarded CHECK constraint.
--
-- The price and service toggles a caller's script is generated from. Stored
-- PER LEAD so a client quoted differently keeps that quote, and the script
-- reads the right number without anyone editing script text.
--
-- NOT NULL WITH A DEFAULT — deliberately different from migration 116.
-- Every enrichment column there is nullable because NULL carries meaning:
-- "we did not look". These four are settings, not observations. They always
-- have a value, the defaults are the business defaults ($279/mo, all three
-- services), and a NULL price would give a caller nothing to read off the
-- screen mid-call. Do not "harmonize" these to nullable.
--
-- Postgres 11+ adds a NOT NULL column with a constant default without
-- rewriting the table, so this is cheap across all 15,822 rows.
--
-- SUPERSEDED IN PART: migration 119 changes this default from 279 to 297
-- and sweeps the rows still holding 279. This file is left as the record
-- of what was actually applied; do not edit the value below.
-- =====================================================================

ALTER TABLE public.coldcall_leads
  -- Dollars per month. numeric(10,2) so a quote like 279.50 survives; no
  -- floating-point drift on a number a caller reads out loud.
  ADD COLUMN IF NOT EXISTS script_price_monthly NUMERIC(10,2) NOT NULL DEFAULT 279,
  ADD COLUMN IF NOT EXISTS svc_website          BOOLEAN       NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS svc_ai_automation    BOOLEAN       NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS svc_fb_ads           BOOLEAN       NOT NULL DEFAULT true;

-- A negative price is always a mistake, and a zero price would read as a
-- free offer on a live call. Reject both at the DB rather than trusting the
-- input to be sane.
DO $$ BEGIN
  ALTER TABLE public.coldcall_leads
    ADD CONSTRAINT coldcall_leads_script_price_chk
    CHECK (script_price_monthly > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- == Verify (paste after applying) =============================================
-- Columns, defaults, and NOT NULL:
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='coldcall_leads'
--      AND column_name IN ('script_price_monthly','svc_website',
--                          'svc_ai_automation','svc_fb_ads');
--
-- Every existing row picked up the defaults (expect 15822 / 0):
--   SELECT count(*) FILTER (WHERE script_price_monthly = 279
--                             AND svc_website AND svc_ai_automation AND svc_fb_ads) AS at_default,
--          count(*) FILTER (WHERE script_price_monthly IS NULL)                     AS null_price
--     FROM public.coldcall_leads;
--
-- CHECK constraint:
--   SELECT con.conname, pg_get_constraintdef(con.oid)
--     FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
--    WHERE rel.relname='coldcall_leads' AND con.conname='coldcall_leads_script_price_chk';
