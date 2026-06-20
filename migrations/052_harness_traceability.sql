-- =====================================================================
-- Migration 052: harness traceability — is_harness + model columns
-- =====================================================================
-- Source: Oracle HUD harness reporting build, 2026-06-18
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: uses IF NOT EXISTS.
-- =====================================================================

-- task_runs.is_harness: marks rows created by the admin harness
-- (GET /admin/harness/run) so they are distinguishable from real
-- user-generated runs at query time.
ALTER TABLE public.task_runs
  ADD COLUMN IF NOT EXISTS is_harness BOOLEAN NOT NULL DEFAULT false;

-- task_runs.model: the LLM model ID that ran this task.
-- Written by runTaskInBackground on completion.
ALTER TABLE public.task_runs
  ADD COLUMN IF NOT EXISTS model TEXT;

-- business_assets.is_harness: propagated from the owning task_run so
-- harness-generated asset rows are filterable in business_assets queries.
-- Prevents harness output from polluting real-user asset history.
ALTER TABLE public.business_assets
  ADD COLUMN IF NOT EXISTS is_harness BOOLEAN NOT NULL DEFAULT false;

-- Indexes for the harness report pages (filter/sort on is_harness + started_at).
CREATE INDEX IF NOT EXISTS idx_task_runs_is_harness_started
  ON public.task_runs(started_at DESC)
  WHERE is_harness = true;

CREATE INDEX IF NOT EXISTS idx_task_runs_harness_run_id
  ON public.task_runs(harness_run_id)
  WHERE harness_run_id IS NOT NULL;

-- ── Verification ──────────────────────────────────────────────────────────────
-- SELECT column_name, data_type, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'task_runs'
--     AND column_name IN ('is_harness', 'model')
--   ORDER BY column_name;
--
-- SELECT column_name, data_type, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'business_assets'
--     AND column_name = 'is_harness';
--
-- SELECT COUNT(*) FROM task_runs WHERE is_harness = true; -- expect > 0 after first harness run
