-- =====================================================================
-- Migration 046: Model config — fix retiring model strings + add opus row
-- =====================================================================
-- claude-sonnet-4-20250514 and claude-opus-4-20250514 retire 2026-06-15.
-- Update external_apis.metadata.model to current non-retiring strings.
-- Add the missing anthropic-claude-opus row.
--
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: UPDATE is idempotent; INSERT uses ON CONFLICT DO NOTHING.
-- =====================================================================

-- Fix retiring sonnet string
UPDATE public.external_apis
SET metadata = metadata || '{"model":"claude-sonnet-4-6"}'::jsonb
WHERE slug = 'anthropic-claude-sonnet';

-- Haiku is already correct (claude-haiku-4-5-20251001) — no change needed.

-- Add missing opus row
INSERT INTO public.external_apis (slug, name, provider, auth_kind, output_kind, status, metadata)
VALUES (
  'anthropic-claude-opus',
  'Claude Opus 4',
  'anthropic',
  'api_key',
  'document',
  'active',
  '{"model":"claude-opus-4-7"}'::jsonb
)
ON CONFLICT (slug) DO NOTHING;

-- =====================================================================
-- Verification
-- =====================================================================
-- SELECT slug, metadata->>'model' AS model FROM public.external_apis
-- WHERE provider = 'anthropic' ORDER BY slug;
-- Expected:
--   anthropic-claude-haiku  | claude-haiku-4-5-20251001
--   anthropic-claude-opus   | claude-opus-4-7
--   anthropic-claude-sonnet | claude-sonnet-4-6
-- =====================================================================
