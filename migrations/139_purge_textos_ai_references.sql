-- =====================================================================
-- Migration 139: purge textos.ai / TextOS references from stored data
-- =====================================================================
-- Source: "remove every Victora dependency on textos.ai" brief, 2026-11-10.
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: every UPDATE is scoped to rows that still match a
-- textos pattern, and the rewrite leaves no such pattern behind; the
-- DELETEs are scoped to explicit ids / an exact sender value.
--
-- NOTE: test and prod share this Supabase project. This rewrites the data
-- both environments read. Rob confirmed there are no customers.
--
-- ── DRY RUN (2026-11-10, read-only, same regexes simulated in JS) ─────
--   column                                   before*  rows changed  after*
--   business_assets.asset_text                 136        136          0
--   business_assets.metadata                   128        128          1  (slug textos-43j5)
--   business_assets.asset_data                  38         11         27  (test hostnames, kept)
--   business_assets.asset_url                  199        184         12  (test 'app' rows, kept)
--     199 = 150 website rewrites + 34 logo rewrites + 3 website rows DELETED
--     (no usable site) + 12 kept. Re-counted live 2026-11-11. (An earlier
--     draft said 196: the dry run excluded the 3 deleted rows from "before".)
--   prompt_definitions.system_prompt            42         42          0
--   prompt_definitions.user_prompt_template      2          2          0
--   tasks.description_short                      3          3          0
--   tasks.prompt_template                        2          2          0
--   email_queue (pending, yourbusiness@textos.ai) 147  DELETED          0
--   * = rows matching /textos/i (case-insensitive). Rewritten JSON: 0 parse errors.
--
-- ── WHAT STAYS (by brief) ─────────────────────────────────────────────
--   - textos-web-test.pages.dev / textos-agent-test...workers.dev inside
--     asset_data: test infrastructure. The 25 'app' rows that call the
--     test agent are excluded from the text rewrite entirely.
--   - The 12 asset_type='app' asset_url rows on textos-web-test.pages.dev.
--   - businesses / business_context rows for slug textos-43j5.
-- =====================================================================

BEGIN;

-- ── 0. Backups (same transaction, before any rewrite) ────────────────
-- Full copies. IF NOT EXISTS: on a re-run the ORIGINAL pre-rewrite copy is
-- kept, not overwritten with already-rewritten data. RLS on with no policies
-- so PostgREST (anon/authenticated) can't read them; service role only.
-- Restore example: UPDATE public.prompt_definitions p SET system_prompt = b.system_prompt
--                  FROM public.backup_139_prompt_definitions b WHERE b.id = p.id;
-- Drop the four tables once the rewrite is verified.
CREATE TABLE IF NOT EXISTS public.backup_139_business_assets    AS SELECT * FROM public.business_assets;
CREATE TABLE IF NOT EXISTS public.backup_139_prompt_definitions AS SELECT * FROM public.prompt_definitions;
CREATE TABLE IF NOT EXISTS public.backup_139_tasks              AS SELECT * FROM public.tasks;
CREATE TABLE IF NOT EXISTS public.backup_139_email_queue        AS SELECT * FROM public.email_queue;
ALTER TABLE public.backup_139_business_assets    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backup_139_prompt_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backup_139_tasks              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backup_139_email_queue        ENABLE ROW LEVEL SECURITY;

-- Rewrite helper (session-temporary; gone when the session ends).
-- Order matters: subdomains first, then addresses, then the bare domain,
-- then the brand word. @TextOSApp is an X handle; it becomes plain
-- "Victora" rather than an invented @handle.
CREATE OR REPLACE FUNCTION pg_temp.victora_rewrite(t text) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT
    replace(
    replace(
    replace(
    replace(
    replace(
    regexp_replace(
    regexp_replace(t,
      'https?://([A-Za-z0-9_{}*-]+)\.app\.textos\.ai', 'https://app.victora.ai/sites/\1', 'g'),
      '(^|[^A-Za-z0-9_{}*\\-])([A-Za-z0-9_{}*-]+)\.app\.textos\.ai', '\1app.victora.ai/sites/\2', 'g'),
      'yourbusiness@textos.ai', 'hello@victora.ai'),
      '@TextOSApp', 'Victora'),
      '@TextOS', 'Victora'),
      'textos.ai', 'victora.ai'),
      'TextOS', 'Victora')
$fn$;

-- ── 1. business_assets.asset_url ─────────────────────────────────────
-- 1a. Delete the 3 website rows whose business has no usable site
--     (GET https://app.victora.ai/sites/{slug} = 404; all [DELETED] businesses).
--     content_assets.source_asset_id is ON DELETE SET NULL.
DELETE FROM public.business_assets ba
 USING public.businesses b
 WHERE ba.business_id = b.id
   AND ba.asset_type = 'website'
   AND b.name LIKE '[DELETED]%'
   AND ba.id IN (
     'd28d1753-8aa1-4948-badd-610fd3ebf637',  -- idea-ff5562_deleted_...    "Request Declined"
     '3473289a-0832-4ce6-9ba3-d59d5fa1badb',  -- httpsxcomtheenergywiz_deleted_... "The Energy Wiz"
     'a74a2059-d29b-44c8-875c-b887dd560146'   -- idea-2e5898_deleted_... "Silk & Libre"
   );

-- 1b. Website rows on the test frontend / app.textos.ai / <slug>.app.textos.ai
--     -> https://app.victora.ai/sites/{businesses.slug}  (150 rows; every
--     target verified 200 on 2026-11-10).
UPDATE public.business_assets ba
   SET asset_url = 'https://app.victora.ai/sites/' || b.slug
  FROM public.businesses b
 WHERE ba.business_id = b.id
   AND ba.asset_type = 'website'
   AND b.slug IS NOT NULL
   AND ba.asset_url ~ '^https://(textos-web-test\.pages\.dev|app\.textos\.ai|[a-z0-9-]+\.app\.textos\.ai)(/|$)';

-- 1c. Logos on assets.textos.ai -> assets.victora.ai (same R2 bucket;
--     all 34 objects verified 200 on assets.victora.ai on 2026-11-10).
UPDATE public.business_assets
   SET asset_url = replace(asset_url, 'https://assets.textos.ai/', 'https://assets.victora.ai/')
 WHERE asset_url LIKE 'https://assets.textos.ai/%';

-- ── 2. business_assets text / jsonb columns ──────────────────────────
-- Rows whose asset_data calls the test agent stay byte-for-byte as-is.
UPDATE public.business_assets
   SET asset_text = pg_temp.victora_rewrite(asset_text)
 WHERE asset_text ~ '(TextOS|textos\.ai)'
   AND coalesce(asset_data::text, '') !~ 'textos-agent-test\.rgaudet2023\.workers\.dev';

UPDATE public.business_assets
   SET metadata = pg_temp.victora_rewrite(metadata::text)::jsonb
 WHERE metadata::text ~ '(TextOS|textos\.ai)'
   AND coalesce(asset_data::text, '') !~ 'textos-agent-test\.rgaudet2023\.workers\.dev';

UPDATE public.business_assets
   SET asset_data = pg_temp.victora_rewrite(asset_data::text)::jsonb
 WHERE asset_data::text ~ '(TextOS|textos\.ai)'
   AND asset_data::text !~ 'textos-agent-test\.rgaudet2023\.workers\.dev';

-- ── 3. email_queue: the 147 pending test rows ─────────────────────────
DELETE FROM public.email_queue
 WHERE status = 'pending'
   AND from_email = 'yourbusiness@textos.ai';

-- ── 4. prompts + tasks ───────────────────────────────────────────────
UPDATE public.prompt_definitions
   SET system_prompt = pg_temp.victora_rewrite(system_prompt)
 WHERE system_prompt ~ '(TextOS|textos\.ai)';

UPDATE public.prompt_definitions
   SET user_prompt_template = pg_temp.victora_rewrite(user_prompt_template)
 WHERE user_prompt_template ~ '(TextOS|textos\.ai)';

UPDATE public.tasks
   SET description_short = pg_temp.victora_rewrite(description_short)
 WHERE description_short ~ '(TextOS|textos\.ai)';

UPDATE public.tasks
   SET prompt_template = pg_temp.victora_rewrite(prompt_template)
 WHERE prompt_template ~ '(TextOS|textos\.ai)';

COMMIT;

-- ── AFTER COUNTS (runs as the last statement so the editor shows it) ──
-- Expected: targeted = 0 everywhere; any_textos = 1 / 27 / 12 / 0... as in
-- the dry-run table above (test hostnames + the textos-43j5 slug).
SELECT 'business_assets.asset_text' AS col,
       count(*) FILTER (WHERE asset_text ~* 'textos') AS any_textos,
       count(*) FILTER (WHERE asset_text ~ '(TextOS|textos\.ai)') AS targeted
  FROM public.business_assets
UNION ALL SELECT 'business_assets.metadata',
       count(*) FILTER (WHERE metadata::text ~* 'textos'),
       count(*) FILTER (WHERE metadata::text ~ '(TextOS|textos\.ai)')
  FROM public.business_assets
UNION ALL SELECT 'business_assets.asset_data',
       count(*) FILTER (WHERE asset_data::text ~* 'textos'),
       count(*) FILTER (WHERE asset_data::text ~ '(TextOS|textos\.ai)')
  FROM public.business_assets
UNION ALL SELECT 'business_assets.asset_url',
       count(*) FILTER (WHERE asset_url ~* 'textos'),
       count(*) FILTER (WHERE asset_url ~ '(TextOS|textos\.ai)')
  FROM public.business_assets
UNION ALL SELECT 'prompt_definitions.system_prompt',
       count(*) FILTER (WHERE system_prompt ~* 'textos'),
       count(*) FILTER (WHERE system_prompt ~ '(TextOS|textos\.ai)')
  FROM public.prompt_definitions
UNION ALL SELECT 'prompt_definitions.user_prompt_template',
       count(*) FILTER (WHERE user_prompt_template ~* 'textos'),
       count(*) FILTER (WHERE user_prompt_template ~ '(TextOS|textos\.ai)')
  FROM public.prompt_definitions
UNION ALL SELECT 'tasks.description_short',
       count(*) FILTER (WHERE description_short ~* 'textos'),
       count(*) FILTER (WHERE description_short ~ '(TextOS|textos\.ai)')
  FROM public.tasks
UNION ALL SELECT 'tasks.prompt_template',
       count(*) FILTER (WHERE prompt_template ~* 'textos'),
       count(*) FILTER (WHERE prompt_template ~ '(TextOS|textos\.ai)')
  FROM public.tasks
UNION ALL SELECT 'email_queue.from_email',
       count(*) FILTER (WHERE from_email ~* 'textos'),
       count(*) FILTER (WHERE from_email ~ 'textos\.ai')
  FROM public.email_queue;

-- Backups exist (expect 4 rows, rowsecurity = true; counts = pre-run row counts):
-- SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'backup_139_%';
-- SELECT (SELECT count(*) FROM public.backup_139_business_assets) ba, (SELECT count(*) FROM public.backup_139_prompt_definitions) pd,
--        (SELECT count(*) FROM public.backup_139_tasks) t, (SELECT count(*) FROM public.backup_139_email_queue) eq;
-- Extra verification:
-- SELECT asset_url FROM public.business_assets WHERE asset_type='website' ORDER BY created_at DESC LIMIT 5;
-- SELECT task_slug, version, is_active, left(user_prompt_template, 200) FROM public.prompt_definitions WHERE task_slug='welcome-email';
-- SELECT slug, description_short FROM public.tasks WHERE slug IN ('welcome-email','personal-landing-page','business-landing-page');
