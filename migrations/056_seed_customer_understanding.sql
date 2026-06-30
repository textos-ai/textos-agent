-- =====================================================================
-- Migration 056: Seed customer-understanding document task
-- =====================================================================
-- Source: "Customer Understanding document type" brief — the customer-
-- intelligence layer, foundation for content pillars (esp. the customer-
-- problems pillar). Grounded in Jobs-to-be-Done + Value Proposition Canvas
-- (VPC Customer Profile). Concept: victora-content-pillars-concept.md §4.
--
-- This migration is PURE DATA — no new runner code. A document task with no
-- entry in FREE_BUILD_TASK_HANDLERS falls through to genericDocumentRunner,
-- which renders {{business.*}}/{{ctx.*}}/{{user.*}}/{{config.*}} into the
-- active prompt_definition and validates the standard {title,sections} shape.
-- The doc is therefore automatically listed (documents-source.ts), editable,
-- lockable (business_assets keyed by task_run_id), and readable by content
-- generation (flattenDocData) — no parallel system.
--
-- This migration:
--   1. Inserts the customer-understanding task row (mirrors sibling strategy
--      docs: business_builder / builder / foundation / document / core_paid).
--   2. Assigns lifecycle_phase_id = foundation.
--   3. Binds the task to anthropic-claude-sonnet via task_apis.
--   4. Seeds the VPC Customer Profile prompt_definition (v1, active).
--   5. Registers the new {{config.founder_answers}} prompt variable.
--
-- Generation flow:
--   • SYNTHESIZE — first run with no config produces a draft from existing
--     business context. {{config.founder_answers}} renders to "" and the
--     prompt infers + flags language as provisional, never fabricating quotes.
--   • SHARPEN — re-run the SAME task with task_runs.config.founder_answers set;
--     the re-run becomes the new is_current doc (pipeline-native), folding the
--     founder's only-they-know answers in (esp. real customer language).
--
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
--
-- Safe to re-run: ON CONFLICT DO NOTHING on the task + task_apis, explicit
-- deactivate-then-insert guard on prompt_definitions, ON CONFLICT on variable.
-- =====================================================================

-- ── 1. Task row ───────────────────────────────────────────────────────────────

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
  'customer-understanding',
  'Customer Understanding',
  'A deep Value Proposition Canvas profile of your primary customer — their jobs, ranked pains, gains, world, and language.',
  'business_builder',
  false,
  'core_paid',
  'fully_locked',
  0,
  'document',
  3,
  'manual',
  'active',
  true,
  true,
  false,
  'Profiling your customer...',
  'builder'
)
ON CONFLICT (slug) DO NOTHING;

-- ── 2. lifecycle_phase_id → foundation ───────────────────────────────────────

UPDATE public.tasks t
SET lifecycle_phase_id = lp.id
FROM public.lifecycle_phases lp
WHERE lp.slug = 'foundation'
  AND t.slug  = 'customer-understanding';

-- ── 2b. Runnability gate: non-empty tasks.prompt_template ─────────────────────
-- The run gate (business-task-run.ts isComingSoon) and the frontend
-- (task-presentation.ts isTaskRunnableNow) treat a paid document task as
-- runnable only when tasks.prompt_template is non-empty — otherwise it shows as
-- "coming soon" and the run is rejected. The runner itself does NOT execute this
-- column: it resolves the real prompt from prompt_definitions via resolvePrompt
-- (see section 4). This column is therefore the legacy runnability gate only, so
-- we set it to a pointer that keeps prompt_definitions the single source of truth.

UPDATE public.tasks
SET prompt_template = 'Managed in prompt_definitions (versioned); this column is the legacy runnability gate only — the runner resolves the active customer-understanding prompt from prompt_definitions.'
WHERE slug = 'customer-understanding'
  AND (prompt_template IS NULL OR trim(prompt_template) = '');

-- ── 3. task_apis: bind to anthropic-claude-sonnet ────────────────────────────

INSERT INTO public.task_apis (task_id, api_id, role)
SELECT t.id, a.id, 'primary'
FROM public.tasks t
CROSS JOIN public.external_apis a
WHERE t.slug = 'customer-understanding'
  AND a.slug = 'anthropic-claude-sonnet'
ON CONFLICT (task_id, api_id, role) DO NOTHING;

-- ── 4. prompt_definitions: VPC Customer Profile (v1, active) ──────────────────
-- Deactivate any pre-existing active row first so the partial unique index
-- (one active per slug) is never violated on re-run.

UPDATE public.prompt_definitions
SET is_active = false
WHERE task_slug = 'customer-understanding'
  AND is_active = true;

INSERT INTO public.prompt_definitions (
  task_slug,
  version,
  system_prompt,
  user_prompt_template,
  is_active,
  change_note
) VALUES (
  'customer-understanding',
  1,
  $sys$You are a customer-intelligence strategist building a Value Proposition Canvas (VPC) Customer Profile, grounded in Jobs-to-be-Done. You turn a business's existing context into a sharp, specific portrait of its ONE primary customer segment: the jobs they are trying to get done, the pains that rank highest, the gains they actually want, and the world they live in and the language they use.

Output requirements (strict):
- Return ONLY a valid JSON object. No markdown fences, no commentary, no preamble.
- Shape: { "title": string, "sections": [{ "heading": string, "body": string }] }
- Each section.body uses GitHub-flavored markdown (bold labels, tight bullet lists).
- Title names the business and its primary segment, Title Case, 5-10 words.
- BE CONCISE. This is a sharp operating briefing, not an essay. Use short bullets, not paragraphs. Each section.body is at most ~110 words. No filler, no preamble, no restating the prompt.

Produce EXACTLY these six sections, in this order, with these exact headings:

1. "Primary Segment & Their World" — One **bold** line naming the single primary segment, then 2-3 tight sentences on their real situation, journey stage, and the forces acting on them. Write this so ADDITIONAL segments could be appended later as their own parallel profiles — do not hard-wire single-segment assumptions into the structure.

2. "Jobs To Be Done" — Three labelled groups, 1-2 bullets each: **Functional** (the practical task they hire a solution to do), **Social** (how they want to be perceived), **Emotional** (how they want to feel). Concrete and business-specific.

3. "Pains" — 4-6 obstacles, risks, frustrations, or costs standing in their way, RANKED most-severe first. Begin each bullet with a bold severity tag — **Severe**, **Moderate**, or **Mild**. One line each. Do not pad to hit a number.

4. "Gains" — Four labelled tiers, 1-2 bullets each: **Required** (table-stakes, the deal breaks without them), **Expected** (assumed but appreciated), **Desired** (would actively love), **Unexpected** (delight beyond what they would think to ask for). Gains are NOT merely the inverse of pains — name outcomes the customer actively wants.

5. "Voice & Language" — 5-8 short words/phrases this customer actually uses for their problem and their goal. IF the FOUNDER ANSWERS section provides real customer language, ground this section in it and quote directly. IF the FOUNDER ANSWERS section is empty, infer cautiously and append "(inferred)" to every inferred phrase. NEVER fabricate verbatim customer quotes as though they were observed.

6. "Sharpen This Profile" — 3 to 5 sharp, specific discovery questions whose answers ONLY THE FOUNDER could know and that would most improve this profile — especially real customer language, the true #1 pain, and the single gain that decides a purchase. If FOUNDER ANSWERS are already provided, briefly restate what they confirmed, then ask only what still remains genuinely open.

Rules: Be concrete and specific to THIS business — no generic management-speak, no filler. Ground every claim in the context provided. If a needed piece of context is missing, say so plainly rather than inventing it.$sys$,
  E'Business: {{business.name}}\nIndustry: {{ctx.industry}}\nBusiness model: {{ctx.business_model}}\nBusiness summary: {{ctx.business_summary}}\nValue proposition: {{ctx.value_proposition}}\nPositioning: {{ctx.positioning_statement}}\nBrand voice: {{ctx.brand_voice}}\nTarget customer: {{ctx.target_customer}}\nKey differentiators: {{ctx.key_differentiators}}\nCompetitors: {{ctx.competitors}}\nMarket trends: {{ctx.market_trends}}\nCustomer signals: {{ctx.customer_signals}}\n\nFOUNDER ANSWERS (may be empty — if empty, do not fabricate customer language; infer and flag, and ask sharp questions instead):\n{{config.founder_answers}}\n\nBuild the Value Proposition Canvas Customer Profile for this business''s ONE primary customer segment, following the six-section structure and the rules exactly.',
  true,
  'Initial version — VPC Customer Profile (Jobs/Pains/Gains + World/Language), synthesize-then-sharpen.'
)
ON CONFLICT (task_slug, version) DO UPDATE
  SET system_prompt        = EXCLUDED.system_prompt,
      user_prompt_template = EXCLUDED.user_prompt_template,
      is_active            = true,
      change_note          = EXCLUDED.change_note;

-- ── 4b. task_objectives: place under Playbook step "Get Customers" ────────────
-- The 8 Playbook steps are the `objectives` table; tasks associate via the
-- `task_objectives` join (same mechanism every task uses). Without a row here
-- the task falls to the "Other" catch-all in both the Playbook and the
-- documents view (which groups by the producing task's first objective).
-- Customer Understanding's home is "Get Customers" (find/win the people who buy).

INSERT INTO public.task_objectives (task_id, objective_id)
SELECT t.id, o.id
FROM public.tasks t
CROSS JOIN public.objectives o
WHERE t.slug = 'customer-understanding'
  AND o.slug = 'get-customers'
ON CONFLICT (task_id, objective_id) DO NOTHING;

-- ── 5. prompt_variables: register {{config.founder_answers}} ──────────────────

INSERT INTO public.prompt_variables (name, description, source) VALUES
  ('config.founder_answers',
   'Founder''s answers to the customer-understanding sharpening questions, forwarded via task_runs.config.founder_answers. Empty on the first synthesis run; populated on a sharpening re-run to ground the profile (esp. real customer language). Renders to "" when absent.',
   'config.founder_answers')
ON CONFLICT (name) DO NOTHING;

-- ── Verification (paste into Supabase SQL editor after applying) ──────────────
-- 1. Task row:
--    SELECT slug, area, surface, output_type, plan_required, visibility,
--           token_cost, status, progress_verb
--    FROM tasks WHERE slug = 'customer-understanding';
--
-- 2. Lifecycle assignment (expect foundation):
--    SELECT t.slug, lp.slug AS phase
--    FROM tasks t JOIN lifecycle_phases lp ON lp.id = t.lifecycle_phase_id
--    WHERE t.slug = 'customer-understanding';
--
-- 3. Model binding (expect anthropic-claude-sonnet / primary):
--    SELECT t.slug, a.slug AS api, ta.role
--    FROM task_apis ta JOIN tasks t ON t.id = ta.task_id
--    JOIN external_apis a ON a.id = ta.api_id
--    WHERE t.slug = 'customer-understanding';
--
-- 4. Active prompt (expect exactly one active, has system_prompt):
--    SELECT task_slug, version, is_active, system_prompt IS NOT NULL AS has_sys,
--           length(user_prompt_template) AS tmpl_len
--    FROM prompt_definitions WHERE task_slug = 'customer-understanding';
--
-- 5. Variable registered:
--    SELECT name, source FROM prompt_variables WHERE name = 'config.founder_answers';
