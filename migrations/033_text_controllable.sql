-- =====================================================================
-- Migration 033: tasks.text_controllable flag
-- =====================================================================
-- Marks tasks that can be triggered / configured via inbound text
-- (Telegram, SMS, etc.). V1: pure metadata. Surfaced in admin Task
-- Manager as a toggle so Rob can flag the text-controllable tasks now
-- without code changes. The Telegram bot consumer that filters tasks
-- on this flag ships in a later phase.
--
-- Default false — admin opt-in per task. Adding a partial index on
-- WHERE text_controllable = true keeps the index tiny (only flagged
-- tasks) while still answering "give me all text-controllable tasks"
-- in O(log n).
--
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- =====================================================================

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS text_controllable boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_tasks_text_controllable
  ON public.tasks(text_controllable)
  WHERE text_controllable = true;

-- Verify ───────────────────────────────────────────────────────────────
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'tasks' AND column_name = 'text_controllable';
--
-- SELECT slug, text_controllable
-- FROM public.tasks
-- WHERE text_controllable = true
-- ORDER BY slug;
