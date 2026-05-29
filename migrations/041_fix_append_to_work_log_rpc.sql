-- Migration 041: Fix append_to_work_log RPC
--
-- Migration 040 shipped with a broken body that concatenated p_event
-- directly with || (jsonb || jsonb requires both sides to be arrays).
-- This migration installs the corrected body which wraps the event in
-- a single-element array via jsonb_build_array before concatenation.
--
-- This file is a recovery commit: the corrected function was applied
-- directly to the test DB on 2026-05-28 (and labelled "041" in conver-
-- sation) but never saved to the repo. This file makes the repo match
-- the running test DB.
--
-- Source of truth: pg_get_functiondef(oid) from the test DB,
-- 2026-05-29. Replays cleanly even if 040's broken body is present.

CREATE OR REPLACE FUNCTION public.append_to_work_log(p_run_id uuid, p_event jsonb)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  UPDATE task_runs
  SET work_log = COALESCE(work_log, '[]'::jsonb) || jsonb_build_array(p_event)
  WHERE id = p_run_id;
$function$;
