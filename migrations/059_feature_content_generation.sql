-- =====================================================================
-- Migration 059: Feature model config — Content Generation
-- =====================================================================
-- Adds the feature-content-generation row to external_apis so it appears
-- in the admin /admin/models Non-Task / Platform selector and resolves
-- its model via the feature registry (resolveFeatureModel).
--
-- No metadata.tier set → resolves to the feature-default tier at runtime.
-- Admin can set an explicit tier override from /admin/models.
--
-- generate-social-post.ts uses this key (replaces the hardcoded models.sonnet
-- access that bypassed the model-selection system).
--
-- Safe to re-run: ON CONFLICT DO NOTHING.
-- =====================================================================

INSERT INTO public.external_apis (slug, name, provider, auth_kind, output_kind, status, metadata)
VALUES (
  'feature-content-generation',
  'Content Generation',
  'system',
  'none',
  'text',
  'active',
  '{}'::jsonb
)
ON CONFLICT (slug) DO NOTHING;

-- =====================================================================
-- Verification
-- =====================================================================
-- SELECT slug, name, metadata->>'tier' AS tier
-- FROM public.external_apis
-- WHERE slug = 'feature-content-generation';
-- Expected: slug = 'feature-content-generation', tier = (null — uses feature-default)
-- =====================================================================
