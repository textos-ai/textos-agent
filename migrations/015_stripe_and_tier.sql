-- Migration 015: Stripe customer ID + subscription tier on users
-- Required for Stripe Checkout integration (Sprint 6).
--
-- Apply via: https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new

-- ── 1. Stripe customer ID ─────────────────────────────────────────────────────
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS stripe_customer_id text;

CREATE UNIQUE INDEX IF NOT EXISTS users_stripe_customer_idx
  ON public.users (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- ── 2. Subscription tier ─────────────────────────────────────────────────────
-- Values mirror subscription_plans.slug but are denormalized here for fast
-- access from the Worker without a join. Webhook handler keeps this in sync.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'free'
    CHECK (tier IN ('free', 'core_monthly', 'founder_lifetime'));

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS tier_updated_at timestamptz;

-- ── Verify ────────────────────────────────────────────────────────────────────
-- SELECT id, email, tier, stripe_customer_id FROM users ORDER BY created_at DESC LIMIT 10;
