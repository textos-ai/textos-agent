-- =====================================================================
-- Migration 063: Register Hook Generator as a non-task LLM surface
-- =====================================================================
-- Source: Phase 4 overlay editor brief (2026-06-24)
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: ON CONFLICT (slug) DO NOTHING.
-- =====================================================================

-- Register the hook generator feature so it appears in /admin/models
-- and resolves its model via resolveFeatureModel("feature-hook-generator").
INSERT INTO public.external_apis (slug, name, provider, auth_kind, output_kind, status, metadata)
VALUES ('feature-hook-generator', 'Hook Generator', 'system', 'none', 'text', 'active', '{}'::jsonb)
ON CONFLICT (slug) DO NOTHING;

-- Confirm row:
-- SELECT slug, name, status, metadata FROM public.external_apis
-- WHERE slug = 'feature-hook-generator';
