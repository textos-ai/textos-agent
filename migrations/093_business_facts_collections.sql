-- =====================================================================
-- Migration 093: business_faqs, business_projects, business_differentiators
-- =====================================================================
-- Source: WEBSITE MANAGER — PHASE 1C, PART A (brief, 2026-07-29). Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Requires: migration 091 (fact_source enum, businesses, site_media).
-- Safe to re-run: IF NOT EXISTS / DROP POLICY IF EXISTS throughout.
-- =====================================================================
--
-- WHY
--
-- trades-v1 declares 7 collections. Two shipped in 091 (services,
-- service_areas). Two need no storage: `reviews` derives from
-- business_profile.google_place_id and its text is never stored or generated
-- (FTC / textos-agent CLAUDE.md), and `nav_links` derives from page structure.
-- The remaining three had nowhere to live. This is that storage.
--
-- These are BUSINESS facts, not site content — the same FAQ answer is true on
-- any site the business publishes, and a completed job happened regardless of
-- what is published. Same posture as business_services / business_service_areas:
-- row-level provenance, RLS, business-scoped, ON DELETE CASCADE.
--
-- DELIBERATELY NOT REUSING businesses.why_us. It is already [{headline, body}],
-- but business-landing-page WRITES it on every rebuild, so operator-authored
-- differentiators stored there would be silently clobbered. Trades
-- differentiators are operator-authored and get their own table.
-- =====================================================================


-- ── 1. business_faqs ─────────────────────────────────────────────────
-- scope decides where an FAQ surfaces:
--   'global'      — the standalone FAQ page (9 items in the source template)
--   'home_teaser' — the 4-item accordion on the home page
--   'area'        — the 3-item accordion on an area page (Phase 2)
CREATE TABLE IF NOT EXISTS public.business_faqs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,

  question      text NOT NULL,
  answer        text NOT NULL,
  scope         text NOT NULL DEFAULT 'global',
  display_order integer NOT NULL DEFAULT 0,

  source        public.fact_source NOT NULL DEFAULT 'operator',
  updated_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT business_faqs_question_nonempty CHECK (char_length(btrim(question)) > 0),
  CONSTRAINT business_faqs_answer_nonempty   CHECK (char_length(btrim(answer))   > 0),
  CONSTRAINT business_faqs_scope_check       CHECK (scope IN ('global','home_teaser','area'))
);

CREATE INDEX IF NOT EXISTS business_faqs_business_scope_order_idx
  ON public.business_faqs (business_id, scope, display_order);


-- ── 2. business_projects ─────────────────────────────────────────────
-- Completed work. media_id is nullable: a caption-only project is a legitimate
-- half-entered state, and the gallery simply omits the tile until an image
-- exists. service_key is a soft FK — (business_id, service_key) references
-- business_services, declared below so deleting a service nulls the link rather
-- than deleting the project record of work that actually happened.
CREATE TABLE IF NOT EXISTS public.business_projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,

  caption       text NOT NULL,
  city          text,
  service_key   text,
  media_id      uuid REFERENCES public.site_media(id) ON DELETE SET NULL,
  display_order integer NOT NULL DEFAULT 0,

  source        public.fact_source NOT NULL DEFAULT 'operator',
  updated_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT business_projects_caption_nonempty CHECK (char_length(btrim(caption)) > 0),
  CONSTRAINT business_projects_service_key_format
    CHECK (service_key IS NULL OR service_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

CREATE INDEX IF NOT EXISTS business_projects_business_order_idx
  ON public.business_projects (business_id, display_order);
CREATE INDEX IF NOT EXISTS business_projects_media_idx
  ON public.business_projects (media_id) WHERE media_id IS NOT NULL;

-- Composite FK to business_services. Needs the unique index created in 091
-- (business_services_business_key_key on (business_id, service_key)).
DO $$ BEGIN
  ALTER TABLE public.business_projects
    ADD CONSTRAINT business_projects_service_fk
    FOREIGN KEY (business_id, service_key)
    REFERENCES public.business_services (business_id, service_key)
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
  -- If the referenced unique index is absent the FK cannot be created; the
  -- CHECK above still guards format, and the app validates membership.
  WHEN others THEN RAISE NOTICE 'business_projects_service_fk not added: %', SQLERRM;
END $$;


-- ── 3. business_differentiators ──────────────────────────────────────
-- Operator-authored "why us" pillars. headline + body are both required — a
-- headline with no body renders as a bare claim with nothing behind it.
CREATE TABLE IF NOT EXISTS public.business_differentiators (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,

  headline      text NOT NULL,
  body          text NOT NULL,
  icon          text,
  display_order integer NOT NULL DEFAULT 0,

  source        public.fact_source NOT NULL DEFAULT 'operator',
  updated_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT business_differentiators_headline_nonempty CHECK (char_length(btrim(headline)) > 0),
  CONSTRAINT business_differentiators_body_nonempty     CHECK (char_length(btrim(body))     > 0)
);

CREATE INDEX IF NOT EXISTS business_differentiators_business_order_idx
  ON public.business_differentiators (business_id, display_order);


-- ── 4. site_media additions (PART B) ─────────────────────────────────
-- 091 created site_media with url/alt_text/mime_type/width/height/r2_key.
-- 1C needs: a role, an origin, a byte size, and video support (poster frame +
-- required text alternative).
ALTER TABLE public.site_media ADD COLUMN IF NOT EXISTS role        text;
ALTER TABLE public.site_media ADD COLUMN IF NOT EXISTS origin      text NOT NULL DEFAULT 'uploaded';
ALTER TABLE public.site_media ADD COLUMN IF NOT EXISTS bytes       bigint;
ALTER TABLE public.site_media ADD COLUMN IF NOT EXISTS kind        text NOT NULL DEFAULT 'image';
ALTER TABLE public.site_media ADD COLUMN IF NOT EXISTS poster_url  text;
ALTER TABLE public.site_media ADD COLUMN IF NOT EXISTS duration_ms integer;

DO $$ BEGIN
  ALTER TABLE public.site_media ADD CONSTRAINT site_media_role_check
    CHECK (role IS NULL OR role IN ('logo','hero','gallery','og','background'));
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  -- 'generated' is reserved for fal.ai output (later phase); nothing writes it yet.
  ALTER TABLE public.site_media ADD CONSTRAINT site_media_origin_check
    CHECK (origin IN ('uploaded','generated','imported'));
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE public.site_media ADD CONSTRAINT site_media_kind_check
    CHECK (kind IN ('image','video'));
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ALT TEXT IS REQUIRED on every image, and video needs a text alternative too.
-- Enforced as a CHECK rather than NOT NULL so the column can stay nullable for
-- any pre-existing row; in practice site_media is empty, so this bites from the
-- first insert onward.
DO $$ BEGIN
  ALTER TABLE public.site_media ADD CONSTRAINT site_media_alt_required
    CHECK (char_length(btrim(coalesce(alt_text,''))) > 0);
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- A video needs a poster frame — without it there is nothing to paint before
-- the first frame decodes, and nothing at all if autoplay is blocked.
DO $$ BEGIN
  ALTER TABLE public.site_media ADD CONSTRAINT site_media_video_poster
    CHECK (kind <> 'video' OR poster_url IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS site_media_business_role_idx
  ON public.site_media (business_id, role);

COMMENT ON COLUMN public.site_media.role   IS 'logo | hero | gallery | og | background. NULL = unassigned upload.';
COMMENT ON COLUMN public.site_media.origin IS 'uploaded | generated | imported. generated is reserved for fal.ai output.';
COMMENT ON COLUMN public.site_media.bytes  IS 'File size at upload. A readiness rule needs it (OG images have a required size).';


-- =====================================================================
-- RLS — owner-scoped SELECT, same pattern as 091.
-- =====================================================================
ALTER TABLE public.business_faqs             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_projects         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_differentiators  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_select_business_faqs" ON public.business_faqs;
CREATE POLICY "owner_select_business_faqs" ON public.business_faqs
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM public.businesses WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "owner_select_business_projects" ON public.business_projects;
CREATE POLICY "owner_select_business_projects" ON public.business_projects
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM public.businesses WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "owner_select_business_differentiators" ON public.business_differentiators;
CREATE POLICY "owner_select_business_differentiators" ON public.business_differentiators
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM public.businesses WHERE user_id = auth.uid()));


-- =====================================================================
-- Verification (paste after applying)
-- =====================================================================
--
-- 1. Three tables exist:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema='public'
--     AND table_name IN ('business_faqs','business_projects','business_differentiators')
--   ORDER BY table_name;
--   -- expect 3 rows
--
-- 2. RLS on all three:
--   SELECT tablename, rowsecurity FROM pg_tables
--   WHERE schemaname='public'
--     AND tablename IN ('business_faqs','business_projects','business_differentiators');
--   -- expect rowsecurity = true for all 3
--
-- 3. site_media gained the 1C columns:
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name='site_media'
--     AND column_name IN ('role','origin','bytes','kind','poster_url','duration_ms')
--   ORDER BY column_name;
--   -- expect 6 rows; origin default 'uploaded', kind default 'image'
--
-- 4. Alt text is enforced (should ERROR, not insert):
--   -- INSERT INTO public.site_media (business_id, url, alt_text)
--   -- VALUES ('869d2d0b-1a9f-4fd8-9380-d4c6a48ec5dc','https://x/y.jpg','   ');
--   -- expect: violates check constraint "site_media_alt_required"
--
-- 5. Video requires a poster (should ERROR):
--   -- INSERT INTO public.site_media (business_id, url, alt_text, kind)
--   -- VALUES ('869d2d0b-1a9f-4fd8-9380-d4c6a48ec5dc','https://x/y.mp4','Hero clip','video');
--   -- expect: violates check constraint "site_media_video_poster"
--
-- 6. FAQ scope is constrained (should ERROR):
--   -- INSERT INTO public.business_faqs (business_id, question, answer, scope)
--   -- VALUES ('869d2d0b-1a9f-4fd8-9380-d4c6a48ec5dc','Q','A','nonsense');
--   -- expect: violates check constraint "business_faqs_scope_check"
--
-- 7. Composite FK to business_services was created (may be absent — see the
--    RAISE NOTICE in the DO block if the unique index was missing):
--   SELECT conname FROM pg_constraint
--   WHERE conrelid='public.business_projects'::regclass AND contype='f'
--   ORDER BY conname;
--   -- expect business_projects_service_fk among the rows
--
-- 8. Row counts (all zero until the Facts page is used):
--   SELECT 'faqs' t, count(*) FROM public.business_faqs
--   UNION ALL SELECT 'projects',        count(*) FROM public.business_projects
--   UNION ALL SELECT 'differentiators', count(*) FROM public.business_differentiators
--   UNION ALL SELECT 'site_media',      count(*) FROM public.site_media;
-- =====================================================================
