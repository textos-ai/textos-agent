-- =====================================================================
-- Migration 138: email_queue.from_email default -> hello@victora.ai
-- =====================================================================
-- Source: "remove every Victora dependency on textos.ai" brief, 2026-11-10.
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: ALTER COLUMN ... SET DEFAULT is idempotent.
--
-- ── WHY ──────────────────────────────────────────────────────────────
-- 007_email_queue.sql set DEFAULT 'yourbusiness@textos.ai'. Both writers
-- (cold-email-outreach, personalized-pitch-email via queueColdEmail) omit
-- from_email and rely on this default, so dropping it would make those
-- inserts fail on NOT NULL. hello@victora.ai is the sender welcome-email
-- and users.ts already use. Existing rows are handled in migration 139.
-- =====================================================================

ALTER TABLE public.email_queue
  ALTER COLUMN from_email SET DEFAULT 'hello@victora.ai';

-- Verification:
-- SELECT column_name, column_default
--   FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='email_queue' AND column_name='from_email';
--   -> 'hello@victora.ai'::text
