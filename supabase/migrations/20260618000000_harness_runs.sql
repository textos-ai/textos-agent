-- 20260618000000_harness_runs.sql
-- Async harness runner: one harness_runs row per test run; task_runs link
-- back via harness_run_id FK. Also adds per-run token columns to task_runs
-- so the throughput graph can be real data later (writing logic separate step).

-- 1. harness_runs: one row per full agent-test run
CREATE TABLE IF NOT EXISTS public.harness_runs (
  id           uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  status       text        NOT NULL DEFAULT 'running',  -- running | complete
  business_id  uuid        REFERENCES public.businesses(id) ON DELETE SET NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  task_count   integer     NOT NULL DEFAULT 0,
  metadata     jsonb
);

CREATE INDEX IF NOT EXISTS idx_harness_runs_started_at
  ON public.harness_runs (started_at DESC);

-- 2. Link task_runs to their harness run (nullable — existing rows unaffected)
ALTER TABLE public.task_runs
  ADD COLUMN IF NOT EXISTS harness_run_id uuid
    REFERENCES public.harness_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_task_runs_harness_run_id
  ON public.task_runs (harness_run_id)
  WHERE harness_run_id IS NOT NULL;

-- 3. Per-run token columns — columns exist now; values written in a later step
--    when generic-document-runner is updated to capture msg.usage.
ALTER TABLE public.task_runs
  ADD COLUMN IF NOT EXISTS input_tokens  integer,
  ADD COLUMN IF NOT EXISTS output_tokens integer;
