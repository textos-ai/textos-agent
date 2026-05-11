-- =====================================================================
-- Migration 024: Subscriptions + Tokens
-- =====================================================================
-- Source: stripe-tokens-spec.md (Phase 1, May 7 2026)
-- Folded in:
--   • Stripe Connect schema (businesses: 3 new columns + index)
--   • task_output_type enum values (image, image_set)
--   • mission-dashboard backfill correction (1 token, not 0)
--   • subscription_plans slug correction (actual DB slugs used)
--   • business-landing-page + silent pipeline tasks added to 0-token bucket
--   • payment_source column on business_subscriptions (V1.5+ ready)
--
-- Apply via:
--   https://supabase.com/dashboard/project/gnpohaxkwbvoscqhdezu/sql/new
--
-- Safe to re-run: uses IF NOT EXISTS, ON CONFLICT, ADD COLUMN IF NOT EXISTS,
--                 ADD VALUE IF NOT EXISTS, CREATE OR REPLACE FUNCTION.
-- =====================================================================


-- ── 0. Future-proofing additions (run first, non-blocking) ──────────

-- 0.1 task_output_type enum: add image and image_set for V1.1+ tasks
--     (logo regen, hero regen, carousel). Non-blocking; idempotent.
ALTER TYPE task_output_type ADD VALUE IF NOT EXISTS 'image';
ALTER TYPE task_output_type ADD VALUE IF NOT EXISTS 'image_set';

-- 0.2 Stripe Connect future-proofing columns on businesses (V1.5+)
--     NULL for all users at launch. Express onboarding ships as a
--     paid task post-launch. Schema ships now so no future migration
--     is needed to add them.
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS stripe_connect_account_id       text,
  ADD COLUMN IF NOT EXISTS stripe_connect_account_status   text
    CHECK (stripe_connect_account_status IS NULL OR
           stripe_connect_account_status IN
           ('not_started','onboarding','restricted','active','disabled')),
  ADD COLUMN IF NOT EXISTS stripe_connect_onboarded_at     timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS businesses_stripe_connect_idx
  ON public.businesses (stripe_connect_account_id)
  WHERE stripe_connect_account_id IS NOT NULL;


-- ── 1. Retire old subscription_plans ────────────────────────────────
-- Mark old plans as inactive. Existing user_subscriptions rows are
-- preserved for audit; new references must use the new plan.
--
-- NOTE: Spec referenced slugs 'founder_lifetime','core_monthly','pro_all_tasks'
-- which do not exist. Actual DB slugs (from Part A audit): free, founders,
-- standard, pro. Corrected here.

UPDATE public.subscription_plans
SET is_active = false
WHERE slug IN ('free', 'founders', 'standard', 'pro');

-- Insert the new single plan. $49.99/mo, 1 business per subscription,
-- all tasks included (tokens gate what actually runs).
INSERT INTO public.subscription_plans
  (slug, name, monthly_cents, one_time_cents, business_quota,
   includes_premium_tasks, is_grandfathered, cohort_limit, is_active)
VALUES
  ('standard_monthly', 'Standard', 4999, 0, 1, true, false, NULL, true)
ON CONFLICT (slug) DO UPDATE SET
  monthly_cents        = 4999,
  business_quota       = 1,
  includes_premium_tasks = true,
  is_active            = true;


-- ── 2. business_subscriptions ───────────────────────────────────────
-- One subscription per business (not per user). A user with 3
-- businesses pays 3 subscriptions. Replaces user-level tier logic.

CREATE TABLE IF NOT EXISTS public.business_subscriptions (
  id                      uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id             uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  user_id                 uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  plan_slug               text        NOT NULL DEFAULT 'standard_monthly',
  status                  text        NOT NULL CHECK (status IN
                            ('trialing','active','past_due','canceled','expired')),
  trial_started_at        timestamptz,
  trial_ends_at           timestamptz,
  current_period_start    timestamptz,
  current_period_end      timestamptz,
  cancel_at_period_end    boolean     NOT NULL DEFAULT false,
  canceled_at             timestamptz,
  stripe_customer_id      text,
  stripe_subscription_id  text        UNIQUE,
  stripe_price_id         text,
  -- payment_source: 'card' (V1, all users at launch) or
  -- 'connect_revenue_share' (V1.5+: subscription paid from user's
  -- Stripe Connect earnings via platform fee). All launch rows
  -- default to 'card'. Toggle ships post-launch.
  payment_source          text        NOT NULL DEFAULT 'card'
    CHECK (payment_source IN ('card','connect_revenue_share')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id)    -- one active subscription per business
);

CREATE INDEX IF NOT EXISTS bsub_user_idx    ON public.business_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS bsub_status_idx  ON public.business_subscriptions(status);
CREATE INDEX IF NOT EXISTS bsub_stripe_idx  ON public.business_subscriptions(stripe_subscription_id);

ALTER TABLE public.business_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own business subscriptions"
  ON public.business_subscriptions
  FOR SELECT USING (user_id = auth.uid());


-- ── 3. token_balances ───────────────────────────────────────────────
-- Current token state per business. One row per business. Worker
-- reads + writes this on every billable task run.

CREATE TABLE IF NOT EXISTS public.token_balances (
  id                        uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id               uuid        NOT NULL UNIQUE REFERENCES public.businesses(id) ON DELETE CASCADE,
  user_id                   uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Current subscription period
  period_tokens_included    integer     NOT NULL DEFAULT 30,
  period_tokens_used        integer     NOT NULL DEFAULT 0,
  period_started_at         timestamptz NOT NULL DEFAULT now(),
  period_ends_at            timestamptz,
  -- Top-up tokens: don't reset at period end, carry forward
  topup_tokens_remaining    integer     NOT NULL DEFAULT 0,
  -- Lifetime stats
  lifetime_tokens_used      integer     NOT NULL DEFAULT 0,
  lifetime_topups_purchased integer     NOT NULL DEFAULT 0,
  -- Audit
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tokenbal_user_idx ON public.token_balances(user_id);

ALTER TABLE public.token_balances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own token balances"
  ON public.token_balances
  FOR SELECT USING (user_id = auth.uid());


-- ── 4. token_transactions ──────────────────────────────────────────
-- Full ledger. Append-only — never UPDATE rows, only INSERT.
-- Positive tokens = credit; negative tokens = debit.

CREATE TABLE IF NOT EXISTS public.token_transactions (
  id          uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  kind        text        NOT NULL CHECK (kind IN
                ('debit_task','debit_image','credit_subscription_grant',
                 'credit_topup','credit_refund','credit_admin_adjust')),
  tokens      integer     NOT NULL,   -- positive = credit, negative = debit
  task_slug   text,                   -- set for debit_task / debit_image
  task_run_id uuid        REFERENCES public.task_runs(id),
  topup_id    uuid,                   -- set for credit_topup (references token_purchases.id)
  description text,
  metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ttx_business_idx ON public.token_transactions(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ttx_user_idx     ON public.token_transactions(user_id, created_at DESC);

ALTER TABLE public.token_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own token transactions"
  ON public.token_transactions
  FOR SELECT USING (user_id = auth.uid());


-- ── 5. token_purchases ─────────────────────────────────────────────
-- Top-up bundles purchased via Stripe one-time charge.

CREATE TABLE IF NOT EXISTS public.token_purchases (
  id                          uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id                 uuid        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  user_id                     uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  bundle_slug                 text        NOT NULL CHECK (bundle_slug IN
                                ('topup_10','topup_30','topup_75')),
  tokens_purchased            integer     NOT NULL,
  amount_cents                integer     NOT NULL,
  stripe_payment_intent_id    text        UNIQUE,
  stripe_checkout_session_id  text,
  status                      text        NOT NULL CHECK (status IN
                                ('pending','succeeded','failed','refunded')),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  succeeded_at                timestamptz
);

CREATE INDEX IF NOT EXISTS tpur_business_idx ON public.token_purchases(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tpur_user_idx     ON public.token_purchases(user_id);
CREATE INDEX IF NOT EXISTS tpur_stripe_idx   ON public.token_purchases(stripe_payment_intent_id);

ALTER TABLE public.token_purchases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own token purchases"
  ON public.token_purchases
  FOR SELECT USING (user_id = auth.uid());


-- ── 6. tasks.token_cost + backfill ─────────────────────────────────

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS token_cost integer NOT NULL DEFAULT 0;

-- 0 tokens: free-build pipeline tasks (run during trial, no charge)
-- Corrections vs. spec:
--   • mission-dashboard removed (correct cost is 1 token, see below)
--   • Added: business-landing-page, welcome-email, dashboard-briefing,
--     task-queue-built, logo (all run in the free-build orchestrator pipeline)
-- 4 slugs not in catalog (silently match 0 rows, not an error):
--   market-research, business-website, mission-vision, business-website-rebuild
UPDATE public.tasks SET token_cost = 0 WHERE slug IN (
  'research-strategy',      'tam-sam-som',             'mission-document',
  'personal-landing-page',  'business-landing-page',   'launch-tweet',
  'personalized-pitch-email','market-research',         'business-website',
  'mission-vision',          'daycycle-connect',         'welcome-email',
  'dashboard-briefing',      'task-queue-built',         'logo'
);

-- 1 token: light tasks
-- mission-dashboard belongs here only (was duplicated in 0-token bucket
-- in the original spec; that was a typo — corrected here).
UPDATE public.tasks SET token_cost = 1 WHERE slug IN (
  'lean-canvas', 'mission-dashboard'
);

-- 3 tokens: medium tasks
UPDATE public.tasks SET token_cost = 3 WHERE slug IN (
  'competitive-analysis', 'market-research-report', 'investor-alignment'
);

-- 5 tokens: heavier tasks
UPDATE public.tasks SET token_cost = 5 WHERE slug IN (
  'social-content-plan', 'business-website-rebuild'
);

-- 10 tokens: heavy tasks
-- cold-email-outreach is 10 because it runs a batch of 50 emails.
-- Single-recipient cold email (V1.1) will be token_cost=1 when added.
UPDATE public.tasks SET token_cost = 10 WHERE slug IN (
  'cold-email-outreach', 'investor-data-room', 'pitch-deck', 'exit-strategy'
);


-- ── 7. RPC: debit_tokens ───────────────────────────────────────────
-- Atomically debits tokens from a business balance before a task runs.
-- Drains period bucket first, then top-up bucket.
-- Returns JSONB: { ok: bool, reason?, available?, from_period, from_topup,
--                  period_remaining, topup_remaining }
-- Worker must check ok=true before proceeding with the task.

CREATE OR REPLACE FUNCTION public.debit_tokens(
  p_business_id  uuid,
  p_user_id      uuid,
  p_tokens       integer,
  p_task_slug    text,
  p_task_run_id  uuid,
  p_description  text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_balance          record;
  v_period_remaining integer;
  v_total_available  integer;
  v_from_period      integer;
  v_from_topup       integer;
BEGIN
  -- Lock the balance row for this transaction
  SELECT * INTO v_balance
    FROM public.token_balances
   WHERE business_id = p_business_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_balance_row');
  END IF;

  v_period_remaining := v_balance.period_tokens_included - v_balance.period_tokens_used;
  IF v_period_remaining < 0 THEN v_period_remaining := 0; END IF;
  v_total_available := v_period_remaining + v_balance.topup_tokens_remaining;

  IF v_total_available < p_tokens THEN
    RETURN jsonb_build_object(
      'ok',        false,
      'reason',    'insufficient_tokens',
      'available', v_total_available,
      'requested', p_tokens
    );
  END IF;

  -- Drain period bucket first, then top-up
  IF v_period_remaining >= p_tokens THEN
    v_from_period := p_tokens;
    v_from_topup  := 0;
  ELSE
    v_from_period := v_period_remaining;
    v_from_topup  := p_tokens - v_period_remaining;
  END IF;

  UPDATE public.token_balances SET
    period_tokens_used        = period_tokens_used        + v_from_period,
    topup_tokens_remaining    = topup_tokens_remaining    - v_from_topup,
    lifetime_tokens_used      = lifetime_tokens_used      + p_tokens,
    updated_at                = now()
  WHERE business_id = p_business_id;

  -- Append ledger entry (negative tokens = debit)
  INSERT INTO public.token_transactions
    (business_id, user_id, kind, tokens, task_slug, task_run_id, description)
  VALUES
    (p_business_id, p_user_id, 'debit_task', -p_tokens,
     p_task_slug, p_task_run_id, p_description);

  RETURN jsonb_build_object(
    'ok',              true,
    'from_period',     v_from_period,
    'from_topup',      v_from_topup,
    'period_remaining', v_balance.period_tokens_included
                       - v_balance.period_tokens_used
                       - v_from_period,
    'topup_remaining', v_balance.topup_tokens_remaining - v_from_topup
  );
END;
$$;


-- ── 8. RPC: grant_period_tokens ────────────────────────────────────
-- Called by the Stripe webhook handler on subscription.renewed /
-- checkout.session.completed. Resets the period bucket for a business.
-- Creates the balance row if it doesn't exist yet (first payment).

CREATE OR REPLACE FUNCTION public.grant_period_tokens(
  p_business_id  uuid,
  p_user_id      uuid,
  p_tokens       integer,
  p_period_start timestamptz,
  p_period_end   timestamptz
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.token_balances
    (business_id, user_id, period_tokens_included, period_tokens_used,
     period_started_at, period_ends_at)
  VALUES
    (p_business_id, p_user_id, p_tokens, 0, p_period_start, p_period_end)
  ON CONFLICT (business_id) DO UPDATE SET
    period_tokens_included = p_tokens,
    period_tokens_used     = 0,
    period_started_at      = p_period_start,
    period_ends_at         = p_period_end,
    updated_at             = now();

  INSERT INTO public.token_transactions
    (business_id, user_id, kind, tokens, description)
  VALUES
    (p_business_id, p_user_id, 'credit_subscription_grant', p_tokens,
     'Monthly subscription token grant');
END;
$$;


-- ── 9. RPC: add_topup_tokens ───────────────────────────────────────
-- Called by the Stripe webhook handler on a succeeded top-up payment.
-- Adds tokens to the top-up bucket (which does not reset at period end).

CREATE OR REPLACE FUNCTION public.add_topup_tokens(
  p_business_id uuid,
  p_user_id     uuid,
  p_tokens      integer,
  p_topup_id    uuid,
  p_description text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.token_balances SET
    topup_tokens_remaining    = topup_tokens_remaining    + p_tokens,
    lifetime_topups_purchased = lifetime_topups_purchased + p_tokens,
    updated_at                = now()
  WHERE business_id = p_business_id;

  INSERT INTO public.token_transactions
    (business_id, user_id, kind, tokens, topup_id, description)
  VALUES
    (p_business_id, p_user_id, 'credit_topup', p_tokens, p_topup_id, p_description);
END;
$$;


-- ── 10. Verification queries (run manually in Supabase after migration) ──

-- D.1.a — Confirm new tables exist (expect 4 rows)
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public'
--   AND table_name IN ('business_subscriptions','token_balances',
--                      'token_transactions','token_purchases')
-- ORDER BY table_name;

-- D.1.b — Confirm token_cost column (expect integer, default 0)
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'tasks' AND column_name = 'token_cost';

-- D.1.c — Confirm token_cost backfill (verify mission-dashboard = 1, not 0)
-- SELECT token_cost, COUNT(*), array_agg(slug ORDER BY slug)
-- FROM public.tasks
-- GROUP BY token_cost
-- ORDER BY token_cost;

-- D.1.d — Confirm Stripe Connect columns on businesses (expect 3 rows)
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'businesses' AND column_name LIKE 'stripe_connect%'
-- ORDER BY column_name;

-- D.1.e — Confirm payment_source column on business_subscriptions
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'business_subscriptions' AND column_name = 'payment_source';

-- D.1.f — Confirm task_output_type enum has image + image_set
-- SELECT enum_range(NULL::task_output_type);

-- D.1.g — Confirm subscription_plans state (standard_monthly active, others inactive)
-- SELECT slug, name, monthly_cents, business_quota, is_active
-- FROM public.subscription_plans
-- ORDER BY is_active DESC, slug;

-- D.1.h — Confirm RPC functions exist with SECURITY DEFINER (expect 3 rows)
-- SELECT routine_name, security_type
-- FROM information_schema.routines
-- WHERE routine_schema = 'public'
--   AND routine_name IN ('debit_tokens','grant_period_tokens','add_topup_tokens');

-- D.1.i — Confirm RLS on new tables (expect 4 rows, all rowsecurity=true)
-- SELECT tablename, rowsecurity
-- FROM pg_tables
-- WHERE schemaname = 'public'
--   AND tablename IN ('business_subscriptions','token_balances',
--                     'token_transactions','token_purchases');
