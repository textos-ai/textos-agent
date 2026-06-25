-- =====================================================================
-- Migration 064: Register Post Shortener as a non-task LLM surface
-- =====================================================================
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: ON CONFLICT (slug) DO NOTHING.
-- =====================================================================

INSERT INTO public.external_apis (slug, name, provider, auth_kind, output_kind, status, metadata)
VALUES ('feature-shorten', 'Post Shortener', 'system', 'none', 'text', 'active', '{}'::jsonb)
ON CONFLICT (slug) DO NOTHING;

-- Confirm row:
-- SELECT slug, name, status, metadata FROM public.external_apis
-- WHERE slug = 'feature-shorten';
