-- =====================================================================
-- Migration 029: Admin task audit log
-- =====================================================================
-- Creates task_edits table to record every field-level change made via
-- the admin Task Manager. Append-only — never UPDATE rows.
--
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.task_edits (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    UUID        NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  edited_by  UUID        NOT NULL REFERENCES public.users(id),
  field_name TEXT        NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  edited_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_edits_task_id  ON public.task_edits(task_id);
CREATE INDEX IF NOT EXISTS idx_task_edits_edited_at ON public.task_edits(edited_at DESC);

-- ── Verify ────────────────────────────────────────────────────────────
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public' AND table_name = 'task_edits';
