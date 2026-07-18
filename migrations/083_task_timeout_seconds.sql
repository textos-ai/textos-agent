-- =====================================================================
-- Migration 083: DB-driven per-task run timeouts
-- =====================================================================
-- Source: run-timeout-policy.md + run-limits-review.md (2026-07-05).
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS + a constraint guard.
--   NOTE: the backfill UPDATEs re-assert the policy tiers on every run.
--   If you hand-tune a task's timeout_seconds later, re-running this file
--   will reset it back to the policy value. Tune in the DB, not here.
-- =====================================================================
--
-- WHY: the run timeout used to be a hardcoded slug allowlist duplicated in
-- business-task-run.ts and heartbeatWatchdog.ts (60s default; 300s only for
-- generate-business-app% / public-business-website / customer-understanding).
-- The 60s default silently killed ideal-customer-profile-generator (~50-70s)
-- and orphaned >=6 documents (runs that finished after being swept). This
-- migration moves the budget into a column the runtime reads. Tier reasoning
-- and per-slug assignment live in docs/run-timeout-policy.md — that doc is the
-- source of the reasoning; this column is the source of the value.
--
-- Tiers: FAST=120 (one call, small output) | STANDARD=180 (one call,
-- multi-section document — the DEFAULT) | HEAVY=300 (chain / app-gen /
-- website / external fetch / image gen; 300 = the Worker cpu_ms ceiling).
-- =====================================================================

-- 1. Per-task budget. DEFAULT 180 encodes the new-task rule: any task created
--    without an explicit tier (incl. Generate-Prompt-unlocked tasks) gets a
--    sane STANDARD budget, never the old silent 60s.
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS timeout_seconds integer NOT NULL DEFAULT 180;

-- Sanity bound: never below a floor, never above the 300s Worker ceiling.
DO $$ BEGIN
  ALTER TABLE public.tasks
    ADD CONSTRAINT tasks_timeout_seconds_ck
    CHECK (timeout_seconds >= 30 AND timeout_seconds <= 300);
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- 2. Late-completion visibility. A run that finishes AFTER its sweep is
--    recovered to 'completed' (not orphaned); this flag makes the late finish
--    honest instead of silent.
ALTER TABLE public.task_runs
  ADD COLUMN IF NOT EXISTS finished_after_timeout boolean NOT NULL DEFAULT false;

-- 3. Backfill from the policy tiers. Anything not named here stays at the
--    STANDARD default (180) set by the column default above.

-- FAST (120) — one LLM call, small output.
UPDATE public.tasks SET timeout_seconds = 120
WHERE slug IN (
  'launch-tweet',
  'welcome-email',
  'find-a-unique-business-name',
  'keyword-generator',
  'elevator-pitch',
  'hook-generator',
  'negative-review-rebuttal',
  'personalized-pitch-email',
  'cold-email-outreach',
  'heros-and-eyebrows',
  'logo'
);

-- HEAVY (300) — multi-step chain / app-gen / website / external fetch / image.
-- Includes the three formerly-hardcoded long tasks.
UPDATE public.tasks SET timeout_seconds = 300
WHERE slug LIKE 'generate-business-app%'
   OR slug IN (
  'public-business-website',
  'customer-understanding',
  'bluesky-find-conversations',
  'match-verify-leads',
  'carousel-generator',
  'ai-voice-receptionist',
  'ad-manager',
  'onboarding'
);

-- 4. OPTIONAL — drop the dead is_long_running column.
--    It is never read in code, and where it was set it was wrong
--    (business-landing-page, a ~29s task, had it true; the actually-long
--    tasks did not). timeout_seconds fully replaces it. This DROP is
--    irreversible, so it is left commented — uncomment only if you want it
--    gone now. Leaving it in place is harmless (nothing reads it).
-- ALTER TABLE public.tasks DROP COLUMN IF EXISTS is_long_running;

-- =====================================================================
-- Verification (paste after applying)
-- =====================================================================
-- Column present + default:
--   SELECT column_name, data_type, column_default, is_nullable
--   FROM information_schema.columns
--   WHERE table_name='tasks' AND column_name='timeout_seconds';
--
-- Constraint present:
--   SELECT conname FROM pg_constraint WHERE conname='tasks_timeout_seconds_ck';
--
-- Tier distribution (expect 120 / 180 / 300 buckets, none outside 30..300):
--   SELECT timeout_seconds, count(*) FROM public.tasks
--   GROUP BY timeout_seconds ORDER BY timeout_seconds;
--
-- Spot-check the ones that mattered:
--   SELECT slug, timeout_seconds FROM public.tasks
--   WHERE slug IN ('ideal-customer-profile-generator','launch-tweet',
--                  'generate-business-app-html','customer-understanding')
--   ORDER BY slug;
--   -- expect: icp=180, launch-tweet=120, gen-app-html=300, cust-under=300
--
-- Late-completion flag present:
--   SELECT column_name, data_type, column_default
--   FROM information_schema.columns
--   WHERE table_name='task_runs' AND column_name='finished_after_timeout';
-- =====================================================================
