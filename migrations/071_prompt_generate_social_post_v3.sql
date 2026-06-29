-- Migration 068: Prompt v3 for generate-social-post
-- Replaces v2 (hardcoded platform_hint enum) with per-platform generation.
-- New template injects {{platform.name}} and {{platform.char_limit}} at runtime
-- so the LLM writes natively for each connected platform.
-- Output schema drops platform_hint — target_platform is set from data, not LLM output.

BEGIN;

-- Deactivate all previous versions
UPDATE prompt_definitions
SET is_active = false
WHERE task_slug = 'generate-social-post';

-- Insert v3
INSERT INTO prompt_definitions (
  task_slug,
  version,
  is_active,
  system_prompt,
  user_prompt_template
) VALUES (
  'generate-social-post',
  3,
  true,
  $$You are a social media copywriter specializing in authentic, platform-native content. Write posts that feel natural to the specific platform and drive genuine engagement. Return ONLY valid JSON — no markdown fences, no commentary, no explanation before or after the JSON.$$,
  $$## Business
Name: {{business.name}}
Summary: {{ctx.business_summary}}
Industry: {{ctx.industry}}

## Target Audience
{{ctx.target_customer}}

## Strategic Context
Value proposition: {{ctx.value_proposition}}
Brand voice: {{ctx.brand_voice}}
Key differentiators: {{ctx.key_differentiators}}

{{source.block}}{{direction.block}}

## Your Task
Write a social media post for **{{platform.name}}**.

Platform rules:
- Character limit: {{platform.char_limit}} characters — your post MUST be under this limit
- Write in the native tone and format of {{platform.name}}
- Do not write a generic announcement — make it feel like it belongs on {{platform.name}}

Return ONLY this JSON object (no markdown, no fences, nothing before or after):
{"post":"...","hook":"...","cta":"...","character_count":0}

Fields:
- post: the complete post text, strictly under {{platform.char_limit}} characters
- hook: the opening line or first sentence that grabs attention
- cta: the call-to-action embedded in or closing the post
- character_count: exact character count of the post value$$
);

COMMIT;
