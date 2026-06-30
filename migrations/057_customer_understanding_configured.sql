-- =====================================================================
-- Migration 057: Customer Understanding → configured task (own page)
-- =====================================================================
-- Makes customer-understanding a "configured" task that routes to its own
-- page (the carousel pattern: output_type='configured' + config_page_path).
-- The page drives the EXISTING generic document pipeline for storage (it does
-- NOT use a bespoke table) — generation still flows through
-- runTaskInBackground → genericDocumentRunner → task_runs.output_data +
-- business_assets, exactly as before. Only the ENTRY POINT moves: the Playbook
-- modal now opens the page ("Open Tool →") instead of a one-shot run, and
-- POST /run correctly refuses it (output_type='configured' guard).
--
-- Token/charge: configured tasks are NOT charged by the generic /run path
-- (it refuses them). The page's dedicated generate endpoint owns the charge.
-- We therefore zero out tasks.token_cost so the shared runner's post-success
-- debit (which reads tasks.token_cost) does NOT fire — the endpoint charges
-- the draft itself and leaves sharpen re-runs free. plan_required is unchanged
-- (core_paid still gates access via catalog visibility).
--
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
--
-- Safe to re-run: single idempotent UPDATE keyed by slug.
-- =====================================================================

UPDATE public.tasks
SET output_type      = 'configured',
    config_page_path = '/business/{slug}/playbook/customer-understanding',
    token_cost       = 0
WHERE slug = 'customer-understanding';

-- ── Verify ────────────────────────────────────────────────────────────────
-- SELECT slug, output_type, config_page_path, token_cost, plan_required, status
-- FROM tasks WHERE slug = 'customer-understanding';
-- Expect: configured | /business/{slug}/playbook/customer-understanding | 0 | core_paid | active
