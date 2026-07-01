-- =====================================================================
-- Migration 077: Pillar VALUE vs PROMOTIONAL mode + prompt v6
-- =====================================================================
-- v5 proved the methods steer, but every post resolved into a business pitch
-- because the business sat in the prompt as raw material. Fix: each pillar has a
-- MODE. VALUE mode removes business/company context entirely and delivers a hard
-- reader-truth with ZERO business mention; PROMOTIONAL keeps v5 behavior.
--   - pillar_templates.mode / business_pillars.mode (text, default 'value',
--     'value' | 'promotional'; copied on adopt; backfilled for existing rows).
--   - Seed: VALUE = the 5 Wiebe moves + 6 Core (Customer Problems, Building in
--     Public, Education/How-To, Behind the Scenes, Industry Takes, Founder Story);
--     PROMOTIONAL = Social Proof, Announcements, and the General default.
--   - prompt v6: mode-aware ({{mode.directive}} + {{context.block}} composed by
--     the handler; method body still LEADS in both modes).
--
-- Dollar-quoted + pure ASCII (paste-safe). Additive / idempotent.
-- Apply via: https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- =====================================================================

-- NOTE: the column is named pillar_mode, NOT mode. A bare column called "mode"
-- collides with Postgres's mode() ordered-set aggregate and makes PostgREST /
-- supabase-js reject any select or filter that names it (HTTP 400
-- "WITHIN GROUP is required for ordered-set aggregate mode"). pillar_mode is
-- exposed to the app as "mode" via a select alias (mode:pillar_mode).
ALTER TABLE public.pillar_templates
  ADD COLUMN IF NOT EXISTS pillar_mode TEXT NOT NULL DEFAULT 'value'
    CHECK (pillar_mode IN ('value','promotional'));
ALTER TABLE public.business_pillars
  ADD COLUMN IF NOT EXISTS pillar_mode TEXT NOT NULL DEFAULT 'value'
    CHECK (pillar_mode IN ('value','promotional'));

-- ── Seed modes ───────────────────────────────────────────────────────────────
-- Default is 'value' (covers the 11 value pillars). Flip the 2 promotional Core
-- pillars + the General default to 'promotional'.
UPDATE public.pillar_templates t SET pillar_mode = 'promotional'
FROM public.pillar_methods m
WHERE t.method_id = m.id AND m.slug = 'victora-core'
  AND t.name IN ('Social Proof','Announcements');

UPDATE public.pillar_templates SET pillar_mode = 'promotional' WHERE is_default = true;

-- Backfill existing adopted business_pillars from their source template.
UPDATE public.business_pillars bp SET pillar_mode = t.pillar_mode
FROM public.pillar_templates t
WHERE bp.source_template_id = t.id AND bp.pillar_mode IS DISTINCT FROM t.pillar_mode;

-- ── prompt_variables ─────────────────────────────────────────────────────────
INSERT INTO public.prompt_variables (name, description, source) VALUES
  ('mode.directive', 'The VALUE vs PROMOTIONAL mode directive, composed by the handler from the pillar (or a one-off override).', 'mode.directive'),
  ('context.block',  'The context block, composed by the handler by mode: the reader''s world only (value) or the full business raw material (promotional).', 'context.block')
ON CONFLICT (name) DO NOTHING;

-- ── generate-social-post prompt v6 (mode-aware) ──────────────────────────────
UPDATE public.prompt_definitions SET is_active = false
  WHERE task_slug = 'generate-social-post' AND is_active = true;

INSERT INTO public.prompt_definitions (task_slug, version, system_prompt, user_prompt_template, is_active, change_note)
VALUES (
  'generate-social-post', 6,
  $sys$You are an expert marketer who writes social posts by EXECUTING a proven copywriting technique. Obey the MODE instruction exactly. In VALUE mode you write pure reader-insight: ZERO mention of any business, company, product, brand, tool, or "why you need it" - the post is only about the reader and a hard truth about their own situation. In PROMOTIONAL mode the business may appear, but only as subordinate raw material the technique operates on. The technique always dictates the angle, structure, and voice. Return ONLY valid JSON - no markdown fences, no commentary, nothing before or after the JSON.$sys$,
  $tmpl$# THE TECHNIQUE TO EXECUTE (this dictates everything)
Pillar: {{pillar.name}}
Write this post by executing the following technique, step by step. This is your PRIMARY instruction - the angle, the structure, and the voice all come from here.

{{pillar.method_body}}

Voice / register: {{pillar.register}}

{{mode.directive}}
{{source.block}}{{context.block}}# YOUR TASK
Write ONE social media post for {{platform.name}} that visibly EXECUTES the technique above, in the MODE described.
- Character limit: {{platform.char_limit}} - the post MUST be under this.
- Native to {{platform.name}} in tone and format.
- Run the technique's steps in order.

Return ONLY this JSON object (no markdown, no fences, nothing before or after):
{"post":"...","hook":"...","cta":"...","character_count":0}

Fields:
- post: the complete post text, strictly under {{platform.char_limit}} characters
- hook: the opening line that grabs attention
- cta: the closing line - for a VALUE post this is a reflective line or a question to the reader, NEVER a business call-to-action or link
- character_count: exact character count of the post value$tmpl$,
  true,
  'Stage 3.6: mode-aware (VALUE removes business + demands a hard reader-truth; PROMOTIONAL keeps v5). Method still leads.'
);

-- ── Verify (paste after applying) ─────────────────────────────────────────────
-- SELECT m.slug, t.name, t.pillar_mode FROM pillar_templates t JOIN pillar_methods m ON m.id=t.method_id ORDER BY m.display_order, t.display_order;
--   Expect: joanna 5 = value; core Customer Problems/Building in Public/Education/Behind/Industry/Founder = value;
--           core Social Proof/Announcements = promotional; General = promotional.
-- SELECT version, is_active FROM prompt_definitions WHERE task_slug='generate-social-post' ORDER BY version;
