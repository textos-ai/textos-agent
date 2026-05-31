-- =====================================================================
-- Migration 042: per-app access/result gate columns on app_configs
-- =====================================================================
-- Source: App Builder Increment 2 — gate architecture (fields only; the
-- assembler seams are hardwired pass-through / unwired this increment).
--
-- app_configs is the per-app config table (keyed asset_id → business_assets.id)
-- and already holds the visitor-monetization config (free_tier_enabled,
-- paid_tier_price_cents, token_cost_per_use). The two gate settings live here
-- alongside them. Both DEFAULT 'free' — nothing renders, charges, or captures
-- until visitor-facing monetization is wired (see
-- docs/textos-backlog-master.md "Visitor-facing monetization").
--
-- Apply manually in the Supabase SQL editor for the TEST project.
-- Safe to re-run: ADD COLUMN IF NOT EXISTS.
-- =====================================================================

ALTER TABLE public.app_configs
  ADD COLUMN IF NOT EXISTS access_gate text NOT NULL DEFAULT 'free'
    CHECK (access_gate IN ('free', 'paywall', 'email')),
  ADD COLUMN IF NOT EXISTS result_gate text NOT NULL DEFAULT 'free'
    CHECK (result_gate IN ('free', 'paywall', 'email'));

-- ── Verify (run after applying) ──────────────────────────────────────
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'app_configs'
--   AND column_name IN ('access_gate', 'result_gate');
-- Expected: 2 rows, data_type 'text', column_default '''free''::text'.
