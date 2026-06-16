-- =====================================================================
-- Migration 045: Tasks model cleanup (kind / output_type / lifecycle phases)
-- =====================================================================
-- Source: VICTORA Model Cleanup chapter Part A — recon-approved rulings A–E (2026-06-11)
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: enum->text conversions are no-ops once text; remaps use
--   WHERE clauses that match nothing on a second pass; canonical phases use
--   ON CONFLICT (slug) DO NOTHING; old-phase DELETE is slug-scoped.
--
-- WHAT THIS DOES
--   1. lifecycle_phases: six -> three canonical (foundation/launch/scale).
--      Remap every tasks.lifecycle_phase_id; point plan_phase rows at the
--      matching canonical phase by name; delete the old six.
--   2. tasks.kind: autonomous + guide + configured -> manual. Keep system.
--      'scheduled' stays a legal value (0 tasks use it now). enum -> text+CHECK.
--      Final set: manual, system, scheduled.
--   3. tasks.output_type: report + generated_site + dashboard_view -> document.
--      The 3 real config tools (ad-manager, ai-voice-receptionist,
--      carousel-generator) -> configured. enum -> text+CHECK.
--      Final set: document, configured, image, image_set, structured_data, video.
--   4. status is UNCHANGED (draft/active/deprecated). "deprecated = hidden"
--      is enforced in CODE (the customer fetch), not here.
--
-- DESTRUCTIVE (explicitly approved; zero real users):
--   * UPDATE all 51 tasks.kind  (autonomous/guide/configured -> manual)
--   * UPDATE tasks.output_type  (report/generated_site/dashboard_view -> document;
--                                3 config tools -> configured)
--   * UPDATE tasks.lifecycle_phase_id (six -> three; 8 NULLs stay NULL)
--   * UPDATE plan_phase.lifecycle_phase_id (Gaudet's 3 NULLs -> canonical by name)
--   * DELETE the 6 old lifecycle_phases rows
--   * ALTER tasks.kind / tasks.output_type from enum to text + CHECK
--     (old pg enum types task_kind / task_output_type are left orphaned/unused)
--
-- NOT IN THIS MIGRATION (Part B): is_default-free-regardless-of-token_cost.
--   Known case to address there: heros-and-eyebrows (is_default, token_cost 1).
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────
-- 1. Lifecycle phases: six -> three canonical
-- ─────────────────────────────────────────────────────────────────────
INSERT INTO public.lifecycle_phases (slug, name, sort_order) VALUES
  ('foundation', 'Foundation', 1),
  ('launch',     'Launch',     2),
  ('scale',      'Scale',      3)
ON CONFLICT (slug) DO NOTHING;

-- Remap tasks: idea + business-creation -> Foundation
UPDATE public.tasks SET lifecycle_phase_id = (SELECT id FROM public.lifecycle_phases WHERE slug = 'foundation')
WHERE lifecycle_phase_id IN (SELECT id FROM public.lifecycle_phases WHERE slug IN ('idea','business-creation'));

-- product-creation + product-marketing -> Launch
UPDATE public.tasks SET lifecycle_phase_id = (SELECT id FROM public.lifecycle_phases WHERE slug = 'launch')
WHERE lifecycle_phase_id IN (SELECT id FROM public.lifecycle_phases WHERE slug IN ('product-creation','product-marketing'));

-- product-fulfillment + success-measurement -> Scale
UPDATE public.tasks SET lifecycle_phase_id = (SELECT id FROM public.lifecycle_phases WHERE slug = 'scale')
WHERE lifecycle_phase_id IN (SELECT id FROM public.lifecycle_phases WHERE slug IN ('product-fulfillment','success-measurement'));
-- (tasks with lifecycle_phase_id IS NULL are intentionally left NULL.)

-- Point plan_phase rows at the matching canonical phase by name
-- (Gaudet's Foundation/Launch/Scale rows are currently NULL).
UPDATE public.plan_phase pp SET lifecycle_phase_id = lc.id
FROM public.lifecycle_phases lc
WHERE lower(pp.name) = lc.slug AND lc.slug IN ('foundation','launch','scale');

-- Retire the old six (now unreferenced by tasks/plan_phase).
DELETE FROM public.lifecycle_phases
WHERE slug IN ('idea','business-creation','product-creation','product-marketing','product-fulfillment','success-measurement');

-- ─────────────────────────────────────────────────────────────────────
-- 2. tasks.kind : enum -> text + CHECK ; autonomous/guide/configured -> manual
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.tasks ALTER COLUMN kind DROP DEFAULT;
ALTER TABLE public.tasks ALTER COLUMN kind TYPE text USING kind::text;
UPDATE public.tasks SET kind = 'manual' WHERE kind IN ('autonomous','guide','configured');
ALTER TABLE public.tasks ALTER COLUMN kind SET DEFAULT 'manual';
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_kind_check;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_kind_check
  CHECK (kind IN ('manual','system','scheduled'));

-- ─────────────────────────────────────────────────────────────────────
-- 3. tasks.output_type : enum -> text + CHECK
--    report/generated_site/dashboard_view -> document ;
--    3 config tools -> configured
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.tasks ALTER COLUMN output_type DROP DEFAULT;
ALTER TABLE public.tasks ALTER COLUMN output_type TYPE text USING output_type::text;
UPDATE public.tasks SET output_type = 'document'
  WHERE output_type IN ('report','generated_site','dashboard_view');
UPDATE public.tasks SET output_type = 'configured'
  WHERE slug IN ('ad-manager','ai-voice-receptionist','carousel-generator');
ALTER TABLE public.tasks ALTER COLUMN output_type SET DEFAULT 'document';
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_output_type_check;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_output_type_check
  CHECK (output_type IN ('document','configured','image','image_set','structured_data','video'));

-- =====================================================================
-- Verification (paste after applying — should match the new distributions)
-- =====================================================================
-- Lifecycle phases = exactly 3:
--   SELECT slug, name, sort_order FROM public.lifecycle_phases ORDER BY sort_order;
--   -- expect foundation/launch/scale
-- Tasks per canonical phase (expect Foundation 24, Launch 15, Scale 4, NULL 8):
--   SELECT lc.slug, count(*) FROM public.tasks t
--   LEFT JOIN public.lifecycle_phases lc ON lc.id = t.lifecycle_phase_id
--   GROUP BY lc.slug ORDER BY lc.slug;
-- kind distribution (expect manual 50, system 1, scheduled 0):
--   SELECT kind, count(*) FROM public.tasks GROUP BY kind ORDER BY kind;
-- output_type distribution (expect document 46, configured 3, structured_data 2):
--   SELECT output_type, count(*) FROM public.tasks GROUP BY output_type ORDER BY output_type;
-- configured tasks are the 3 real tools:
--   SELECT slug, output_type, config_page_path FROM public.tasks WHERE output_type='configured' ORDER BY slug;
-- CHECK constraints present:
--   SELECT conname FROM pg_constraint WHERE conrelid='public.tasks'::regclass
--     AND conname IN ('tasks_kind_check','tasks_output_type_check');
-- Gaudet plan_phase now linked:
--   SELECT pp.name, lc.slug FROM public.plan_phase pp
--   LEFT JOIN public.lifecycle_phases lc ON lc.id = pp.lifecycle_phase_id ORDER BY pp.sort_order;
-- status unchanged (draft 29, active 21, deprecated 1):
--   SELECT status, count(*) FROM public.tasks GROUP BY status ORDER BY status;
-- =====================================================================
