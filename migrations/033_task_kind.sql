-- =====================================================================
-- Migration 033: Task kind architecture
-- =====================================================================
-- Adds:
--   task_kind enum  — autonomous | configured | guide | system
--   tasks.kind      — what kind of task it is; default 'autonomous'
--   tasks.config_page_path — navigation URL for kind='configured' tasks;
--                            {slug} is interpolated at builder runtime
--
-- Categorization (33 tasks total):
--   autonomous  — 27 tasks (covered by column default; no UPDATEs needed)
--   configured  —  1 task  (carousel-generator → /business/{slug}/marketing/stories)
--   guide       —  4 tasks (banking, llc, daycycle, stripe-connect — all status=draft)
--   system      —  1 task  (task-queue-built — pipeline marker, hidden from catalog)
--
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- =====================================================================

-- ── Enum ──────────────────────────────────────────────────────────────────
CREATE TYPE task_kind AS ENUM ('autonomous', 'configured', 'guide', 'system');

-- ── New columns ───────────────────────────────────────────────────────────
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS kind             task_kind NOT NULL DEFAULT 'autonomous',
  ADD COLUMN IF NOT EXISTS config_page_path TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_kind ON public.tasks(kind);

-- ── Configured: carousel-generator ───────────────────────────────────────
-- Flip to active so it appears in the task catalog.
-- config_page_path uses {slug} placeholder; builder interpolates at runtime.
UPDATE public.tasks SET
  kind             = 'configured',
  config_page_path = '/business/{slug}/marketing/stories',
  status           = 'active'
WHERE slug = 'carousel-generator';

-- ── Guide: invisible at launch, content authored V1.1 ────────────────────
-- stripe-connect-setup deferred to V1.1 (Stripe Connect onboarding page
-- does not exist yet). banking/llc/daycycle guide content also V1.1.
UPDATE public.tasks SET
  kind   = 'guide',
  status = 'draft'
WHERE slug IN (
  'banking-setup-guide',
  'llc-ccorp-registration',
  'daycycle-connect',
  'stripe-connect-setup'
);

-- ── System: internal pipeline marker, hidden from catalog ────────────────
UPDATE public.tasks SET
  kind = 'system'
WHERE slug = 'task-queue-built';

-- All remaining 27 tasks retain kind='autonomous' via the column default.

-- ── Verify ────────────────────────────────────────────────────────────────
-- 1. Confirm enum values (expect 4 rows)
-- SELECT unnest(enum_range(NULL::task_kind))::text AS kind;

-- 2. Count by kind (expect: autonomous=27, configured=1, guide=4, system=1)
-- SELECT kind, COUNT(*) FROM tasks GROUP BY kind ORDER BY kind;

-- 3. Confirm configured task has path set
-- SELECT slug, kind, config_page_path, status FROM tasks WHERE kind = 'configured';
-- Expect: carousel-generator | configured | /business/{slug}/marketing/stories | active

-- 4. Confirm guide tasks all draft
-- SELECT slug, kind, status FROM tasks WHERE kind = 'guide' ORDER BY slug;
-- Expect 4 rows, all status=draft

-- 5. Confirm system task
-- SELECT slug, kind FROM tasks WHERE kind = 'system';
-- Expect: task-queue-built
