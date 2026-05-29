-- Migration 040: append_to_work_log RPC function
-- Enables durable event logging to task_runs.work_log for paid tasks
--
-- Apply in: Supabase SQL editor (project: textos-agent-test)

-- RPC function to append events to task_runs.work_log JSONB array
-- Avoids read-modify-write race conditions by using atomic || concatenation
CREATE OR REPLACE FUNCTION append_to_work_log(
  p_run_id uuid,
  p_event jsonb
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER  -- Run with function owner's privileges (service role)
AS $$
  UPDATE task_runs
  SET work_log = COALESCE(work_log, '[]'::jsonb) || p_event
  WHERE id = p_run_id;
$$;

-- Grant execute to service role (used by Workers)
-- Note: Adjust role name if different in your Supabase project
GRANT EXECUTE ON FUNCTION append_to_work_log(uuid, jsonb) TO service_role;