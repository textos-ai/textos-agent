-- =====================================================================
-- Migration 086: connection_leads.metadata (per-lead enrichment bag)
-- =====================================================================
-- Source: lead-engine enrichment stages (understand-lead, reach-package-lead).
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
-- Safe to re-run: ADD COLUMN IF NOT EXISTS is idempotent.
-- =====================================================================
--
-- WHY: the enrichment stages annotate each lead row without advancing its
-- status machine (found→verified→rejected→drafted). Rather than one typed
-- column per stage (author, activity, readiness, channel, ... — column sprawl
-- that grows with every new stage), all per-lead enrichment nests under a single
-- jsonb bag keyed by stage:
--   metadata.alignment_read = { activity, engagement_style, readiness, fit_line }
--   metadata.reach_package  = { person, where_to_reach, channel, reach_strength,
--                               caveat, opener }
-- Future stages add their own top-level key; no further DDL needed.
--
-- Additive + nullable + defaulted: zero risk. Existing rows read {} ; the stages
-- read-modify-write to preserve other stages' keys.
-- =====================================================================

ALTER TABLE public.connection_leads
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- =====================================================================
-- Verification (paste after applying)
-- =====================================================================
--   SELECT column_name, data_type, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'connection_leads' AND column_name = 'metadata';
--   -- expect one row: metadata | jsonb | '{}'::jsonb
-- =====================================================================
