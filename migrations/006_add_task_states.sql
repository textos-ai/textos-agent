-- Sprint 5 Phase 1: Task state model
-- Extends task_runs with state enum, phase timestamps, and work_log
--
-- Schema notes (verified against initial_schema.sql):
--   * task_runs.status is task_run_status enum: queued/running/completed/failed — unchanged
--   * task_runs.started_at and completed_at already exist — ADD IF NOT EXISTS skips them
--   * task_runs.error already exists — no new error_message column added (use existing)
--   * 'locked' tasks have NO task_runs rows (status is synthesized in the API layer)
--     so there is nothing to backfill for locked/paid tasks
--
-- Apply via: https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new

-- ── 1. Create task_state enum ─────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE task_state AS ENUM ('proposed', 'running', 'complete', 'failed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ── 2. Add state column to task_runs ─────────────────────────────────────────
ALTER TABLE task_runs
  ADD COLUMN IF NOT EXISTS state task_state NOT NULL DEFAULT 'proposed';

-- ── 3. Add timestamp columns for state transitions ────────────────────────────
-- Note: started_at and completed_at already exist; ADD IF NOT EXISTS is a no-op for them.
ALTER TABLE task_runs
  ADD COLUMN IF NOT EXISTS proposed_at  TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS started_at   TIMESTAMPTZ,   -- already exists, skipped
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,   -- already exists, skipped
  ADD COLUMN IF NOT EXISTS failed_at    TIMESTAMPTZ;

-- ── 4. Add work_log JSONB for per-task agent activity log ─────────────────────
ALTER TABLE task_runs
  ADD COLUMN IF NOT EXISTS work_log JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ── 5. Backfill BeatPilot's 9 completed task_runs ────────────────────────────
UPDATE task_runs
SET state         = 'complete',
    proposed_at   = COALESCE(started_at, created_at, NOW()),
    failed_at     = NULL
WHERE status = 'completed';

-- Queued task_runs (free tasks awaiting execution) stay at default 'proposed'
UPDATE task_runs
SET state       = 'proposed',
    proposed_at = COALESCE(started_at, created_at, NOW())
WHERE status = 'queued';

-- Running tasks
UPDATE task_runs
SET state = 'running'
WHERE status = 'running';

-- Failed tasks
UPDATE task_runs
SET state     = 'failed',
    failed_at = COALESCE(completed_at, updated_at, NOW())
WHERE status = 'failed';

-- ── 6. Indexes for state-based filtering ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_task_runs_business_state
  ON task_runs(business_id, state);

CREATE INDEX IF NOT EXISTS idx_task_runs_state_completed
  ON task_runs(state, completed_at DESC)
  WHERE state = 'complete';

-- ── Verify (run after applying) ───────────────────────────────────────────────
-- SELECT state, COUNT(*) FROM task_runs GROUP BY state;
-- Expected: complete=9 for BeatPilot (or more if additional test data exists)
