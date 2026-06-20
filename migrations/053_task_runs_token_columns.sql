-- =====================================================================
-- Migration 053: token usage columns on task_runs
-- =====================================================================
-- Source: Agentscape Oracle TOKEN THROUGHPUT graph, 2026-06-18
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: uses IF NOT EXISTS.
-- =====================================================================

-- Captures the Anthropic SDK's usage.input_tokens / usage.output_tokens
-- accumulated across all LLM calls in a single task run.
-- Written by runTaskInBackground on successful completion only;
-- NULL on failed or cancelled runs.
ALTER TABLE public.task_runs
  ADD COLUMN IF NOT EXISTS input_tokens INTEGER;

ALTER TABLE public.task_runs
  ADD COLUMN IF NOT EXISTS output_tokens INTEGER;

-- ── Verification ──────────────────────────────────────────────────────────────
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'task_runs'
--     AND column_name IN ('input_tokens', 'output_tokens')
--   ORDER BY column_name;
--
-- SELECT id, task_id, input_tokens, output_tokens
--   FROM task_runs
--   WHERE is_harness = true
--   ORDER BY started_at DESC
--   LIMIT 10;
