-- Migration 038: Add function to append events to task_runs.work_log
-- Enables paid tasks to save emit events for console display

CREATE OR REPLACE FUNCTION append_work_log_event(
  p_task_run_id UUID,
  p_event JSONB
)
RETURNS VOID AS $$
BEGIN
  UPDATE task_runs
  SET work_log = work_log || p_event::jsonb
  WHERE id = p_task_run_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;