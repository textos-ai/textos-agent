-- =====================================================================
-- Migration 084: per-prompt output cap (max_output_tokens)
-- =====================================================================
-- Source: Generate Prompt efficiency work (2026-07-08).
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: ADD COLUMN IF NOT EXISTS + a constraint guard.
-- =====================================================================
--
-- WHY: the generic document runner hardcodes max_tokens=3000 for every task.
-- A prompt that asks for a large document generates toward that ceiling, and a
-- non-streaming Anthropic call that long is silently killed by Cloudflare before
-- it returns (this is what killed ideal-customer-profile-generator -- see
-- docs/task-execution-architecture.md). The primary fix is prompt-side
-- (the Generate Prompt meta-prompt now enforces bounded output + a strict JSON
-- shape). This column is the BACKSTOP: a per-prompt output cap so even a prompt
-- that ignores the bounding can't run away -- it truncates loudly
-- (task_output_truncated) instead of hanging silently.
--
-- Semantics (zero regression):
--   - NULL  -> runtime falls back to the legacy 3000 (existing prompts unchanged)
--   - set   -> that value is the cap (the Generate Prompt flow writes a safe 1500
--              for new prompts; raise it per-prompt "by explicit choice")
-- =====================================================================

ALTER TABLE public.prompt_definitions
  ADD COLUMN IF NOT EXISTS max_output_tokens integer;

-- Sanity bound: a positive, reasonable ceiling (Anthropic caps far higher, but
-- our worker lifetime is the real limit -- keep runs short).
DO $$ BEGIN
  ALTER TABLE public.prompt_definitions
    ADD CONSTRAINT prompt_definitions_max_output_tokens_ck
    CHECK (max_output_tokens IS NULL OR (max_output_tokens >= 256 AND max_output_tokens <= 4000));
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- =====================================================================
-- Verification (paste after applying)
-- =====================================================================
-- Column present:
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name='prompt_definitions' AND column_name='max_output_tokens';
--
-- Constraint present:
--   SELECT conname FROM pg_constraint
--   WHERE conname='prompt_definitions_max_output_tokens_ck';
--
-- Active prompts + their cap (NULL = legacy 3000 fallback):
--   SELECT task_slug, version, max_output_tokens
--   FROM public.prompt_definitions WHERE is_active ORDER BY task_slug;
-- =====================================================================
