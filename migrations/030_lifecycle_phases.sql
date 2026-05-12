-- =====================================================================
-- Migration 030: Lifecycle phases + task architecture columns
-- =====================================================================
-- Adds:
--   lifecycle_phases           — 6-phase business lifecycle lookup table
--   tasks.lifecycle_phase_id   — FK to lifecycle_phases
--   tasks.is_regeneratable     — can the user re-run this task?
--   tasks.asset_user_editable  — can the user edit the output asset?
--   business_assets.is_editable — nullable flag on the asset itself
--   task_output_type 'video'   — new output type (image/image_set already in 024)
--
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- =====================================================================

-- ── New output type values ─────────────────────────────────────────────
-- 'image' and 'image_set' were added in migration 024 — these are no-ops
ALTER TYPE task_output_type ADD VALUE IF NOT EXISTS 'image';
ALTER TYPE task_output_type ADD VALUE IF NOT EXISTS 'image_set';
ALTER TYPE task_output_type ADD VALUE IF NOT EXISTS 'video';

-- ── lifecycle_phases lookup ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lifecycle_phases (
  id         UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       TEXT    UNIQUE NOT NULL,
  name       TEXT    NOT NULL,
  sort_order INTEGER NOT NULL
);

INSERT INTO public.lifecycle_phases (slug, name, sort_order) VALUES
  ('idea',                'Idea & Validation',   1),
  ('business-creation',   'Business Creation',   2),
  ('product-creation',    'Product Creation',    3),
  ('product-marketing',   'Product Marketing',   4),
  ('product-fulfillment', 'Product Fulfillment', 5),
  ('success-measurement', 'Success Measurement', 6)
ON CONFLICT (slug) DO NOTHING;

-- ── tasks: new columns ────────────────────────────────────────────────
ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS lifecycle_phase_id  UUID    REFERENCES public.lifecycle_phases(id),
  ADD COLUMN IF NOT EXISTS is_regeneratable    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS asset_user_editable BOOLEAN NOT NULL DEFAULT false;

-- ── business_assets: is_editable flag ────────────────────────────────
ALTER TABLE public.business_assets
  ADD COLUMN IF NOT EXISTS is_editable BOOLEAN;

-- ── Index ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_tasks_lifecycle_phase ON public.tasks(lifecycle_phase_id);

-- ── Verify ────────────────────────────────────────────────────────────
-- SELECT slug, name, sort_order FROM lifecycle_phases ORDER BY sort_order;
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'tasks'
--   AND column_name IN ('lifecycle_phase_id','is_regeneratable','asset_user_editable');
