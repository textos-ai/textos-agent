-- =====================================================================
-- Migration 025: Stripe events idempotency table
-- =====================================================================
-- Source: stripe-tokens-spec.md Phase 3 dedup design (Day 13 Phase 3)
-- Purpose: dedup Stripe webhook redeliveries so token grants and
--          subscription updates don't fire twice for the same event.
--
-- Apply via Supabase SQL Editor.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.stripe_events (
  event_id     text        PRIMARY KEY,
  event_type   text        NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error        text
);

CREATE INDEX IF NOT EXISTS stripe_events_received_idx
  ON public.stripe_events (received_at DESC);

-- No RLS — this is internal infrastructure, only accessed by service
-- role from the webhook handler. No user-facing reads.

-- Verification:
-- SELECT count(*) FROM public.stripe_events;  -- expect 0
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'stripe_events';
