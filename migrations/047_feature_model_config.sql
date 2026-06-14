-- =====================================================================
-- Migration 047: Non-task feature model config
-- =====================================================================
-- Adds feature rows to external_apis so each non-task LLM surface
-- appears in the admin /admin/models selector and resolves its model
-- from config (feature-specific tier override ?? feature-default tier).
--
-- Rows use slug prefix "feature-" and store metadata.tier (the tier
-- key: haiku|sonnet|opus). The actual model string is resolved at
-- runtime via loadModelConfig() → models[tier].
--
-- feature-default is REQUIRED — it is the fallback for every feature
-- that has no override set. loadFeatureConfig() throws if it is missing.
--
-- Apply via Supabase dashboard SQL editor OR use the REST API.
-- Safe to re-run: ON CONFLICT DO NOTHING.
-- =====================================================================

INSERT INTO public.external_apis (slug, name, provider, auth_kind, output_kind, status, metadata)
VALUES
  ('feature-default',            'Non-task default',                'system', 'none', 'text', 'active', '{"tier":"haiku"}'::jsonb),
  ('feature-chat',               'Chat / Morning Line',             'system', 'none', 'text', 'active', '{}'::jsonb),
  ('feature-anonymous-research', 'Anonymous Research',              'system', 'none', 'text', 'active', '{}'::jsonb),
  ('feature-visual-picker',      'Visual Identity Picker',          'system', 'none', 'text', 'active', '{}'::jsonb),
  ('feature-story-cards',        'Story Card Generator',            'system', 'none', 'text', 'active', '{}'::jsonb),
  ('feature-admin-seo',          'Admin SEO Backfill',              'system', 'none', 'text', 'active', '{}'::jsonb),
  ('feature-app-builder',        'Generated App Build Step',        'system', 'none', 'text', 'active', '{"tier":"opus"}'::jsonb),
  ('feature-app-result',         'Generated App Runtime Result',    'system', 'none', 'text', 'active', '{"tier":"opus"}'::jsonb)
ON CONFLICT (slug) DO NOTHING;

-- =====================================================================
-- Verification
-- =====================================================================
-- SELECT slug, metadata->>'tier' AS tier FROM public.external_apis
-- WHERE slug LIKE 'feature-%' ORDER BY slug;
-- Expected:
--   feature-admin-seo          | (null — uses default)
--   feature-anonymous-research | (null — uses default)
--   feature-app-result         | opus
--   feature-chat               | (null — uses default)
--   feature-default            | haiku
--   feature-story-cards        | (null — uses default)
--   feature-visual-picker      | (null — uses default)
-- =====================================================================
