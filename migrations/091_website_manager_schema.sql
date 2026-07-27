-- =====================================================================
-- Migration 091: Website Manager Phase 1A — business facts + site schema
-- =====================================================================
-- Source: WEBSITE MANAGER — PHASE 1A (REVISED): BUSINESS FACTS + SCHEMA
--         (brief, 2026-07-27). Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: uses IF NOT EXISTS / DROP POLICY IF EXISTS / guarded enums.
-- =====================================================================
--
-- WHY THIS EXISTS
--
-- Recon (2026-07-27) established that 7 of the 8 fact classes a local-trade
-- website template needs exist NOWHERE in this database: phone, street address,
-- opening hours, license number, services, service areas, and review rating.
-- The only one present is key_differentiators (business_context, as a flat
-- string[]). `businesses` already carries ~30 denormalized landing-page columns
-- from `business-landing-page`; these facts do NOT go there.
--
-- PART A tables are the BUSINESS facts. They are business-level truth, not site
-- content. A site DERIVES from them. That ordering is what makes drift detection
-- a string comparison instead of a model call.
--
-- PART B tables are the SITE schema. Created here, written to in Phase 1B.
--
-- NOTHING in this migration renders, scores, charges tokens, or calls an LLM.
--
-- ---------------------------------------------------------------------
-- INFERRED SHAPES — read before applying
-- ---------------------------------------------------------------------
-- `docs/website-manager-concept.md` is NOT on disk in either repo (searched by
-- name and by pattern, both repos, 2026-07-27). PART A is fully specified by the
-- brief and is not inferred. In PART B, only these are specified by the brief:
--   * the seven table names
--   * site_fields provenance columns (source, source_path, context_snapshot,
--     alignment_status, alignment_checked_at, updated_by, updated_at)
--   * the source_path convention
-- Every OTHER column in PART B is inferred and marked `-- INFERRED` inline.
-- PART B holds no rows until Phase 1B, so correcting an inferred column is a
-- cheap ALTER. PART A and the site_fields provenance columns are the parts that
-- are expensive to retrofit, and neither is inferred.
-- =====================================================================


-- =====================================================================
-- SHARED ENUMS
-- =====================================================================

-- Provenance of a stored value. 'operator' = a human typed it (Phase 1A intake).
-- 'extracted' = pulled from the client's existing site (later phase).
-- 'derived'   = copied from a business fact via source_path (Phase 1B).
-- 'imported'  = bulk load / migration.
DO $$ BEGIN
  CREATE TYPE public.fact_source AS ENUM ('operator', 'extracted', 'derived', 'imported');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Does a site_field still match the business fact it derived from?
-- 'unchecked'  = never compared (default for a fresh row)
-- 'aligned'    = value == the fact at source_path
-- 'drifted'    = value != the fact at source_path
-- 'overridden' = intentionally diverged; drift is expected, do not flag
-- 'orphaned'   = source_path no longer resolves to anything
DO $$ BEGIN
  CREATE TYPE public.alignment_status AS ENUM
    ('unchecked', 'aligned', 'drifted', 'overridden', 'orphaned');
EXCEPTION WHEN duplicate_object THEN null;
END $$;


-- =====================================================================
-- PART A — BUSINESS FACTS  (written to in Phase 1A)
-- =====================================================================

-- ── A1. business_profile ─────────────────────────────────────────────
-- 1:1 with businesses. Everything LocalBusiness JSON-LD needs that is a
-- scalar, plus the brand/social/analytics handles.
--
-- Provenance is ROW-level here, not field-level: the brief specifies an explicit
-- column list (not EAV), so one `source` describes the row. Phase 1A intake is
-- form-first and writes source='operator' for the whole row, so row-level is
-- exact today. When extraction lands (later phase) and a row can mix operator
-- and extracted values, this needs to become per-field — flagged, not solved.
CREATE TABLE IF NOT EXISTS public.business_profile (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL UNIQUE
                        REFERENCES public.businesses(id) ON DELETE CASCADE,

  -- Identity
  legal_name          text,
  alternate_name      text,
  description         text,

  -- Contact
  phone               text,
  email               text,

  -- PostalAddress
  street_address      text,
  locality            text,
  region              text,
  postal_code         text,
  country             text,

  -- GeoCoordinates
  geo_lat             numeric(9,6),
  geo_lng             numeric(9,6),

  -- hasCredential
  license_number      text,
  license_authority   text,

  -- Review source + social. google_place_id is the ONLY sanctioned review
  -- source. textos-agent/CLAUDE.md prohibits AI-generated testimonials on FTC
  -- grounds ("refuse and implement the empty state"), so the reviews section
  -- renders empty until a real place_id is present here. There is deliberately
  -- no column to store review TEXT.
  google_place_id     text,
  google_business_url text,
  facebook_url        text,
  instagram_url       text,

  -- Analytics
  analytics_id        text,

  -- Brand media. FK targets site_media, which is business-scoped (see B6).
  logo_media_id       uuid,
  hero_media_id       uuid,

  -- Provenance
  source              public.fact_source NOT NULL DEFAULT 'operator',
  updated_by          uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT business_profile_geo_pair CHECK (
    (geo_lat IS NULL AND geo_lng IS NULL) OR (geo_lat IS NOT NULL AND geo_lng IS NOT NULL)
  ),
  CONSTRAINT business_profile_lat_range CHECK (geo_lat  IS NULL OR (geo_lat  BETWEEN  -90 AND  90)),
  CONSTRAINT business_profile_lng_range CHECK (geo_lng  IS NULL OR (geo_lng  BETWEEN -180 AND 180)),
  CONSTRAINT business_profile_country_len CHECK (country IS NULL OR char_length(country) BETWEEN 2 AND 2)
);

COMMENT ON TABLE  public.business_profile IS
  'Business-level facts for LocalBusiness structured data. A site derives from this; it is not site content.';
COMMENT ON COLUMN public.business_profile.country IS 'ISO 3166-1 alpha-2, e.g. US.';
COMMENT ON COLUMN public.business_profile.google_place_id IS
  'The only sanctioned review source. No review TEXT is ever stored or generated (FTC / textos-agent CLAUDE.md).';

CREATE INDEX IF NOT EXISTS business_profile_business_idx
  ON public.business_profile (business_id);


-- ── A2. business_hours ───────────────────────────────────────────────
-- Per-day structured rows, NOT a free-text string. LocalBusiness JSON-LD needs
-- openingHoursSpecification, which is per-day opens/closes.
--
-- day_of_week is 0=Sunday .. 6=Saturday, matching JS Date.getDay() so the
-- frontend renders without a lookup. One row per (business, day) — a day with
-- split hours (e.g. lunch close) is NOT representable and would need a second
-- row plus dropping the unique constraint. Flagged; not needed for trades-v1.
CREATE TABLE IF NOT EXISTS public.business_hours (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,

  day_of_week  smallint NOT NULL,
  opens        time,
  closes       time,
  is_closed    boolean NOT NULL DEFAULT false,

  source       public.fact_source NOT NULL DEFAULT 'operator',
  updated_by   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT business_hours_dow_range CHECK (day_of_week BETWEEN 0 AND 6),
  -- Open days need both ends; closed days must carry neither.
  CONSTRAINT business_hours_times_present CHECK (
    (is_closed = true  AND opens IS NULL AND closes IS NULL) OR
    (is_closed = false AND opens IS NOT NULL AND closes IS NOT NULL)
  ),
  CONSTRAINT business_hours_order CHECK (
    is_closed = true OR closes > opens
  )
);

COMMENT ON COLUMN public.business_hours.day_of_week IS '0=Sunday .. 6=Saturday (JS Date.getDay()).';

CREATE UNIQUE INDEX IF NOT EXISTS business_hours_business_dow_key
  ON public.business_hours (business_id, day_of_week);


-- ── A3. business_services ────────────────────────────────────────────
-- The services collection. `bullets` is text[] (an ordered list of short
-- strings) rather than jsonb — it is always a flat string list in the template.
CREATE TABLE IF NOT EXISTS public.business_services (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,

  service_key   text NOT NULL,
  name          text NOT NULL,
  blurb         text,
  body          text,
  bullets       text[] NOT NULL DEFAULT '{}',
  display_order integer NOT NULL DEFAULT 0,

  source        public.fact_source NOT NULL DEFAULT 'operator',
  updated_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- service_key is the anchor id and the source_path segment
  -- (services[repair].blurb) — must be url/anchor safe and non-empty.
  CONSTRAINT business_services_key_format CHECK (service_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT business_services_name_nonempty CHECK (char_length(btrim(name)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS business_services_business_key_key
  ON public.business_services (business_id, service_key);
CREATE INDEX IF NOT EXISTS business_services_business_order_idx
  ON public.business_services (business_id, display_order);


-- ── A4. business_service_areas ───────────────────────────────────────
-- The service_areas collection.
--
-- local_blurb and landmarks_blurb are REQUIRED and NON-DERIVABLE, enforced at
-- the schema level. Rationale from recon: the 10 JK Quality Electric area pages
-- are 92.5% word-identical after masking city / ZIP / parish names. Each page
-- carries only 17-26 genuinely unique tokens out of ~395 (~5%), and ALL of that
-- uniqueness lives in exactly these two strings. A generator that fills area
-- pages by city-name substitution produces doorway pages. NOT NULL + a
-- non-empty CHECK makes "we'll fill it in later" impossible rather than
-- discouraged.
CREATE TABLE IF NOT EXISTS public.business_service_areas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,

  area_slug       text NOT NULL,
  city            text NOT NULL,
  region          text,
  postal_code     text,
  geo_lat         numeric(9,6),
  geo_lng         numeric(9,6),

  local_blurb     text NOT NULL,
  landmarks_blurb text NOT NULL,

  display_order   integer NOT NULL DEFAULT 0,

  source          public.fact_source NOT NULL DEFAULT 'operator',
  updated_by      uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT business_service_areas_slug_format
    CHECK (area_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT business_service_areas_city_nonempty
    CHECK (char_length(btrim(city)) > 0),
  -- THE duplicate-content gate. Do not relax without re-reading the recon.
  CONSTRAINT business_service_areas_local_blurb_required
    CHECK (char_length(btrim(local_blurb)) > 0),
  CONSTRAINT business_service_areas_landmarks_blurb_required
    CHECK (char_length(btrim(landmarks_blurb)) > 0),
  CONSTRAINT business_service_areas_geo_pair CHECK (
    (geo_lat IS NULL AND geo_lng IS NULL) OR (geo_lat IS NOT NULL AND geo_lng IS NOT NULL)
  ),
  CONSTRAINT business_service_areas_lat_range CHECK (geo_lat IS NULL OR (geo_lat BETWEEN  -90 AND  90)),
  CONSTRAINT business_service_areas_lng_range CHECK (geo_lng IS NULL OR (geo_lng BETWEEN -180 AND 180))
);

COMMENT ON COLUMN public.business_service_areas.local_blurb IS
  'REQUIRED, NON-DERIVABLE. One of only two strings that differentiate area pages. See migration header.';
COMMENT ON COLUMN public.business_service_areas.landmarks_blurb IS
  'REQUIRED, NON-DERIVABLE. Local landmarks/corridors. The second differentiating string.';

CREATE UNIQUE INDEX IF NOT EXISTS business_service_areas_business_slug_key
  ON public.business_service_areas (business_id, area_slug);
CREATE INDEX IF NOT EXISTS business_service_areas_business_order_idx
  ON public.business_service_areas (business_id, display_order);


-- =====================================================================
-- PART B — SITE SCHEMA  (created now, written to in Phase 1B)
-- =====================================================================

-- ── B1. site_templates ───────────────────────────────────────────────
-- One row per template (trades-v1 seeded in migration 092). Global, not
-- business-scoped: every business renders through a shared template row, which
-- is what makes "fix the template once, every client site corrects" true.
CREATE TABLE IF NOT EXISTS public.site_templates (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key         text NOT NULL UNIQUE,               -- INFERRED
  name                 text NOT NULL,                      -- INFERRED
  vertical             text,                               -- INFERRED
  version              text NOT NULL DEFAULT '1',          -- INFERRED
  status               text NOT NULL DEFAULT 'draft',      -- INFERRED

  -- The section catalog: page types, ordered sections, per-section fields,
  -- placeholder tokens, structured-data plan. Seeded from the recon draft.
  section_catalog      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Per-field derivation: field_key -> source_path, or 'site-authored'.
  -- This is what Phase 1B reads to decide what to copy vs. what to ask for.
  field_derivation_map jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT site_templates_status_check
    CHECK (status IN ('draft', 'active', 'deprecated')),
  CONSTRAINT site_templates_key_format
    CHECK (template_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);


-- ── B2. sites ────────────────────────────────────────────────────────
-- One row per business site. business_id is NOT unique — a business may later
-- hold a draft and a published site, or an A/B variant.
CREATE TABLE IF NOT EXISTS public.sites (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  template_id    uuid NOT NULL REFERENCES public.site_templates(id) ON DELETE RESTRICT,

  slug           text NOT NULL,                            -- INFERRED
  name           text,                                     -- INFERRED
  status         text NOT NULL DEFAULT 'draft',            -- INFERRED
  -- Domains are OUT OF SCOPE this phase. Column exists so Phase 2 does not
  -- need a migration; nothing reads or writes it yet.
  primary_domain text,                                     -- INFERRED
  published_at   timestamptz,                              -- INFERRED

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sites_status_check
    CHECK (status IN ('draft', 'published', 'archived')),
  CONSTRAINT sites_slug_format
    CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

CREATE UNIQUE INDEX IF NOT EXISTS sites_slug_key ON public.sites (slug);
CREATE INDEX IF NOT EXISTS sites_business_idx  ON public.sites (business_id);


-- ── B3. site_pages ───────────────────────────────────────────────────
-- One row per rendered page. Repeatable page types (area_detail x10, legal x2)
-- get one row each, distinguished by instance_key — which for area_detail is
-- the business_service_areas.area_slug it derives from.
CREATE TABLE IF NOT EXISTS public.site_pages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id       uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,

  page_type     text NOT NULL,                             -- INFERRED
  instance_key  text,                                      -- INFERRED
  route_path    text NOT NULL,                             -- INFERRED
  title         text,                                      -- INFERRED
  display_order integer NOT NULL DEFAULT 0,                -- INFERRED
  status        text NOT NULL DEFAULT 'draft',             -- INFERRED
  noindex       boolean NOT NULL DEFAULT false,            -- INFERRED (legal pages)

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT site_pages_status_check
    CHECK (status IN ('draft', 'published', 'archived'))
);

COMMENT ON COLUMN public.site_pages.instance_key IS
  'NULL for singleton pages. For area_detail this is business_service_areas.area_slug.';

-- One page per (site, page_type, instance). COALESCE so singletons collide on
-- page_type alone while repeatables key on their instance.
CREATE UNIQUE INDEX IF NOT EXISTS site_pages_site_type_instance_key
  ON public.site_pages (site_id, page_type, COALESCE(instance_key, ''));
CREATE INDEX IF NOT EXISTS site_pages_site_order_idx
  ON public.site_pages (site_id, display_order);


-- ── B4. site_sections ────────────────────────────────────────────────
-- Ordered sections within a page. section_key matches the catalog.
CREATE TABLE IF NOT EXISTS public.site_sections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id       uuid NOT NULL REFERENCES public.site_pages(id) ON DELETE CASCADE,

  section_key   text NOT NULL,                             -- INFERRED
  variant       text,                                      -- INFERRED
  display_order integer NOT NULL DEFAULT 0,                -- INFERRED
  is_enabled    boolean NOT NULL DEFAULT true,             -- INFERRED

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS site_sections_page_key_key
  ON public.site_sections (page_id, section_key);
CREATE INDEX IF NOT EXISTS site_sections_page_order_idx
  ON public.site_sections (page_id, display_order);


-- ── B5. site_fields ──────────────────────────────────────────────────
-- The leaf content store, and the reason this migration exists now rather than
-- later. Provenance here is NOT inferred — it is specified by the brief, and it
-- is unusable to retrofit: any field written before these columns exist is
-- permanently unknown.
--
-- source_path is the string address of the business fact this field derived
-- from, so drift detection is a string comparison and not a model call:
--     profile.phone
--     profile.hours
--     services[repair].blurb
--     areas[kenner-la].local_blurb
-- NULL source_path means site-authored (hero copy, positioning, page prose) —
-- there is nothing to align it against, and it is never flagged as drifted.
--
-- context_snapshot stores the business-fact value AS IT WAS when this field was
-- last written. Drift = (value_text IS DISTINCT FROM current fact at source_path),
-- and context_snapshot is what lets the UI show "was X, now Y" without a history
-- table.
CREATE TABLE IF NOT EXISTS public.site_fields (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id           uuid NOT NULL REFERENCES public.site_sections(id) ON DELETE CASCADE,

  field_key            text NOT NULL,                      -- INFERRED
  -- Scalars in value_text; lists/objects in value_json. Exactly one is set.
  value_text           text,                               -- INFERRED
  value_json           jsonb,                              -- INFERRED
  display_order        integer NOT NULL DEFAULT 0,         -- INFERRED

  -- ── Provenance (SPECIFIED, not inferred) ──
  source               public.fact_source NOT NULL DEFAULT 'operator',
  source_path          text,
  context_snapshot     text,
  alignment_status     public.alignment_status NOT NULL DEFAULT 'unchecked',
  alignment_checked_at timestamptz,
  updated_by           uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),

  created_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT site_fields_one_value CHECK (
    (value_text IS NOT NULL AND value_json IS NULL) OR
    (value_text IS NULL AND value_json IS NOT NULL) OR
    (value_text IS NULL AND value_json IS NULL)
  ),
  -- A site-authored field has no source to align against.
  CONSTRAINT site_fields_authored_not_aligned CHECK (
    source_path IS NOT NULL OR alignment_status IN ('unchecked', 'overridden')
  )
);

COMMENT ON COLUMN public.site_fields.source_path IS
  'Dotted address of the derived-from business fact: profile.phone | services[repair].blurb | areas[kenner-la].local_blurb. NULL = site-authored.';
COMMENT ON COLUMN public.site_fields.context_snapshot IS
  'The business-fact value at the moment this field was last written. Enables was/now drift display without a history table.';

CREATE UNIQUE INDEX IF NOT EXISTS site_fields_section_key_key
  ON public.site_fields (section_id, field_key);
-- Drift sweep reads by source_path and by status; both are hot.
CREATE INDEX IF NOT EXISTS site_fields_source_path_idx
  ON public.site_fields (source_path) WHERE source_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS site_fields_alignment_idx
  ON public.site_fields (alignment_status) WHERE alignment_status = 'drifted';


-- ── B6. site_media ───────────────────────────────────────────────────
-- BUSINESS-scoped, not site-scoped, with an optional site_id.
--
-- Deviation from the table name, deliberate: business_profile.logo_media_id and
-- hero_media_id are BUSINESS facts per this brief's own correction ("the facts
-- are BUSINESS data, not site data; a site DERIVES from them"). A logo cannot
-- live in a site-scoped table and also be a business fact — a business must be
-- able to hold a logo before any site exists. So business_id is NOT NULL and
-- site_id is nullable: business-level media (logo, hero) carry a NULL site_id;
-- media that belongs to one specific site carries both.
CREATE TABLE IF NOT EXISTS public.site_media (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  site_id     uuid REFERENCES public.sites(id) ON DELETE CASCADE,

  media_key   text,                                        -- INFERRED
  url         text NOT NULL,                               -- INFERRED
  alt_text    text,                                        -- INFERRED
  mime_type   text,                                        -- INFERRED
  width       integer,                                     -- INFERRED
  height      integer,                                     -- INFERRED
  r2_key      text,                                        -- INFERRED

  source      public.fact_source NOT NULL DEFAULT 'operator',
  updated_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT site_media_url_nonempty CHECK (char_length(btrim(url)) > 0)
);

CREATE INDEX IF NOT EXISTS site_media_business_idx ON public.site_media (business_id);
CREATE INDEX IF NOT EXISTS site_media_site_idx     ON public.site_media (site_id) WHERE site_id IS NOT NULL;

-- business_profile media FKs, added after site_media exists.
DO $$ BEGIN
  ALTER TABLE public.business_profile
    ADD CONSTRAINT business_profile_logo_media_fk
    FOREIGN KEY (logo_media_id) REFERENCES public.site_media(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE public.business_profile
    ADD CONSTRAINT business_profile_hero_media_fk
    FOREIGN KEY (hero_media_id) REFERENCES public.site_media(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null;
END $$;


-- ── B7. site_integrations ────────────────────────────────────────────
-- Per-site third-party wiring. OUT OF SCOPE this phase — no provider is
-- implemented, nothing reads this table. It exists so Phase 2 does not need a
-- migration. Deliberately NOT seeded.
CREATE TABLE IF NOT EXISTS public.site_integrations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id    uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,

  provider   text NOT NULL,                                -- INFERRED
  config     jsonb NOT NULL DEFAULT '{}'::jsonb,           -- INFERRED
  is_active  boolean NOT NULL DEFAULT false,               -- INFERRED

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT site_integrations_provider_nonempty
    CHECK (char_length(btrim(provider)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS site_integrations_site_provider_key
  ON public.site_integrations (site_id, provider);


-- =====================================================================
-- RLS — owner-scoped SELECT on every business-visible table.
-- The Worker uses the service-role key and bypasses these by design; the
-- frontend reads with anon key + JWT as `authenticated`.
-- Pattern matches 074_content_pillars.sql.
-- =====================================================================

ALTER TABLE public.business_profile      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_hours        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_services     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_service_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sites                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_pages            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_sections         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_fields           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_media            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_integrations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_templates        ENABLE ROW LEVEL SECURITY;

-- Business-scoped (direct business_id)
DROP POLICY IF EXISTS "owner_select_business_profile" ON public.business_profile;
CREATE POLICY "owner_select_business_profile" ON public.business_profile
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM public.businesses WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "owner_select_business_hours" ON public.business_hours;
CREATE POLICY "owner_select_business_hours" ON public.business_hours
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM public.businesses WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "owner_select_business_services" ON public.business_services;
CREATE POLICY "owner_select_business_services" ON public.business_services
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM public.businesses WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "owner_select_business_service_areas" ON public.business_service_areas;
CREATE POLICY "owner_select_business_service_areas" ON public.business_service_areas
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM public.businesses WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "owner_select_sites" ON public.sites;
CREATE POLICY "owner_select_sites" ON public.sites
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM public.businesses WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "owner_select_site_media" ON public.site_media;
CREATE POLICY "owner_select_site_media" ON public.site_media
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM public.businesses WHERE user_id = auth.uid()));

-- Site-scoped (reached through sites)
DROP POLICY IF EXISTS "owner_select_site_pages" ON public.site_pages;
CREATE POLICY "owner_select_site_pages" ON public.site_pages
  FOR SELECT TO authenticated
  USING (site_id IN (
    SELECT s.id FROM public.sites s
    JOIN public.businesses b ON b.id = s.business_id
    WHERE b.user_id = auth.uid()));

DROP POLICY IF EXISTS "owner_select_site_integrations" ON public.site_integrations;
CREATE POLICY "owner_select_site_integrations" ON public.site_integrations
  FOR SELECT TO authenticated
  USING (site_id IN (
    SELECT s.id FROM public.sites s
    JOIN public.businesses b ON b.id = s.business_id
    WHERE b.user_id = auth.uid()));

-- Page-scoped
DROP POLICY IF EXISTS "owner_select_site_sections" ON public.site_sections;
CREATE POLICY "owner_select_site_sections" ON public.site_sections
  FOR SELECT TO authenticated
  USING (page_id IN (
    SELECT p.id FROM public.site_pages p
    JOIN public.sites s     ON s.id = p.site_id
    JOIN public.businesses b ON b.id = s.business_id
    WHERE b.user_id = auth.uid()));

-- Section-scoped
DROP POLICY IF EXISTS "owner_select_site_fields" ON public.site_fields;
CREATE POLICY "owner_select_site_fields" ON public.site_fields
  FOR SELECT TO authenticated
  USING (section_id IN (
    SELECT sec.id FROM public.site_sections sec
    JOIN public.site_pages p ON p.id = sec.page_id
    JOIN public.sites s      ON s.id = p.site_id
    JOIN public.businesses b ON b.id = s.business_id
    WHERE b.user_id = auth.uid()));

-- Templates are global reference data — readable by any authenticated user
-- (same pattern as pillar_templates in 074).
DROP POLICY IF EXISTS "site_templates_read" ON public.site_templates;
CREATE POLICY "site_templates_read" ON public.site_templates
  FOR SELECT TO authenticated USING (true);


-- =====================================================================
-- Verification (paste after applying)
-- =====================================================================
--
-- 1. All 11 tables exist:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema='public' AND table_name IN (
--     'business_profile','business_hours','business_services','business_service_areas',
--     'site_templates','sites','site_pages','site_sections','site_fields',
--     'site_media','site_integrations')
--   ORDER BY table_name;
--   -- expect 11 rows
--
-- 2. RLS on every one of them:
--   SELECT tablename, rowsecurity FROM pg_tables
--   WHERE schemaname='public' AND tablename IN (
--     'business_profile','business_hours','business_services','business_service_areas',
--     'site_templates','sites','site_pages','site_sections','site_fields',
--     'site_media','site_integrations')
--   ORDER BY tablename;
--   -- expect rowsecurity = true for all 11
--
-- 3. A SELECT policy exists for each:
--   SELECT tablename, policyname, cmd FROM pg_policies
--   WHERE schemaname='public' AND tablename LIKE ANY (ARRAY['business\_%','site%'])
--   ORDER BY tablename;
--   -- expect 11 rows, cmd = SELECT
--
-- 4. Both enums:
--   SELECT enum_range(NULL::public.fact_source);
--   -- expect {operator,extracted,derived,imported}
--   SELECT enum_range(NULL::public.alignment_status);
--   -- expect {unchecked,aligned,drifted,overridden,orphaned}
--
-- 5. site_fields carries all seven provenance columns:
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name='site_fields' AND column_name IN (
--     'source','source_path','context_snapshot','alignment_status',
--     'alignment_checked_at','updated_by','updated_at')
--   ORDER BY column_name;
--   -- expect 7 rows
--
-- 6. The two non-derivable area blurbs are NOT NULL and CHECKed:
--   SELECT column_name, is_nullable FROM information_schema.columns
--   WHERE table_name='business_service_areas'
--     AND column_name IN ('local_blurb','landmarks_blurb');
--   -- expect is_nullable = NO for both
--   SELECT conname FROM pg_constraint
--   WHERE conrelid='public.business_service_areas'::regclass AND contype='c'
--   ORDER BY conname;
--   -- expect ..._local_blurb_required and ..._landmarks_blurb_required present
--
-- 7. The blurb CHECK actually rejects blank (should ERROR, not insert):
--   -- INSERT INTO public.business_service_areas
--   --   (business_id, area_slug, city, local_blurb, landmarks_blurb)
--   -- VALUES ('00000000-0000-0000-0000-000000000000','x','X','   ','ok');
--   -- expect: new row violates check constraint "..._local_blurb_required"
--
-- 8. Hours uniqueness + closed-day rule:
--   SELECT indexname FROM pg_indexes
--   WHERE tablename='business_hours' AND indexname='business_hours_business_dow_key';
--   -- expect 1 row
--
-- 9. No rows anywhere yet (Phase 1A writes only via the intake surface):
--   SELECT 'business_profile' t, count(*) FROM public.business_profile
--   UNION ALL SELECT 'business_hours',        count(*) FROM public.business_hours
--   UNION ALL SELECT 'business_services',     count(*) FROM public.business_services
--   UNION ALL SELECT 'business_service_areas',count(*) FROM public.business_service_areas
--   UNION ALL SELECT 'site_templates',        count(*) FROM public.site_templates;
--   -- expect 0 for all until intake is used; site_templates = 1 after 092
-- =====================================================================
