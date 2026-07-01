-- =====================================================================
-- Migration 074: Content Pillars - Stage 1 (data model + starter library)
-- =====================================================================
-- Two tiers, following the codebase platform-vs-per-business convention:
--   PLATFORM (admin-authored, shared to all businesses - like tasks/objectives):
--     pillar_data_sources  - controlled vocab for a pillar context source
--     pillar_methods       - a method/collection (Victora Core, an expert, ...)
--     pillar_templates     - a pillar within a method
--   PER-BUSINESS (owner-scoped - like content_assets):
--     business_pillars     - a business working set; ADOPT copies a template
--                            values in (so later edits do not mutate the platform).
--
-- Stage 3/4 will add content_assets.pillar_id and pillar steering in
-- prompt_definitions - NOT touched here.
--
-- NOTE ON QUOTING: all free-text below uses dollar-quoting ($q$...$q$) instead of
-- doubled single-quotes. This makes the file immune to editors/clipboards that
-- collapse '' -> ' on paste (which silently breaks string literals). Pure ASCII
-- throughout for the same reason.
--
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: IF NOT EXISTS + ON CONFLICT DO NOTHING throughout. Adds only.
-- =====================================================================

-- ── Controlled vocabulary: data sources ──────────────────────────────────────
-- DB-driven so the admin authoring select and Stage-3 generation both read the
-- set from here (no hardcoded list in code).
CREATE TABLE IF NOT EXISTS public.pillar_data_sources (
  slug          TEXT        PRIMARY KEY,
  label         TEXT        NOT NULL,
  description   TEXT,
  display_order INTEGER     NOT NULL DEFAULT 0
);

INSERT INTO public.pillar_data_sources (slug, label, description, display_order) VALUES
  ('customer_understanding', $q$Customer Understanding$q$,
   $q$How the customer thinks - their jobs, pains, gains and real language, from the Customer Understanding profile and target-customer context.$q$, 1),
  ('product_knowledge', $q$Product Knowledge$q$,
   $q$What the business does and why it wins - value proposition, differentiators, positioning, summary, brand voice.$q$, 2),
  ('market_point_of_view', $q$Market Point of View$q$,
   $q$Where the market is heading and how the business sees it - competitors, trends, market size, competitive analysis.$q$, 3),
  ('everything', $q$Everything$q$,
   $q$Draw on the full business context - customer, product, and market together.$q$, 4)
ON CONFLICT (slug) DO NOTHING;

-- ── PLATFORM: pillar_methods ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pillar_methods (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT        NOT NULL UNIQUE,
  name          TEXT        NOT NULL,
  attributed_to TEXT,                       -- NULL = Victora Core; else expert name
  credential    TEXT,                       -- e.g. Conversion copywriter, Founder of Copyhackers
  premise       TEXT,                       -- the pull-quote
  portrait_url  TEXT,                       -- placeholder for now
  status        TEXT        NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','published','coming_soon')),
  is_core       BOOLEAN     NOT NULL DEFAULT false,
  display_order INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── PLATFORM: pillar_templates (a pillar within a method) ─────────────────────
CREATE TABLE IF NOT EXISTS public.pillar_templates (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  method_id     UUID        NOT NULL REFERENCES public.pillar_methods(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  intent        TEXT,                       -- what the pillar is for
  register      TEXT,                       -- FREE TEXT, e.g. Empathetic, direct
  data_source   TEXT        NOT NULL REFERENCES public.pillar_data_sources(slug),
  display_order INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pillar_templates_method_name_uq UNIQUE (method_id, name)
);
CREATE INDEX IF NOT EXISTS idx_pillar_templates_method ON public.pillar_templates(method_id);

-- ── PER-BUSINESS: business_pillars (the working set) ─────────────────────────
CREATE TABLE IF NOT EXISTS public.business_pillars (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        UUID        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name               TEXT        NOT NULL,
  intent             TEXT,
  register           TEXT,
  data_source        TEXT        NOT NULL REFERENCES public.pillar_data_sources(slug),
  source_template_id UUID        REFERENCES public.pillar_templates(id) ON DELETE SET NULL, -- set on ADOPT (copy), null when custom
  is_custom          BOOLEAN     NOT NULL DEFAULT false,
  display_order      INTEGER     NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_business_pillars_business ON public.business_pillars(business_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Platform tables: readable by any authenticated user (Method Library is shown
-- to everyone); writes only via the service-role Worker (admin API). Mirrors the
-- read-open posture used for shared catalog content.
ALTER TABLE public.pillar_data_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pillar_methods      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pillar_templates    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pillar_data_sources_read" ON public.pillar_data_sources;
CREATE POLICY "pillar_data_sources_read" ON public.pillar_data_sources FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "pillar_methods_read" ON public.pillar_methods;
CREATE POLICY "pillar_methods_read" ON public.pillar_methods FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "pillar_templates_read" ON public.pillar_templates;
CREATE POLICY "pillar_templates_read" ON public.pillar_templates FOR SELECT TO authenticated USING (true);

-- Per-business: owner-scoped select (same pattern as content_assets). Worker
-- writes via service-role and bypasses RLS.
ALTER TABLE public.business_pillars ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "owner_select_business_pillars" ON public.business_pillars;
CREATE POLICY "owner_select_business_pillars" ON public.business_pillars
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM public.businesses WHERE user_id = auth.uid()));

-- ═════════════════════════════════════════════════════════════════════════════
-- SEED: the starter library
-- ═════════════════════════════════════════════════════════════════════════════

-- ── VICTORA CORE (is_core, attributed_to NULL, published) ────────────────────
INSERT INTO public.pillar_methods (slug, name, attributed_to, credential, premise, status, is_core, display_order)
VALUES ('victora-core', $q$Victora Core$q$, NULL, NULL,
        $q$Eight ways to show up that any business can run - the dependable rhythm of building an audience.$q$,
        'published', true, 0)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.pillar_templates (method_id, name, intent, register, data_source, display_order)
SELECT m.id, v.name, v.intent, v.register, v.data_source, v.display_order
FROM public.pillar_methods m
CROSS JOIN (VALUES
  ($q$Customer Problems$q$,  $q$Name the pain your customer feels before they can name it themselves, and show you understand it better than they do.$q$, 'Empathetic, direct',      'customer_understanding', 1),
  ($q$Building in Public$q$, $q$Share the real work - decisions, progress, and stumbles - so people follow the journey, not just the product.$q$,        'Candid',                  'product_knowledge',      2),
  ($q$Social Proof$q$,       $q$Let results, customers, and numbers do the talking - evidence that others already trust you.$q$,                          'Confident, humble',       'product_knowledge',      3),
  ($q$Education / How-To$q$, $q$Teach one useful thing your customer can act on today, and become the source they return to.$q$,                         'Helpful, instructional',  'product_knowledge',      4),
  ($q$Behind the Scenes$q$,  $q$Show the people and process behind the product - the human texture a logo cannot convey.$q$,                             'Personal, warm',          'product_knowledge',      5),
  ($q$Industry Takes$q$,     $q$Stake a clear position on where your market is heading, and give people a reason to argue or agree.$q$,                  'Opinionated',             'market_point_of_view',   6),
  ($q$Announcements$q$,      $q$Make news land - launches, milestones, and updates framed so people care and act.$q$,                                    'Energetic, clear',        'product_knowledge',      7),
  ($q$Founder Story$q$,      $q$Tell why you started and what you are really chasing - the narrative that makes strangers root for you.$q$,              'Personal, narrative',     'product_knowledge',      8)
) AS v(name, intent, register, data_source, display_order)
WHERE m.slug = 'victora-core'
ON CONFLICT (method_id, name) DO NOTHING;

-- ── THE JOANNA WIEBE METHOD (published) ──────────────────────────────────────
INSERT INTO public.pillar_methods (slug, name, attributed_to, credential, premise, status, is_core, display_order)
VALUES ('joanna-wiebe', $q$The Joanna Wiebe Method$q$, $q$Joanna Wiebe$q$,
        $q$Conversion copywriter, Founder of Copyhackers$q$,
        $q$Great copy does not describe a product - it moves a belief. Each pillar begins from what your reader already thinks, and hands you a proven angle to shift it.$q$,
        'published', false, 1)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.pillar_templates (method_id, name, intent, register, data_source, display_order)
SELECT m.id, v.name, v.intent, v.register, v.data_source, v.display_order
FROM public.pillar_methods m
CROSS JOIN (VALUES
  ($q$Flip the Status$q$,        $q$Start from the status your reader already wants, and reposition your offer as the shortest path to it.$q$,     'Provocative, assured',    'customer_understanding', 1),
  ($q$Hijack the Myth$q$,        $q$Take a belief your market holds as gospel, dismantle it with evidence, and replace it with yours.$q$,         'Contrarian, evidence-led','market_point_of_view',   2),
  ($q$Open the Hidden Door$q$,   $q$Reveal an option they did not know existed - the generous wait-you-can-do-that angle.$q$,                       'Intriguing, generous',    'product_knowledge',      3),
  ($q$Build the Ritual$q$,       $q$Turn your product into a repeatable habit by scripting the small, concrete steps that make it stick.$q$,      'Motivating, concrete',    'product_knowledge',      4),
  ($q$Give Them a Superpower$q$, $q$Sell the after - the vivid, aspirational version of who they become once the problem is gone.$q$,            'Aspirational, vivid',     'product_knowledge',      5)
) AS v(name, intent, register, data_source, display_order)
WHERE m.slug = 'joanna-wiebe'
ON CONFLICT (method_id, name) DO NOTHING;

-- ── COMING SOON (name + attributed_to only; no pillars yet) ──────────────────
INSERT INTO public.pillar_methods (slug, name, attributed_to, status, is_core, display_order) VALUES
  ('alex-hormozi',  $q$The Alex Hormozi Method$q$,  $q$Alex Hormozi$q$,  'coming_soon', false, 2),
  ('april-dunford', $q$The April Dunford Method$q$, $q$April Dunford$q$, 'coming_soon', false, 3)
ON CONFLICT (slug) DO NOTHING;

-- ── Verify (paste after applying) ─────────────────────────────────────────────
-- SELECT m.slug, m.status, m.is_core, count(t.id) AS pillars
-- FROM pillar_methods m LEFT JOIN pillar_templates t ON t.method_id = m.id
-- GROUP BY m.id ORDER BY m.display_order;
--   Expect: victora-core published core 8 | joanna-wiebe published 5 |
--           alex-hormozi coming_soon 0 | april-dunford coming_soon 0
-- SELECT slug FROM pillar_data_sources ORDER BY display_order;  -- 4 rows
