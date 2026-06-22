-- =====================================================================
-- Migration 055: Seed generate-social-post task
-- =====================================================================
-- Prerequisites: migration 054 (content_assets table must exist)
--
-- This migration:
--   1. Adds 'marketing' to the task_area enum
--   2. Inserts the generate-social-post task row
--   3. Assigns lifecycle_phase_id = product-marketing
--   4. Binds the task to anthropic-claude-sonnet via task_apis
--   5. Seeds a dual-mode prompt_definition (context-only + source document)
--
-- The user_prompt_template uses {{source.block}} which renders to:
--   • A formatted source document block when sourceAsset is present
--   • Empty string when running in context-only mode
-- This allows a single prompt definition to serve both generation modes.
--
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
--
-- Safe to re-run: uses ADD VALUE IF NOT EXISTS, ON CONFLICT DO NOTHING,
--                 and explicit dedup on prompt_definitions.
-- =====================================================================

-- ── 1. Area enum: add 'marketing' ────────────────────────────────────────────
-- Discovery query if this fails (type name may differ):
--   SELECT pg_type.typname
--   FROM pg_attribute
--   JOIN pg_type ON pg_type.oid = pg_attribute.atttypid
--   WHERE pg_attribute.attrelid = 'public.tasks'::regclass
--     AND pg_attribute.attname = 'area';
-- Expected: task_area

ALTER TYPE task_area ADD VALUE IF NOT EXISTS 'marketing';

-- ── 2. Task row ───────────────────────────────────────────────────────────────

INSERT INTO public.tasks (
  slug,
  name,
  description_short,
  area,
  is_default,
  plan_required,
  visibility,
  price_cents,
  output_type,
  token_cost,
  kind,
  status,
  is_regeneratable,
  asset_user_editable,
  text_controllable,
  progress_verb,
  surface
)
VALUES (
  'generate-social-post',
  'Social Post',
  'Generate a social media post from your business context or a source document.',
  'marketing',
  false,
  'core_paid',
  'always_visible',
  0,
  'structured_data',
  1,
  'manual',
  'active',
  true,
  false,
  false,
  'Drafting post',
  'marketing'
)
ON CONFLICT (slug) DO NOTHING;

-- ── 3. lifecycle_phase_id → product-marketing ────────────────────────────────

-- product-marketing was deleted by migration 045 and merged into 'launch'.
UPDATE public.tasks t
SET lifecycle_phase_id = lp.id
FROM public.lifecycle_phases lp
WHERE lp.slug = 'launch'
  AND t.slug   = 'generate-social-post';

-- ── 4. task_apis: bind to anthropic-claude-sonnet ────────────────────────────

INSERT INTO public.task_apis (task_id, api_id, role)
SELECT t.id, a.id, 'primary'
FROM public.tasks t
CROSS JOIN public.external_apis a
WHERE t.slug = 'generate-social-post'
  AND a.slug = 'anthropic-claude-sonnet'
ON CONFLICT (task_id, api_id, role) DO NOTHING;

-- ── 5. prompt_definitions: dual-mode user template ───────────────────────────
-- Deactivate any pre-existing active row for this slug before inserting,
-- so the partial unique index (one active per slug) is never violated.

UPDATE public.prompt_definitions
SET is_active = false
WHERE task_slug = 'generate-social-post'
  AND is_active = true;

INSERT INTO public.prompt_definitions (
  task_slug,
  version,
  system_prompt,
  user_prompt_template,
  is_active
) VALUES (
  'generate-social-post',
  1,
  'You are a social media strategist for small businesses. You write concise, voice-authentic posts that hook readers immediately, deliver one clear idea, and end with a specific call to action. You adapt tone to the business''s stated brand voice. Return ONLY a valid JSON object matching the exact shape provided — no markdown fences, no explanation, no commentary.',
  E'{{source.block}}Business: {{business.name}}\nIndustry: {{ctx.industry}}\nBrand Voice: {{ctx.brand_voice}}\nValue Proposition: {{ctx.value_proposition}}\nTarget Customer: {{ctx.target_customer}}\nKey Differentiators: {{ctx.key_differentiators}}\nPositioning: {{ctx.positioning_statement}}\n\nWrite a social media post for this business. Return ONLY this JSON shape (no fences):\n{"post":"<full post text>","platform_hint":"<LinkedIn|Twitter|Instagram|Facebook>","hook":"<opening hook line>","cta":"<call to action>","character_count":<integer>}',
  true
);

-- ── Verification ──────────────────────────────────────────────────────────────
-- 1. Confirm enum value added
-- SELECT unnest(enum_range(NULL::task_area))::text ORDER BY 1;
-- Expect: includes 'marketing'

-- 2. Confirm task row
-- SELECT slug, area, kind, plan_required, token_cost, status, progress_verb
-- FROM tasks WHERE slug = 'generate-social-post';

-- 3. Confirm lifecycle assignment
-- SELECT t.slug, lp.slug AS phase
-- FROM tasks t JOIN lifecycle_phases lp ON lp.id = t.lifecycle_phase_id
-- WHERE t.slug = 'generate-social-post';
-- Expect: phase = product-marketing

-- 4. Confirm task_apis
-- SELECT t.slug, a.slug AS api, ta.role
-- FROM task_apis ta
-- JOIN tasks t ON t.id = ta.task_id
-- JOIN external_apis a ON a.id = ta.api_id
-- WHERE t.slug = 'generate-social-post';

-- 5. Confirm prompt_definitions
-- SELECT task_slug, version, is_active, LEFT(user_prompt_template, 60)
-- FROM prompt_definitions WHERE task_slug = 'generate-social-post';
