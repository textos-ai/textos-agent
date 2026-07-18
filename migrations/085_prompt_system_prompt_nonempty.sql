-- =====================================================================
-- Migration 085: prompt_definitions.system_prompt must be non-empty
-- =====================================================================
-- Source: system-prompt carry-forward work (2026-07-14).
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: constraint add is guarded (duplicate_object -> no-op).
-- =====================================================================
--
-- WHY: genericDocumentRunner throws `task_missing_system_prompt` when the active
-- prompt's system_prompt is null/empty, so such a version is unrunnable. The
-- POST /admin/prompt-definitions handler now carries a system_prompt forward and
-- rejects a null result — but prompt_definitions has MANY other write paths
-- (10+ seed/migration INSERTs today, plus any future seed/import/manual SQL) that
-- bypass the handler. This constraint is the systemic backstop: no write path,
-- present or future, can persist a null/blank system_prompt.
--
-- NOT VALID: there are 4 pre-existing rows with a null system_prompt (older
-- broken versions — keyword-generator v9, sales-preparation-overview v2/v5/v6).
-- NOT VALID enforces the check on every FUTURE insert/update while grandfathering
-- those existing rows (they are inactive or get replaced via carry-forward on the
-- next save). A plain VALID constraint would fail to apply against them.
-- =====================================================================

DO $$ BEGIN
  ALTER TABLE public.prompt_definitions
    ADD CONSTRAINT prompt_definitions_system_prompt_nonempty
    CHECK (system_prompt IS NOT NULL AND btrim(system_prompt) <> '')
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- =====================================================================
-- Verification (paste after applying)
-- =====================================================================
-- Constraint present + NOT VALID:
--   SELECT conname, convalidated FROM pg_constraint
--   WHERE conname = 'prompt_definitions_system_prompt_nonempty';
--   -- expect one row, convalidated = false (NOT VALID)
--
-- Future null insert is rejected (this SHOULD error, do not commit it):
--   INSERT INTO public.prompt_definitions (task_slug, version, system_prompt, user_prompt_template, is_active)
--   VALUES ('__constraint_test__', 1, NULL, 'x', false);
--   -- expect: new row for relation violates check constraint
--
-- Existing grandfathered null rows still present (untouched):
--   SELECT task_slug, version, is_active FROM public.prompt_definitions
--   WHERE system_prompt IS NULL OR btrim(system_prompt) = '';
-- =====================================================================
