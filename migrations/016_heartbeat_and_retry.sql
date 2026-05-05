-- Migration 016: heartbeat + retry columns for build resilience
-- Phase 5 #13 — SSE disconnect / hard refresh recovery
--
-- free_build_runs.last_heartbeat_at:
--   Written by the orchestrator every 10 s while a build is running.
--   The watchdog cron marks any run stale if this stops updating for > 90 s.
--
-- task_runs.retry_count / max_retries:
--   retry_count incremented each time a failed task is re-queued via Resume Build.
--   max_retries caps how many times a build can be resumed (default 3).
--
-- Apply in: Supabase SQL Editor (project: textos-agent)

ALTER TABLE public.free_build_runs
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.task_runs
  ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_retries  INT NOT NULL DEFAULT 3;

-- Fast watchdog query: running builds with a stale heartbeat
CREATE INDEX IF NOT EXISTS idx_fbr_running_heartbeat
  ON public.free_build_runs (status, last_heartbeat_at)
  WHERE status = 'running';
