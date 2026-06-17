-- =====================================================================
-- Migration 051: task_trigger_blocks — attempt-cap guardrail
-- =====================================================================
-- Source: platform guardrail brief, 2026-06-17
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: uses IF NOT EXISTS / ON CONFLICT.
-- =====================================================================
--
-- Prevents a (business_id, task_id) from being triggered indefinitely
-- after repeated failures. After 2 failed task_runs (since last admin
-- clear), a block row is inserted; any subsequent trigger returns 429
-- until an admin sets cleared_at.
--
-- Worker reads/writes this table with the service-role key (bypasses
-- RLS). RLS is enabled so direct anon/jwt access is blocked by default.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.task_trigger_blocks (
  business_id  UUID        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  task_id      UUID        NOT NULL REFERENCES public.tasks(id)      ON DELETE CASCADE,
  blocked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_at   TIMESTAMPTZ,
  PRIMARY KEY (business_id, task_id)
);

-- Fast lookup at trigger time: "is this (business, task) actively blocked?"
CREATE INDEX IF NOT EXISTS idx_ttb_active
  ON public.task_trigger_blocks (business_id, task_id)
  WHERE cleared_at IS NULL;

-- RLS: enabled; service-role key bypasses it. No anon/jwt policies
-- (internal-only table — not exposed to frontend directly).
ALTER TABLE public.task_trigger_blocks ENABLE ROW LEVEL SECURITY;

-- ── Verification ──────────────────────────────────────────────────────
-- SELECT table_name, rowsecurity
--   FROM pg_tables
--   WHERE schemaname = 'public' AND table_name = 'task_trigger_blocks';
--
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'task_trigger_blocks'
--   ORDER BY ordinal_position;
--
-- SELECT indexname FROM pg_indexes
--   WHERE tablename = 'task_trigger_blocks';
