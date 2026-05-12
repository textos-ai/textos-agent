-- =====================================================================
-- Migration 034: tasks.is_featured for dynamic marketing column
-- =====================================================================
-- Adds:
--   tasks.is_featured  boolean, default false
--
-- Purpose:
--   Builder Col 4 (Growth Marketing) renders a dynamic list of cards
--   filtered by: lifecycle_phase.slug='product-marketing' AND kind='configured'
--   AND status='active' AND is_featured=true ORDER BY execution_order.
--   Adding a new configured marketing task in admin and toggling
--   is_featured=true causes it to appear in the column with zero code deploy.
--
-- Only carousel-generator is seeded featured here. Cold Outreach and
-- Ad Spend tasks are created by admin via the UI after this phase ships.
--
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- =====================================================================

-- ── New column ────────────────────────────────────────────────────────────
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT false;

-- Partial index — only indexes the true rows; keeps the table scan cheap
-- for the default (false) majority.
CREATE INDEX IF NOT EXISTS idx_tasks_is_featured
  ON public.tasks(is_featured) WHERE is_featured = true;

-- ── Seed: carousel-generator is the first featured marketing task ─────────
UPDATE public.tasks SET is_featured = true
WHERE slug = 'carousel-generator';

-- ── Verify ────────────────────────────────────────────────────────────────
-- 1. Column exists with correct type and default
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'tasks' AND column_name = 'is_featured';
-- Expect: is_featured | boolean | false

-- 2. carousel-generator is featured, kind=configured, status=active
-- SELECT slug, is_featured, kind, status FROM tasks WHERE slug = 'carousel-generator';
-- Expect: is_featured=true | configured | active

-- 3. All other tasks are NOT featured (total rows minus 1)
-- SELECT COUNT(*) FROM tasks WHERE is_featured = false;
-- Expect: 33 (34 total tasks minus carousel-generator)
