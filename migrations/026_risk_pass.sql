-- =====================================================================
-- Migration 026: Risk Pass — refunds + admin grants + RPC hardening
-- =====================================================================
-- Source: Day 13 Risk Pass (May 11, 2026)
-- Contents:
--   1. token_purchases.refunded_at column
--   2. Hardened debit_tokens RPC (reject p_tokens <= 0)
--   3. refund_period_tokens RPC
--   4. refund_topup_tokens RPC
--   5. admin_grant_tokens RPC
--
-- Apply via Supabase SQL Editor.
-- Safe to re-run: CREATE OR REPLACE FUNCTION + ADD COLUMN IF NOT EXISTS.
-- =====================================================================

ALTER TABLE public.token_purchases
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz;

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
  IF p_tokens IS NULL OR p_tokens <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_token_count', 'requested', p_tokens);
  END IF;

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

CREATE OR REPLACE FUNCTION public.refund_period_tokens(
  p_business_id  uuid,
  p_user_id      uuid,
  p_tokens       integer,
  p_description  text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_tokens IS NULL OR p_tokens <= 0 THEN
    RAISE EXCEPTION 'refund_period_tokens: p_tokens must be positive (got %)', p_tokens;
  END IF;

  UPDATE public.token_balances SET
    period_tokens_included = GREATEST(0, period_tokens_included - p_tokens),
    updated_at = now()
  WHERE business_id = p_business_id;

  INSERT INTO public.token_transactions
    (business_id, user_id, kind, tokens, description)
  VALUES
    (p_business_id, p_user_id, 'credit_refund', -p_tokens, p_description);
END;
$$;

CREATE OR REPLACE FUNCTION public.refund_topup_tokens(
  p_business_id  uuid,
  p_user_id      uuid,
  p_tokens       integer,
  p_topup_id     uuid,
  p_description  text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_tokens IS NULL OR p_tokens <= 0 THEN
    RAISE EXCEPTION 'refund_topup_tokens: p_tokens must be positive (got %)', p_tokens;
  END IF;

  UPDATE public.token_balances SET
    topup_tokens_remaining = GREATEST(0, topup_tokens_remaining - p_tokens),
    updated_at = now()
  WHERE business_id = p_business_id;

  INSERT INTO public.token_transactions
    (business_id, user_id, kind, tokens, topup_id, description)
  VALUES
    (p_business_id, p_user_id, 'credit_refund', -p_tokens, p_topup_id, p_description);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_grant_tokens(
  p_business_id  uuid,
  p_user_id      uuid,
  p_tokens       integer,
  p_reason       text,
  p_granted_by   text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_tokens IS NULL OR p_tokens <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_token_count');
  END IF;

  INSERT INTO public.token_balances
    (business_id, user_id, period_tokens_included, period_tokens_used,
     topup_tokens_remaining, period_started_at)
  VALUES
    (p_business_id, p_user_id, 0, 0, p_tokens, now())
  ON CONFLICT (business_id) DO UPDATE SET
    topup_tokens_remaining    = token_balances.topup_tokens_remaining + p_tokens,
    lifetime_topups_purchased = token_balances.lifetime_topups_purchased + p_tokens,
    updated_at                = now();

  INSERT INTO public.token_transactions
    (business_id, user_id, kind, tokens, description, metadata)
  VALUES
    (p_business_id, p_user_id, 'credit_admin_adjust', p_tokens,
     p_reason,
     jsonb_build_object('granted_by', p_granted_by));

  RETURN jsonb_build_object('ok', true, 'tokens_granted', p_tokens);
END;
$$;

-- Verification:
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'token_purchases' AND column_name = 'refunded_at';
-- SELECT routine_name FROM information_schema.routines
--   WHERE routine_schema = 'public'
--     AND routine_name IN ('debit_tokens','refund_period_tokens',
--                          'refund_topup_tokens','admin_grant_tokens');
