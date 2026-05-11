-- =====================================================================
-- Migration 027: App errors persistence table
-- =====================================================================
-- Source: Day 13 Risk Pass Part D (2026-05-11)
-- Purpose: Persist log.error / log.warn from money-handling code paths
--          (Stripe webhooks + checkout endpoints) for post-launch debugging.
--          V1 scope: explicit persistError() call sites only.
--          V1.1: automatic persistence via logger refactor.
--
-- Apply via Supabase SQL Editor.
-- Safe to re-run: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.app_errors (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  level       text        NOT NULL CHECK (level IN ('error', 'warn')),
  source      text        NOT NULL,
  message     text        NOT NULL,
  context     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_errors_created_idx
  ON public.app_errors (created_at DESC);

CREATE INDEX IF NOT EXISTS app_errors_source_idx
  ON public.app_errors (source);

CREATE INDEX IF NOT EXISTS app_errors_level_idx
  ON public.app_errors (level, created_at DESC);

-- No RLS — internal infrastructure, service-role only.
-- No user-facing reads or writes.

-- Verification:
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'app_errors' ORDER BY ordinal_position;
-- SELECT indexname FROM pg_indexes WHERE tablename = 'app_errors';
