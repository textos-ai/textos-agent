-- =====================================================================
-- Migration 113: provider registry + per-site integration config
-- =====================================================================
-- Source: Website Manager Phase 3A brief, 2026-07-31 (Parts A and B)
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: IF NOT EXISTS throughout; the seed uses ON CONFLICT DO
--   UPDATE; the backfill is scoped and idempotent.
-- =====================================================================
--
-- WHAT THIS IS FOR
--
-- site_integrations shipped in 091 and has never held a row. This is what it
-- was designed for, plus the piece 091 lacked: a place to DEFINE a provider.
--
-- ADDING A PROVIDER MUST NOT REQUIRE A DEPLOY. Everything that varies between
-- Housecall Pro, ElevenLabs, GA4 and whatever comes next is data in
-- site_integration_providers: the markup shape, where it goes on the page, which
-- fields the operator fills, and what each of those fields must look like. The
-- Worker composes; it knows nothing about any particular vendor.
--
-- OPERATORS SUPPLY VALUES, NEVER MARKUP. embed_template is admin-authored and is
-- the only place HTML is written. Operator input is pattern-validated against the
-- field's own regex and escaped into the template. There is deliberately no
-- raw-HTML provider at any tier: an unvalidated "agent ID" box is just a smaller
-- injection surface than a textarea, and this is a licensed contractor's public
-- site.
--
-- NOTE ON 091: its site_integrations columns are annotated "-- INFERRED",
-- meaning that file was partly reconstructed from the live database rather than
-- being what built it. The live table was PROBED before writing this, not read
-- from the file. Confirmed present: id, site_id, provider, config, is_active,
-- created_at, updated_at. Confirmed absent: status, last_verified_at.

-- ── 1. The registry ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.site_integration_providers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Stable identifier. site_integrations.provider references this.
  provider_key   text NOT NULL UNIQUE,
  display_name   text NOT NULL,

  -- OPEN-ENDED, NOT AN ENUM. chat/booking/voice/analytics are what is needed
  -- today; trades sites also carry call tracking and financing widgets, and a
  -- new category must not need a migration. Constrained only to be non-empty
  -- and slug-shaped so the manager can group on it reliably.
  category       text NOT NULL,

  -- Mustache. {{field_key}} placeholders are filled from the operator's config,
  -- HTML-escaped. The ONLY markup in this feature.
  embed_template text NOT NULL,

  -- head        — needs to run early (analytics)
  -- body_end    — the default; scripts and custom elements alike. A custom
  --               element and its defining script can both sit here, because
  --               elements upgrade whenever the script defines them, so order
  --               does not matter.
  -- inline_mount— rendered into the chat_widget mount point already on the page
  placement      text NOT NULL DEFAULT 'body_end'
                 CHECK (placement IN ('head', 'body_end', 'inline_mount')),

  -- [{ key, label, help, pattern, required, placeholder }]
  -- EVERY field carries a validation pattern. Enforced in the admin route, which
  -- rejects a field without one — see the fields_is_array check below for the
  -- shape guarantee SQL can give.
  fields         jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Which screen corner the widget occupies, when it occupies one. Null for
  -- anything with no visible furniture (analytics). Two ACTIVE integrations
  -- claiming the same corner is a real collision — two chat bubbles fighting
  -- over bottom-right — and the manager warns on it.
  position       text
                 CHECK (position IS NULL OR position IN (
                   'bottom-right', 'bottom-left', 'top-right', 'top-left', 'fullscreen')),

  -- Recorded, not enforced. There is no consent surface in this stack yet, and a
  -- flag that gates nothing must not read as a promise the code keeps.
  requires_consent boolean NOT NULL DEFAULT false,

  -- Hosts this provider contacts, for a future CSP. Collected now because it is
  -- known at definition time and impossible to reconstruct later.
  provider_domains text[] NOT NULL DEFAULT '{}',

  docs_url       text,
  active         boolean NOT NULL DEFAULT true,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT provider_key_slug
    CHECK (provider_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT category_slug
    CHECK (category ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT display_name_nonempty
    CHECK (char_length(btrim(display_name)) > 0),
  CONSTRAINT embed_template_nonempty
    CHECK (char_length(btrim(embed_template)) > 0),
  CONSTRAINT fields_is_array
    CHECK (jsonb_typeof(fields) = 'array')
);

CREATE INDEX IF NOT EXISTS site_integration_providers_active_category
  ON public.site_integration_providers (active, category);

ALTER TABLE public.site_integration_providers ENABLE ROW LEVEL SECURITY;

-- Any signed-in operator may READ the active catalogue — the manager lists
-- providers to choose from. Writes are admin-only and go through the Worker's
-- service-role key, so no INSERT/UPDATE/DELETE policy is granted here.
DROP POLICY IF EXISTS "authenticated_read_active_providers" ON public.site_integration_providers;
CREATE POLICY "authenticated_read_active_providers" ON public.site_integration_providers
  FOR SELECT TO authenticated
  USING (active);

-- ── 2. Per-site config: the two columns 091 lacked ────────────────────
--
-- STATUS IS NEVER OPTIMISTIC. A saved config is 'unverified', not 'connected' —
-- an operator pasting an ID proves only that they pasted something. It becomes
-- 'connected' when the integration has actually loaded on the site and reported
-- back, and never before.
ALTER TABLE public.site_integrations
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'unverified';

ALTER TABLE public.site_integrations
  ADD COLUMN IF NOT EXISTS last_verified_at timestamptz;

DO $$ BEGIN
  ALTER TABLE public.site_integrations
    ADD CONSTRAINT site_integrations_status_known
    CHECK (status IN ('unverified', 'connected', 'error', 'disabled'));
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- provider must name a real provider. Zero rows exist today, so this cannot
-- fail on legacy data. RESTRICT, not CASCADE: deleting a provider that sites are
-- using should be refused, not silently take their widgets away.
DO $$ BEGIN
  ALTER TABLE public.site_integrations
    ADD CONSTRAINT site_integrations_provider_fk
    FOREIGN KEY (provider)
    REFERENCES public.site_integration_providers (provider_key)
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
  WHEN others THEN RAISE NOTICE 'site_integrations_provider_fk not added: %', SQLERRM;
END $$;

-- ── 3. Seed: the two providers whose embed shape is verifiable ────────
--
-- GA4 and ElevenLabs only. Housecall Pro's chat and booking snippets are NOT
-- seeded because I could not verify their current embed markup, and inventing a
-- script URL for a licensed contractor's site is exactly the failure this
-- registry exists to make unnecessary — Rob adds them from the admin screen with
-- no deploy, which is the whole point of Part A.
--
-- GOOGLE TAG MANAGER IS DELIBERATELY ABSENT. A container ID delegates arbitrary
-- script execution on a client's public site to whoever holds the GTM account.
-- That is a decision for Rob to take explicitly, not something that should
-- arrive as a default. Recorded here so nobody adds it casually later.
INSERT INTO public.site_integration_providers
  (provider_key, display_name, category, embed_template, placement, fields,
   position, requires_consent, provider_domains, docs_url, active)
VALUES
  (
    'ga4',
    'Google Analytics 4',
    'analytics',
    '<script async src="https://www.googletagmanager.com/gtag/js?id={{measurement_id}}"></script>' ||
    '<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}' ||
    'gtag(''js'',new Date());gtag(''config'',''{{measurement_id}}'');</script>',
    'head',
    '[{"key":"measurement_id","label":"Measurement ID","help":"From Google Analytics: Admin, then Data Streams. It starts with G-.","pattern":"^G-[A-Z0-9]{4,20}$","required":true,"placeholder":"G-XXXXXXXXXX"}]'::jsonb,
    NULL,
    true,
    ARRAY['www.googletagmanager.com', 'www.google-analytics.com'],
    'https://support.google.com/analytics/answer/9539598',
    true
  ),
  (
    'elevenlabs-convai',
    'ElevenLabs Voice Agent',
    'voice',
    '<elevenlabs-convai agent-id="{{agent_id}}"></elevenlabs-convai>' ||
    '<script src="https://unpkg.com/@elevenlabs/convai-widget-embed" async></script>',
    'body_end',
    '[{"key":"agent_id","label":"Agent ID","help":"From the ElevenLabs dashboard, on the agent you want answering calls.","pattern":"^[A-Za-z0-9_-]{8,64}$","required":true,"placeholder":"agent_xxxxxxxxxxxxxxxx"}]'::jsonb,
    'bottom-right',
    true,
    ARRAY['unpkg.com', 'api.elevenlabs.io', 'elevenlabs.io'],
    'https://elevenlabs.io/docs/conversational-ai/widget',
    true
  )
ON CONFLICT (provider_key) DO UPDATE SET
  display_name     = EXCLUDED.display_name,
  category         = EXCLUDED.category,
  embed_template   = EXCLUDED.embed_template,
  placement        = EXCLUDED.placement,
  fields           = EXCLUDED.fields,
  position         = EXCLUDED.position,
  requires_consent = EXCLUDED.requires_consent,
  provider_domains = EXCLUDED.provider_domains,
  docs_url         = EXCLUDED.docs_url,
  updated_at       = now();

-- ── 4. Backfill the orphaned business_profile.analytics_id ────────────
--
-- That column has a write path (the Facts form) and NO consumer anywhere — an
-- operator could type a GA4 ID and it went nowhere. It is a SITE setting, not a
-- business fact, so it moves to the GA4 provider's config rather than gaining a
-- reader where it sits.
--
-- Only values that actually look like a GA4 measurement ID are carried over, and
-- only for businesses that have a site. Anything else is left in place for
-- migration 114 to report before the column is dropped.
INSERT INTO public.site_integrations (site_id, provider, config, is_active, status)
SELECT s.id,
       'ga4',
       jsonb_build_object('measurement_id', btrim(p.analytics_id)),
       true,
       'unverified'
FROM public.business_profile p
JOIN public.sites s ON s.business_id = p.business_id
WHERE p.analytics_id IS NOT NULL
  AND btrim(p.analytics_id) ~ '^G-[A-Z0-9]{4,20}$'
ON CONFLICT (site_id, provider) DO NOTHING;

-- ── Verification ─────────────────────────────────────────────────────
--
-- Registry exists with both seeds:
--   SELECT provider_key, category, placement, position, active
--   FROM public.site_integration_providers ORDER BY provider_key;
--   -- expect elevenlabs-convai (voice, body_end, bottom-right) and ga4
--   --        (analytics, head, NULL)
--
-- Every seeded field carries a validation pattern:
--   SELECT provider_key, f->>'key' AS field, (f->>'pattern') IS NOT NULL AS has_pattern
--   FROM public.site_integration_providers p, jsonb_array_elements(p.fields) f;
--   -- expect has_pattern = true for every row
--
-- site_integrations gained both columns and the FK:
--   SELECT column_name, data_type, column_default FROM information_schema.columns
--   WHERE table_name='site_integrations' AND column_name IN ('status','last_verified_at');
--   -- expect 2 rows, status default 'unverified'
--   SELECT conname FROM pg_constraint WHERE conname='site_integrations_provider_fk';
--   -- expect 1 row
--
-- What the backfill moved, and what it could not:
--   SELECT count(*) FROM public.site_integrations WHERE provider='ga4';
--   SELECT b.slug, p.analytics_id FROM public.business_profile p
--   JOIN public.businesses b ON b.id = p.business_id
--   WHERE p.analytics_id IS NOT NULL
--     AND btrim(p.analytics_id) !~ '^G-[A-Z0-9]{4,20}$';
--   -- the second query lists values NOT carried over. Expect 0 rows; anything
--   -- here must be looked at before applying 114, which drops the column.
