-- =====================================================================
-- Migration 057: content_types catalog table + social_post seed row
-- =====================================================================
-- RUN THIS FIRST. Apply and verify before running 057b.
--
-- This migration:
--   1. Creates the content_types catalog table (slug PK)
--   2. Seeds a 'social_post' row, resolving task_id by slug at runtime
--
-- AFTER applying, run the two verification SELECTs at the bottom.
-- ONLY when both pass: apply 057b_content_type_fk.sql.
--
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- =====================================================================

-- ── 1. Create content_types catalog table ────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.content_types (
  slug                 TEXT        PRIMARY KEY,
  task_id              UUID        REFERENCES public.tasks(id) ON DELETE SET NULL,
  label                TEXT        NOT NULL,
  preview_component    TEXT,
  suited_platforms     JSONB,
  token_cost           INTEGER,
  typical_gen_seconds  INTEGER,
  is_enabled           BOOLEAN     NOT NULL DEFAULT true,
  min_tier             TEXT,
  created_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- ── 2. Seed social_post kind ─────────────────────────────────────────────────
-- task_id resolved by slug so no UUID is hardcoded here.
-- ON CONFLICT DO NOTHING makes this re-runnable.

INSERT INTO public.content_types (
  slug,
  task_id,
  label,
  preview_component,
  suited_platforms,
  token_cost,
  typical_gen_seconds,
  is_enabled,
  min_tier
)
SELECT
  'social_post',
  t.id,
  'Social Post',
  'card-social-post',
  '["LinkedIn", "Twitter", "Instagram", "Facebook"]'::jsonb,
  1,
  15,
  true,
  'core_paid'
FROM public.tasks t
WHERE t.slug = 'generate-social-post'
ON CONFLICT (slug) DO NOTHING;

-- ── Verification (run before applying 057b) ───────────────────────────────────
-- SELECT slug, task_id IS NOT NULL AS has_task, label, is_enabled
-- FROM content_types;
-- Expect: exactly 1 row — social_post, has_task=true, is_enabled=true
--
-- SELECT DISTINCT content_type FROM content_assets;
-- Expect: 0 rows (table empty) OR only 'social_post' — no unknown values.
-- If any other value appears, backfill it to a slug in content_types
-- BEFORE applying 057b or the FK add will fail.
