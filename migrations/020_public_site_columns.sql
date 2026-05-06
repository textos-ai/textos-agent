-- Migration 020: Public Site V1 columns on businesses
-- Three groups:
--   1. Agent-derived (filled by personal-landing-page task at free-build time)
--   2. User overrides (filled via /business/{slug}/settings page)
--   3. og:image fields (filled by composition pipeline in Phase 3)
--
-- Apply in Supabase SQL Editor. Do NOT apply via wrangler or CLI.

ALTER TABLE businesses
  -- ── Group 1: Agent-derived visual choices ──────────────────────────
  ADD COLUMN IF NOT EXISTS hero_layout text DEFAULT NULL
    CHECK (hero_layout IS NULL OR hero_layout IN ('photo', 'type')),

  ADD COLUMN IF NOT EXISTS hero_font text DEFAULT NULL
    CHECK (hero_font IS NULL OR hero_font IN
      ('fraunces', 'playfair', 'dm_serif', 'manrope', 'cormorant', 'space_grotesk')),

  ADD COLUMN IF NOT EXISTS hero_image_url text,
  ADD COLUMN IF NOT EXISTS hero_image_credit text,

  ADD COLUMN IF NOT EXISTS accent_color text DEFAULT NULL
    CHECK (accent_color IS NULL OR accent_color IN
      ('terracotta', 'sage', 'navy', 'charcoal', 'sienna', 'forest', 'brass', 'ink')),

  ADD COLUMN IF NOT EXISTS eyebrow_vocab text DEFAULT 'editorial'
    CHECK (eyebrow_vocab IN ('standard', 'editorial', 'operator')),

  -- ── Group 2: Agent-derived SEO ────────────────────────────────────
  ADD COLUMN IF NOT EXISTS seo_title text,
  ADD COLUMN IF NOT EXISTS seo_description text,
  ADD COLUMN IF NOT EXISTS seo_keywords jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- ── Group 3: User overrides (settings page) ───────────────────────
  ADD COLUMN IF NOT EXISTS calendly_url text,

  ADD COLUMN IF NOT EXISTS show_credentials_publicly boolean NOT NULL DEFAULT false,

  ADD COLUMN IF NOT EXISTS accent_color_override text
    CHECK (accent_color_override IS NULL OR accent_color_override IN
      ('terracotta', 'sage', 'navy', 'charcoal', 'sienna', 'forest', 'brass', 'ink')),

  -- ── Group 4: og:image fields (Phase 3) ────────────────────────────
  ADD COLUMN IF NOT EXISTS og_image_url text,
  ADD COLUMN IF NOT EXISTS og_image_hash text,
  ADD COLUMN IF NOT EXISTS og_image_generated_at timestamptz;

-- Lightweight index — calendly_url is nullable so partial index keeps it small
CREATE INDEX IF NOT EXISTS businesses_calendly_idx
  ON businesses (calendly_url)
  WHERE calendly_url IS NOT NULL;
