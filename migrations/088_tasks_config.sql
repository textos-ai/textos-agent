-- =====================================================================
-- Migration 088: tasks.config — tunable per-task settings (jsonb)
-- =====================================================================
-- Source: freshness/threshold config move (2026-07-18). Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: ADD COLUMN IF NOT EXISTS.
-- =====================================================================
--
-- WHY: the verify stage's freshness window and match threshold were hardcoded
-- constants (match-verify-leads.ts). Tuning them shouldn't need a deploy — they
-- belong in the DB. This adds a generic per-task config bag; the verify task
-- reads config.freshness_days / config.match_threshold, and the Leads
-- transparency panel reads the SAME values so the stated rules never drift from
-- the real gate.
--
-- After applying, seed the verify task (safe DML, run once):
--   UPDATE public.tasks
--     SET config = '{"freshness_days":180,"match_threshold":60}'::jsonb
--   WHERE slug = 'match-verify-leads';
-- =====================================================================

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb;

-- =====================================================================
-- Verification (paste after applying)
-- =====================================================================
--   SELECT slug, config FROM public.tasks WHERE slug = 'match-verify-leads';
--   -- expect: config = {"freshness_days":180,"match_threshold":60} after the seed
-- =====================================================================
