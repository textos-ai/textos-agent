-- =====================================================================
-- Migration 121: coldcall demo prompts (isolated table) + model config
-- =====================================================================
-- Source: "Cold-call demo landing page" brief, 2026-08-16.
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: CREATE ... IF NOT EXISTS, and every INSERT is guarded by
-- ON CONFLICT / NOT EXISTS. Re-applying after the failed first attempt is a
-- no-op for anything that already exists.
--
-- WHY THESE PROMPTS ARE NOT IN prompt_definitions
-- The first version of this migration seeded prompt_definitions and FAILED:
--
--   23503: insert or update on table "prompt_definitions"
--          violates foreign key constraint "prompt_definitions_task_slug_fkey"
--
-- prompt_definitions.task_slug is a FOREIGN KEY to tasks(slug). A prompt there
-- cannot exist without a client-catalog tasks row, and creating one would put
-- the demo generator into the client task catalog — the exact coupling this
-- feature is built to avoid. Verified by effect against the live schema, not
-- assumed.
--
-- So the demo prompts get their own isolated table with the same SEMANTICS
-- (versioned, one active row per slug, never overwritten) and none of the
-- coupling. resolveColdcallPrompt() reads it; renderPrompt() is reused
-- unchanged.
--
-- ATOMICITY OF THE FAILED ATTEMPT: verified. After the FK error, zero demo-*
-- rows existed in prompt_definitions AND the external_apis row was absent —
-- the whole statement batch rolled back, so there is no partial state to
-- clean up. The ON CONFLICT below covers the re-run regardless.
-- =====================================================================

-- ── model config registration ────────────────────────────────────────
-- Per REGISTER-EVERY-LLM-SURFACE: the demo generator calls Claude four times,
-- so it must appear in /admin/models and resolve its model from config.
-- FEATURE_REGISTRY in src/lib/non-task-model-config.ts carries the code side.
INSERT INTO public.external_apis (slug, name, provider, auth_kind, output_kind, status, metadata)
VALUES ('feature-coldcall-demo', 'Cold-call Demo Site', 'system', 'none', 'text', 'active', '{}'::jsonb)
ON CONFLICT (slug) DO NOTHING;

-- ── the isolated prompt table ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.coldcall_demo_prompts (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Plain text, NO foreign key. That absence is the entire point of this table.
  slug                  TEXT        NOT NULL,
  version               INTEGER     NOT NULL DEFAULT 1,
  system_prompt         TEXT,
  user_prompt_template  TEXT        NOT NULL,
  is_active             BOOLEAN     NOT NULL DEFAULT true,
  max_output_tokens     INTEGER,
  change_note           TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            TEXT
);

-- One ACTIVE version per slug — same semantics prompt_definitions enforces.
-- A v2 is a new row plus flipping v1 to is_active=false; nothing is ever
-- overwritten, so the copy that produced a given demo stays readable.
CREATE UNIQUE INDEX IF NOT EXISTS coldcall_demo_prompts_active_slug
  ON public.coldcall_demo_prompts (slug) WHERE is_active;

-- Cheap lookup of a slug's version history for the admin/versioning view.
CREATE INDEX IF NOT EXISTS coldcall_demo_prompts_slug_version
  ON public.coldcall_demo_prompts (slug, version DESC);

-- RLS deny-by-default, matching every other coldcall_* table. The Worker's
-- service-role key bypasses RLS by design and is the only reader.
ALTER TABLE public.coldcall_demo_prompts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coldcall_demo_prompts FROM anon, authenticated;

-- =====================================================================
-- Seed the four section prompts.
-- Dollar-quoted ($p$...$p$) so apostrophes need no escaping.
-- =====================================================================

-- ── demo-hero ────────────────────────────────────────────────────────
INSERT INTO public.coldcall_demo_prompts
  (slug, version, is_active, change_note, max_output_tokens, system_prompt, user_prompt_template)
SELECT 'demo-hero', 1, true, 'Initial seed — coldcall demo landing page hero', 700,
$p$You write hero copy for small local service businesses in the United States.

VOICE: confident, plain, warm. Write the way a good owner talks about their own
work — specific, no bragging, no marketing throat-clearing. Lead with what the
customer gets, not what the business is.

HARD RULES
- Never mention AI, automation, agents, tasks, generation, or software. This is
  the business's own website copy.
- Never invent awards, certifications, licence numbers, years in business,
  staff counts, or guarantees. You do not know them.
- Never invent review quotes or star ratings.
- American English. No em dashes. No exclamation marks.
- Output STRICT JSON only. No prose, no code fences, no commentary.$p$,
$p$Write the hero section for this business's website.

Business name: {{lead.name}}
Trade / category: {{lead.category}}
Town: {{ctx.place}}
State: {{lead.state}}

The headline splits into two parts so the site can style the second half in an
accent colour: "headline" is the first part, "headline_accent" is the emphasised
tail. Together they must read as one natural sentence or phrase.

Make the copy specific to a {{lead.category}} serving {{ctx.place}}. A homeowner
in that town should read it and think "that is my problem, and these people are
nearby".

Return STRICT JSON exactly this shape:
{
  "eyebrow": "2-4 words, e.g. the trade and town",
  "headline": "first half of the headline, 3-6 words",
  "headline_accent": "emphasised second half, 2-5 words",
  "subhead": "one sentence, 15-28 words, the customer payoff and the area served",
  "cta_label": "2-4 words, an action, e.g. Get a free quote"
}$p$
WHERE NOT EXISTS (
  SELECT 1 FROM public.coldcall_demo_prompts WHERE slug = 'demo-hero' AND version = 1
);

-- ── demo-services ────────────────────────────────────────────────────
INSERT INTO public.coldcall_demo_prompts
  (slug, version, is_active, change_note, max_output_tokens, system_prompt, user_prompt_template)
SELECT 'demo-services', 1, true, 'Initial seed — coldcall demo landing page services', 1200,
$p$You write service-list copy for small local service businesses in the US.

VOICE: concrete and useful. Name the jobs a real customer actually calls about,
in the words they would use, not industry jargon.

HARD RULES
- Never mention AI, automation, agents, tasks, or software.
- Never invent pricing, guarantees, certifications, or response-time promises.
- Only list services that are genuinely typical of this trade. If you are not
  confident a service belongs to this trade, leave it out.
- American English. No em dashes. No exclamation marks.
- Output STRICT JSON only. No prose, no code fences.$p$,
$p$List the services this business offers, inferred from its trade.

Business name: {{lead.name}}
Trade / category: {{lead.category}}
Town: {{ctx.place}}

Choose between 3 and 6 services that a {{lead.category}} in a US town genuinely
offers. Order them with the most commonly needed first. Each blurb is one
sentence describing what the customer gets, not a definition of the service.

Return STRICT JSON exactly this shape:
{
  "section_title": "3-5 words, e.g. What we do",
  "items": [
    { "title": "2-5 words", "blurb": "one sentence, 12-22 words" }
  ]
}$p$
WHERE NOT EXISTS (
  SELECT 1 FROM public.coldcall_demo_prompts WHERE slug = 'demo-services' AND version = 1
);

-- ── demo-why-us ──────────────────────────────────────────────────────
INSERT INTO public.coldcall_demo_prompts
  (slug, version, is_active, change_note, max_output_tokens, system_prompt, user_prompt_template)
SELECT 'demo-why-us', 1, true, 'Initial seed — coldcall demo landing page why-us', 900,
$p$You write "why choose us" copy for small local service businesses in the US.

VOICE: grounded and unshowy. The believable reasons a neighbour recommends a
tradesperson: they turn up, they explain the price first, they clean up.

HARD RULES
- Never mention AI, automation, agents, tasks, or software.
- Never invent licences, insurance, warranties, awards, years in business, staff
  numbers, or response-time guarantees. Write reasons that are true of any good
  operator without claiming a specific credential.
- Never reference reviews or ratings.
- American English. No em dashes. No exclamation marks.
- Output STRICT JSON only. No prose, no code fences.$p$,
$p$Write the "why choose us" points for this business.

Business name: {{lead.name}}
Trade / category: {{lead.category}}
Town: {{ctx.place}}

Give 3 or 4 points. Each should be a reason a homeowner picks one
{{lead.category}} over another, phrased as a promise about how the work feels to
the customer rather than a credential.

Return STRICT JSON exactly this shape:
{
  "section_title": "3-5 words, e.g. Why neighbors call us",
  "points": [
    { "title": "2-5 words", "blurb": "one sentence, 12-24 words" }
  ]
}$p$
WHERE NOT EXISTS (
  SELECT 1 FROM public.coldcall_demo_prompts WHERE slug = 'demo-why-us' AND version = 1
);

-- ── demo-faq ─────────────────────────────────────────────────────────
INSERT INTO public.coldcall_demo_prompts
  (slug, version, is_active, change_note, max_output_tokens, system_prompt, user_prompt_template)
SELECT 'demo-faq', 1, true, 'Initial seed — coldcall demo landing page FAQ', 1400,
$p$You write FAQ copy for small local service businesses in the US.

VOICE: direct and helpful. Answer the question in the first sentence.

HARD RULES
- Never mention AI, automation, agents, tasks, or software.
- Never invent prices, hours, service radius in miles, licence numbers,
  insurance details, warranties, or guarantees. Where a real answer depends on
  facts you do not have, answer in a way that is true without inventing the
  number, and invite the customer to call.
- Never reference reviews or ratings.
- American English. No em dashes. No exclamation marks.
- Output STRICT JSON only. No prose, no code fences.$p$,
$p$Write the FAQ for this business.

Business name: {{lead.name}}
Trade / category: {{lead.category}}
Town: {{ctx.place}}

Give 4 to 6 questions a real customer asks a {{lead.category}} before booking.
Use the customer's own phrasing for the question. Keep each answer to 1-2
sentences.

Return STRICT JSON exactly this shape:
{
  "section_title": "2-4 words, e.g. Common questions",
  "faqs": [
    { "q": "the question as a customer would ask it", "a": "1-2 sentences" }
  ]
}$p$
WHERE NOT EXISTS (
  SELECT 1 FROM public.coldcall_demo_prompts WHERE slug = 'demo-faq' AND version = 1
);

-- == Verify (paste after applying) =============================================
-- All four seeded and active:
--   SELECT slug, version, is_active, max_output_tokens,
--          length(user_prompt_template) AS tmpl_len
--     FROM public.coldcall_demo_prompts ORDER BY slug;
--   Expect 4 rows: demo-faq, demo-hero, demo-services, demo-why-us
--
-- One active version per slug is enforced (expect 4, and a second active
-- insert for the same slug must fail):
--   SELECT slug, count(*) FILTER (WHERE is_active) AS active_versions
--     FROM public.coldcall_demo_prompts GROUP BY slug;
--
-- No coupling to the client catalog — this table has NO foreign keys:
--   SELECT con.conname, pg_get_constraintdef(con.oid)
--     FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
--    WHERE rel.relname = 'coldcall_demo_prompts';
--   Expect: primary key only, no FOREIGN KEY line.
--
-- Feature is registered and selectable in /admin/models:
--   SELECT slug, name, status, metadata FROM public.external_apis
--    WHERE slug = 'feature-coldcall-demo';
--
-- RLS on, zero policies (deny-by-default):
--   SELECT tablename, rowsecurity FROM pg_tables
--    WHERE schemaname='public' AND tablename = 'coldcall_demo_prompts';
