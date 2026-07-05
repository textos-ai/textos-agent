-- =====================================================================
-- Migration 082: tasks.is_context_source + tasks.context_fields
-- =====================================================================
-- The "Rebuild Context" feature's doc->field map, as DATA (not code). A task
-- whose document is a rebuildable context source gets is_context_source=true and
-- context_fields = the business_context fields that document may populate. Adding
-- a new source = flip the flag + list its fields. No code change.
--
-- Pre-flight collision probe run before handoff: both columns return 42703
-- (do not exist) -> free to add.
-- Pure ASCII, no doubled-quote escapes; jsonb array literals dollar-quoted.
-- Apply via the Supabase SQL editor.
-- =====================================================================

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS is_context_source boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS context_fields    jsonb   NOT NULL DEFAULT '[]'::jsonb;

-- Seed the real forward map (replaces the accidental 3-doc set).
UPDATE public.tasks
  SET is_context_source = true,
      context_fields = $json$["industry","business_model","business_summary","target_customer","value_proposition","competitors","market_trends","positioning_statement","brand_voice","key_differentiators"]$json$::jsonb
  WHERE slug = 'research-strategy';

UPDATE public.tasks
  SET is_context_source = true,
      context_fields = $json$["business_summary"]$json$::jsonb
  WHERE slug = 'mission-document';

UPDATE public.tasks
  SET is_context_source = true,
      context_fields = $json$["market_size"]$json$::jsonb
  WHERE slug = 'tam-sam-som';

-- == Verify (paste after applying) =============================================
-- SELECT slug, is_context_source, context_fields FROM public.tasks
--   WHERE is_context_source = true ORDER BY slug;
--   Expect: mission-document ["business_summary"];
--           research-strategy [10 fields]; tam-sam-som ["market_size"]
