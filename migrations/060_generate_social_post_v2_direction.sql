-- =====================================================================
-- Migration 060: generate-social-post prompt v2 — direction/angle steering
-- =====================================================================
-- Adds {{direction.block}} to the user_prompt_template so the handler
-- can inject optional steering at runtime.
--
-- direction.block is built by the handler from task_runs.config:
--   • config.angle    → "Angle: <chip text>"
--   • config.direction → "Direction: <free text>"
-- Both are optional; either or both may be present. When neither is
-- set, direction.block = "" and the template renders identically to v1
-- (the blank line between Positioning and the instruction is preserved).
--
-- This is a new prompt_definitions row (version 2). The v1 row is
-- deactivated. Safe to re-run: deactivation is idempotent; insert
-- is protected by the partial unique index (one is_active row per slug).
--
-- Apply:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- =====================================================================

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
  2,
  'You are a social media strategist for small businesses. You write concise, voice-authentic posts that hook readers immediately, deliver one clear idea, and end with a specific call to action. You adapt tone to the business''s stated brand voice. Return ONLY a valid JSON object matching the exact shape provided — no markdown fences, no explanation, no commentary.',
  E'{{source.block}}Business: {{business.name}}\nIndustry: {{ctx.industry}}\nBrand Voice: {{ctx.brand_voice}}\nValue Proposition: {{ctx.value_proposition}}\nTarget Customer: {{ctx.target_customer}}\nKey Differentiators: {{ctx.key_differentiators}}\nPositioning: {{ctx.positioning_statement}}\n{{direction.block}}\nWrite a social media post for this business. Return ONLY this JSON shape (no fences):\n{"post":"<full post text>","platform_hint":"<LinkedIn|Twitter|Instagram|Facebook>","hook":"<opening hook line>","cta":"<call to action>","character_count":<integer>}',
  true
);

-- =====================================================================
-- Verification
-- =====================================================================
-- SELECT task_slug, version, is_active, LEFT(user_prompt_template, 120)
-- FROM prompt_definitions
-- WHERE task_slug = 'generate-social-post'
-- ORDER BY version;
-- Expected: v1 is_active=false, v2 is_active=true
-- v2 template includes {{direction.block}} between Positioning and Write.
-- =====================================================================
