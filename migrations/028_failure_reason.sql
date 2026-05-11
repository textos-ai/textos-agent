-- =====================================================================
-- Migration 028: free_build_runs.failure_reason column
-- =====================================================================
-- Source: Phase 5 token deduction (Day 13, May 11, 2026)
-- Purpose: Distinguish WHY a build failed. Set by the orchestrator when
--          InsufficientTokensError or SubscriptionRequiredError halts
--          the pipeline. Phase 7 frontend reads this to decide which
--          recovery modal to show (top-up vs. subscribe).
--
--   NULL              → failed for non-billing reason (model error, etc.)
--   insufficient_tokens  → user ran out of tokens mid-build
--   subscription_required → paid task attempted without active subscription
--
-- Apply via Supabase SQL Editor.
-- Safe to re-run: ADD COLUMN IF NOT EXISTS.
-- =====================================================================

ALTER TABLE public.free_build_runs
  ADD COLUMN IF NOT EXISTS failure_reason text;

-- Verification:
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'free_build_runs' AND column_name = 'failure_reason';
-- Expected: 1 row
