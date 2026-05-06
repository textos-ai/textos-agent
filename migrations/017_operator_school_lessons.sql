-- Operator School V1 — extend lessons table
-- Adds task binding, sort order, tier gating, action prompt, read-time
-- hint, and slug for URL routing.
-- Existing 12 Manager V1 rows (phase/lesson_num keyed, no task_slug)
-- are untouched. Operator School queries filter via WHERE task_slug IS NOT NULL.

ALTER TABLE lessons
  ADD COLUMN IF NOT EXISTS task_slug      text,
  ADD COLUMN IF NOT EXISTS sort_order     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tier           text    NOT NULL DEFAULT 'free'
    CHECK (tier IN ('free', 'paid')),
  ADD COLUMN IF NOT EXISTS action_prompt  text,
  ADD COLUMN IF NOT EXISTS min_minutes    integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS slug           text;

-- Fast task → lessons lookup (Operator School reading view)
CREATE INDEX IF NOT EXISTS lessons_task_idx
  ON lessons (task_slug, sort_order);

-- Slug-based routing: /operator-school/{task_slug}/{slug}
CREATE INDEX IF NOT EXISTS lessons_slug_idx
  ON lessons (slug);
