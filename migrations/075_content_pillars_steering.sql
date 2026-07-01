-- =====================================================================
-- Migration 075: Content Pillars - Stage 3 (generation steering)
-- =====================================================================
-- Wires pillars into generation:
--   1. content_assets.pillar_id  - stamp which pillar produced each post
--      (Stage 4 metrics read this). Nullable; null = the General default.
--   2. pillar_data_sources.source_doc_slug - maps a data_source to the doc
--      whose current task_run is loaded as source material (customer_understanding
--      -> the Customer Understanding doc; market_point_of_view -> Market Research).
--   3. pillar_templates.is_default + a seeded "General" pillar - the neutral,
--      draws-from-everything default that every business falls back to (reproduces
--      today's generation behavior). Excluded from the browsable library.
--   4. generate-social-post prompt v4 - adds the pillar steering directive
--      ({{pillar.intent}} = what the post is FOR, {{pillar.register}} = how it
--      sounds). Directive framing lives here in prompt_definitions, not in code.
--
-- Dollar-quoted + pure-ASCII (paste-safe). Idempotent / additive only.
-- Apply via: https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- =====================================================================

-- ── 1. content_assets.pillar_id (the stamp) ──────────────────────────────────
ALTER TABLE public.content_assets
  ADD COLUMN IF NOT EXISTS pillar_id UUID REFERENCES public.business_pillars(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_content_assets_pillar ON public.content_assets(pillar_id);

-- ── 2. pillar_data_sources.source_doc_slug (data_source -> which doc to load) ─
ALTER TABLE public.pillar_data_sources
  ADD COLUMN IF NOT EXISTS source_doc_slug TEXT;
UPDATE public.pillar_data_sources SET source_doc_slug = 'customer-understanding' WHERE slug = 'customer_understanding';
UPDATE public.pillar_data_sources SET source_doc_slug = 'market-research-report' WHERE slug = 'market_point_of_view';
-- product_knowledge + everything stay NULL (context-only; that material is already
-- in the prompt via ctx.*). Overridable by the user's source control regardless.

-- ── 3. pillar_templates.is_default + seed the General default ─────────────────
ALTER TABLE public.pillar_templates
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

INSERT INTO public.pillar_templates (method_id, name, intent, register, data_source, display_order, is_default)
SELECT m.id,
       $q$General$q$,
       $q$General-purpose posts that draw on the full picture of the business - no single angle, just clear, on-brand content.$q$,
       $q$Natural, balanced, on-brand$q$,
       'everything', 0, true
FROM public.pillar_methods m
WHERE m.slug = 'victora-core'
ON CONFLICT (method_id, name) DO UPDATE
  SET is_default = true, data_source = 'everything',
      intent = EXCLUDED.intent, register = EXCLUDED.register, display_order = 0;

-- ── 4. prompt_variables: register the pillar.* tokens ────────────────────────
INSERT INTO public.prompt_variables (name, description, source) VALUES
  ('pillar.name',     'The content pillar this post is written under (its name).',              'pillar.name'),
  ('pillar.intent',   'The pillar intent - what the post is FOR (its purpose and angle).',       'pillar.intent'),
  ('pillar.register', 'The pillar register - HOW the post is written (voice, tone, register).',  'pillar.register')
ON CONFLICT (name) DO NOTHING;

-- ── 5. generate-social-post prompt v4 (adds pillar steering) ─────────────────
UPDATE public.prompt_definitions SET is_active = false
  WHERE task_slug = 'generate-social-post' AND is_active = true;

INSERT INTO public.prompt_definitions (task_slug, version, system_prompt, user_prompt_template, is_active, change_note)
VALUES (
  'generate-social-post', 4,
  $sys$You are a social media copywriter specializing in authentic, platform-native content. Write posts that feel natural to the specific platform and drive genuine engagement. Every post is written under a CONTENT PILLAR that decides its angle and voice - honor it. Return ONLY valid JSON - no markdown fences, no commentary, no explanation before or after the JSON.$sys$,
  $tmpl$## Business
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
## Content Pillar - the angle and voice for THIS post
This post belongs to the "{{pillar.name}}" pillar.
- What it is FOR (write toward this purpose and angle): {{pillar.intent}}
- HOW to write it (voice, tone, register): {{pillar.register}}

The pillar must VISIBLY shape this post - not just its topic, but its angle and voice. The intent decides what the post highlights, argues, or centers on; the register decides how it sounds. A post under a different pillar should read noticeably differently. If a source document is provided above, mine it for specifics that serve THIS pillar's intent.

## Your Task
Write a social media post for **{{platform.name}}**.

Platform rules:
- Character limit: {{platform.char_limit}} characters - your post MUST be under this limit
- Write in the native tone and format of {{platform.name}}
- Do not write a generic announcement - make it feel like it belongs on {{platform.name}}, and like it belongs to the {{pillar.name}} pillar

Return ONLY this JSON object (no markdown, no fences, nothing before or after):
{"post":"...","hook":"...","cta":"...","character_count":0}

Fields:
- post: the complete post text, strictly under {{platform.char_limit}} characters
- hook: the opening line or first sentence that grabs attention
- cta: the call-to-action embedded in or closing the post
- character_count: exact character count of the post value$tmpl$,
  true,
  'Stage 3: pillar steering - intent + register directive; honors source doc for the pillar angle.'
);

-- ── Verify (paste after applying) ─────────────────────────────────────────────
-- SELECT slug, source_doc_slug FROM pillar_data_sources ORDER BY display_order;
-- SELECT name, is_default, data_source FROM pillar_templates WHERE is_default = true;
-- SELECT version, is_active FROM prompt_definitions WHERE task_slug='generate-social-post' ORDER BY version;
-- SELECT column_name FROM information_schema.columns WHERE table_name='content_assets' AND column_name='pillar_id';
