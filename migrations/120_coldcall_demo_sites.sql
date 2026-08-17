-- =====================================================================
-- Migration 120: coldcall demo landing pages
-- =====================================================================
-- Source: "Cold-call demo landing page" brief, 2026-08-16.
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: IF NOT EXISTS throughout, seed uses ON CONFLICT DO NOTHING.
--
-- ISOLATION IS THE POINT. A demo site is a SALES PROP shown on a call — it is
-- not the prospect's real website and not a Victora client site. It therefore
-- touches NONE of the client business system: no businesses row, no
-- business_context, no business_assets, no sites/site_*, no tasks row, no
-- task_runs. Source is coldcall_leads; storage is here; rendering is a
-- coldcall-owned public route.
--
-- The link record is THIS TABLE, keyed by lead_id (UNIQUE). There is
-- deliberately no url column on coldcall_leads: one row per lead here is the
-- idempotency key AND the link, so there is no second place to keep in sync.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.coldcall_demo_sites (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- UNIQUE is the idempotency guarantee: a second click can only ever find
  -- the existing row, never create a duplicate demo for the same lead.
  lead_id     UUID        NOT NULL UNIQUE
                REFERENCES public.coldcall_leads(id) ON DELETE CASCADE,
  -- Public URL segment: /demo/{slug}. UNIQUE across all demos.
  slug        TEXT        NOT NULL UNIQUE,
  -- The rendered content model. NULL while generating — the render route
  -- serves only status='ready', so a half-written demo is never public.
  content     JSONB,
  -- Which demo-heroes/{folder}/ the images came from. Recorded so a wrong
  -- image set is diagnosable without re-deriving the category mapping.
  hero_folder TEXT,
  status      TEXT        NOT NULL DEFAULT 'generating'
                CHECK (status IN ('generating','ready','failed')),
  -- Populated ONLY when status='failed'. A failure must be readable, not a
  -- silent empty page.
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The public render route resolves by slug and requires status='ready'.
CREATE INDEX IF NOT EXISTS coldcall_demo_sites_ready
  ON public.coldcall_demo_sites (slug) WHERE status = 'ready';

DO $$ BEGIN
  CREATE TRIGGER trg_coldcall_demo_sites_updated_at
    BEFORE UPDATE ON public.coldcall_demo_sites
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- =====================================================================
-- coldcall_hero_map — category -> R2 folder under demo-heroes/
--
-- A TABLE rather than a constant in code, per the no-DB-constants rule:
-- adding a hero set for "auto repair" must be an INSERT, not a deploy.
--
-- EVERY ONE of the 53 distinct coldcall_leads.category values is seeded, so
-- lookup never misses. 'generic' is the folder for everything without its own
-- trade photography — including trades we have no set for yet (general
-- contractor, foundation repair, garage door repair, pressure washing).
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.coldcall_hero_map (
  category TEXT PRIMARY KEY,
  folder   TEXT NOT NULL
);

INSERT INTO public.coldcall_hero_map (category, folder) VALUES
  -- ── the nine trades with their own hero sets ──
  ('electrician',          'electrician'),
  ('plumber',              'plumber'),
  ('roofing contractor',   'roofing'),
  ('hvac contractor',      'hvac'),
  ('landscaper',           'landscaper'),
  ('painter',              'painter'),
  ('tree service',         'tree-service'),
  ('fence contractor',     'fence'),
  ('pest control',         'pest-control'),
  -- ── trades without a dedicated set yet ──
  ('general contractor',   'generic'),
  ('foundation repair',    'generic'),
  ('garage door repair',   'generic'),
  ('pressure washing',     'generic'),
  ('gutter service',       'generic'),
  ('locksmith',            'generic'),
  ('moving company',       'generic'),
  ('storage facility',     'generic'),
  ('car wash',             'generic'),
  ('laundry',              'generic'),
  -- ── auto ──
  ('auto repair',          'generic'),
  ('auto parts store',     'generic'),
  -- ── personal care ──
  ('beauty salon',         'generic'),
  ('barber shop',          'generic'),
  ('hair salon',           'generic'),
  ('nail salon',           'generic'),
  ('spa',                  'generic'),
  -- ── health ──
  ('dentist',              'generic'),
  ('doctor',               'generic'),
  ('physical therapy',     'generic'),
  ('chiropractor',         'generic'),
  ('veterinarian',         'generic'),
  ('gym',                  'generic'),
  ('yoga studio',          'generic'),
  -- ── professional services ──
  ('accountant',           'generic'),
  ('tax preparation',      'generic'),
  ('insurance agency',     'generic'),
  ('real estate agency',   'generic'),
  ('lawyer',               'generic'),
  ('personal injury lawyer','generic'),
  ('family lawyer',        'generic'),
  -- ── food & drink ──
  ('restaurant',           'generic'),
  ('cafe',                 'generic'),
  ('bar',                  'generic'),
  ('bakery',               'generic'),
  ('catering service',     'generic'),
  ('meal delivery',        'generic'),
  -- ── retail ──
  ('clothing store',       'generic'),
  ('shoe store',           'generic'),
  ('jewelry store',        'generic'),
  ('florist',              'generic'),
  ('gift shop',            'generic'),
  ('pet store',            'generic'),
  ('event venue',          'generic')
ON CONFLICT (category) DO NOTHING;

-- =====================================================================
-- RLS — deny-by-default, same posture as the rest of the coldcall module.
-- The Worker's service-role key is the only access path; the PUBLIC render
-- route reads through the Worker, never from the browser.
-- =====================================================================
ALTER TABLE public.coldcall_demo_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coldcall_hero_map   ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.coldcall_demo_sites FROM anon, authenticated;
REVOKE ALL ON public.coldcall_hero_map   FROM anon, authenticated;

-- == Verify (paste after applying) =============================================
-- Tables + columns:
--   SELECT table_name, column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_schema='public'
--      AND table_name IN ('coldcall_demo_sites','coldcall_hero_map')
--    ORDER BY table_name, ordinal_position;
--
-- Every category is mapped — expect 0 rows:
--   SELECT DISTINCT l.category
--     FROM public.coldcall_leads l
--     LEFT JOIN public.coldcall_hero_map m ON m.category = l.category
--    WHERE m.category IS NULL;
--
-- Folder spread — expect 9 trade folders + generic:
--   SELECT folder, count(*) FROM public.coldcall_hero_map GROUP BY 1 ORDER BY 2 DESC;
--
-- RLS on, zero policies (deny-by-default):
--   SELECT tablename, rowsecurity FROM pg_tables
--    WHERE schemaname='public' AND tablename LIKE 'coldcall_%';
--   SELECT tablename, policyname FROM pg_policies
--    WHERE schemaname='public' AND tablename IN ('coldcall_demo_sites','coldcall_hero_map');
