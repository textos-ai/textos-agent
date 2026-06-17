-- =====================================================================
-- Migration 049: Versioned prompt definitions + variable catalog
-- =====================================================================
-- Source: Prompt versioning brief — 2026-06-17
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: uses IF NOT EXISTS / DROP POLICY IF EXISTS / ON CONFLICT / partial index.
-- =====================================================================
--
-- Creates two tables:
--   prompt_definitions  — one row per task per version; exactly one is_active
--                         per task_slug enforced by a partial unique index.
--   prompt_variables    — catalog of available {{variable}} tokens for the
--                         authoring UX. Admin-editable descriptions.
--
-- Seeding:
--   prompt_definitions  ← existing tasks.prompt_template (non-null, non-empty)
--                         seeded as version 1, is_active = true,
--                         system_prompt = the SYSTEM constant from generic-document-runner
--                         (table is sole source of truth; runner throws on null).
--   prompt_variables    ← the complete set available via renderPrompt():
--                         business.*, ctx.*, user.* dot-path tokens.
-- =====================================================================

-- ── prompt_definitions ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.prompt_definitions (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_slug            TEXT        NOT NULL
                         REFERENCES public.tasks(slug) ON DELETE CASCADE,
  version              INTEGER     NOT NULL CHECK (version >= 1),
  system_prompt        TEXT,
  user_prompt_template TEXT        NOT NULL CHECK (trim(user_prompt_template) <> ''),
  is_active            BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by           UUID        REFERENCES public.users(id) ON DELETE SET NULL,
  change_note          TEXT,

  CONSTRAINT prompt_definitions_task_version UNIQUE (task_slug, version)
);

-- Exactly one active row per task_slug.
-- A partial unique index enforces this at the DB layer.
CREATE UNIQUE INDEX IF NOT EXISTS prompt_definitions_one_active_per_task
  ON public.prompt_definitions (task_slug)
  WHERE (is_active = TRUE);

-- Speed up version-history queries and "get active for task" lookups.
CREATE INDEX IF NOT EXISTS prompt_definitions_task_slug_idx
  ON public.prompt_definitions (task_slug);

-- RLS: prompt definitions are read-only for all authenticated users;
-- writes happen only via the service-role Worker (admin API).
ALTER TABLE public.prompt_definitions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "prompt_definitions_read_authenticated" ON public.prompt_definitions;
CREATE POLICY "prompt_definitions_read_authenticated"
  ON public.prompt_definitions
  FOR SELECT
  TO authenticated
  USING (true);

-- ── Seed from tasks.prompt_template ─────────────────────────────────────────
-- Every paid task with a non-empty prompt_template gets version 1, active.
-- system_prompt is seeded from the genericDocumentRunner SYSTEM constant —
-- the table is the sole source of truth; the runtime no longer falls back to code.
-- ON CONFLICT: DO UPDATE backfills system_prompt if a prior run left it NULL.

INSERT INTO public.prompt_definitions
  (task_slug, version, system_prompt, user_prompt_template, is_active, change_note)
SELECT
  slug,
  1,
  $sys$You are a TextOS task agent generating a structured document for a business owner.

Output requirements (strict):
- Return ONLY a valid JSON object. No markdown fences, no commentary, no preamble.
- Shape: { "title": string, "sections": [{ "heading": string, "body": string }] }
- Each section.body uses GitHub-flavored markdown (headings, lists, bold, links).
- Title is concise (5-10 words), Title Case.
- 3 to 8 sections is typical. Each section heading is 2-6 words, Title Case.
- Write for an operator/founder audience. Concrete, specific, and grounded in the business
  context provided. Avoid fluff, clichés, and generic management-speak.$sys$,
  prompt_template,
  TRUE,
  'Initial version — seeded from tasks.prompt_template'
FROM public.tasks
WHERE prompt_template IS NOT NULL
  AND trim(prompt_template) <> ''
ON CONFLICT (task_slug, version) DO UPDATE
  SET system_prompt = EXCLUDED.system_prompt
  WHERE prompt_definitions.system_prompt IS NULL;

-- ── prompt_variables ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.prompt_variables (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL UNIQUE,
  description TEXT        NOT NULL CHECK (trim(description) <> ''),
  source      TEXT        NOT NULL CHECK (trim(source) <> ''),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: read-only for authenticated (admin-authored, no user-specific data).
ALTER TABLE public.prompt_variables ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "prompt_variables_read_authenticated" ON public.prompt_variables;
CREATE POLICY "prompt_variables_read_authenticated"
  ON public.prompt_variables
  FOR SELECT
  TO authenticated
  USING (true);

-- ── Seed prompt_variables ────────────────────────────────────────────────────

INSERT INTO public.prompt_variables (name, description, source) VALUES
  ('business.name',
   'Business name as entered by the owner',
   'business.name'),

  ('business.slug',
   'URL-safe unique business slug',
   'business.slug'),

  ('business.kind',
   'Business kind: new_idea | find_for_me | existing',
   'business.kind'),

  ('business.existing_business_url',
   'URL of the existing business website (only set when kind = existing)',
   'business.existing_business_url'),

  ('ctx.business_summary',
   'AI-generated one-paragraph narrative summary of the business',
   'ctx.business_summary'),

  ('ctx.industry',
   'Business industry category (e.g. "SaaS", "Retail", "Healthcare")',
   'ctx.industry'),

  ('ctx.business_model',
   'How the business earns revenue (e.g. "Subscription SaaS", "Marketplace")',
   'ctx.business_model'),

  ('ctx.value_proposition',
   'Core value the business delivers to its customers',
   'ctx.value_proposition'),

  ('ctx.positioning_statement',
   'Brand positioning statement — who, what, why, differentiated from whom',
   'ctx.positioning_statement'),

  ('ctx.brand_voice',
   'Tone and style of the brand''s communication (e.g. "direct, expert, warm")',
   'ctx.brand_voice'),

  ('ctx.target_customer',
   'Target customer profile object — persona, pain points, demographics (serialised JSON)',
   'ctx.target_customer'),

  ('ctx.market_size',
   'TAM / SAM / SOM figures and methodology (serialised JSON)',
   'ctx.market_size'),

  ('ctx.competitors',
   'List of competitor objects with names, strengths, weaknesses (serialised JSON array)',
   'ctx.competitors'),

  ('ctx.market_trends',
   'List of relevant market trend objects (serialised JSON array)',
   'ctx.market_trends'),

  ('ctx.key_differentiators',
   'List of what makes this business uniquely better than alternatives (serialised JSON array)',
   'ctx.key_differentiators'),

  ('ctx.financial_snapshot',
   'Revenue, expenses, burn rate, and runway snapshot (serialised JSON)',
   'ctx.financial_snapshot'),

  ('ctx.customer_signals',
   'Customer feedback, reviews, NPS, and demand signals (serialised JSON)',
   'ctx.customer_signals'),

  ('ctx.agent_name',
   'Personalised AI agent name configured for this business (may be null)',
   'ctx.agent_name'),

  ('ctx.research_confidence_score',
   'How complete and confident the business research is, 0–1 float',
   'ctx.research_confidence_score'),

  ('user.email',
   'Business owner''s email address',
   'user.email'),

  ('user.handle',
   'Business owner''s username handle (may be null)',
   'user.handle')

ON CONFLICT (name) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification queries (paste into Supabase SQL editor after applying)
-- ─────────────────────────────────────────────────────────────────────────────
-- Confirm tables exist:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public'
--     AND table_name IN ('prompt_definitions', 'prompt_variables');
--
-- Confirm RLS enabled:
--   SELECT tablename, rowsecurity FROM pg_tables
--   WHERE schemaname = 'public'
--     AND tablename IN ('prompt_definitions', 'prompt_variables');
--
-- Confirm seeded definitions (system_prompt should be non-null for every row):
--   SELECT task_slug, version, is_active,
--          system_prompt IS NOT NULL AS has_system_prompt,
--          length(user_prompt_template) AS tmpl_len
--   FROM public.prompt_definitions
--   ORDER BY task_slug;
--
-- Confirm no null system_prompts (should return 0 rows):
--   SELECT task_slug FROM public.prompt_definitions WHERE system_prompt IS NULL;
--
-- Confirm one-active-per-task constraint (should return 0):
--   SELECT task_slug, count(*) FROM public.prompt_definitions
--   WHERE is_active = true GROUP BY task_slug HAVING count(*) > 1;
--
-- Confirm variable catalog:
--   SELECT name, source FROM public.prompt_variables ORDER BY name;
--   -- Expected: 21 rows
-- ─────────────────────────────────────────────────────────────────────────────
