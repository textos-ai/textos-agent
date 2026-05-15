import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import { createSupabaseClient, getBusinessBySlug } from "../services/supabase";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);

// ── GET /:slug/billing/balance ────────────────────────────────────────────────
app.get("/:slug/billing/balance", async (c) => {
  const { user_id } = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  let business;
  try {
    business = await getBusinessBySlug(supabase, user_id, slug);
  } catch (err) {
    log.error("[billing] business_lookup_failed", { slug, err: String(err) });
    return c.json(errBody("internal", "business_lookup_failed"), 500);
  }
  if (!business) return c.json(errBody("not_found", "business not found"), 404);

  const [balRes, subRes] = await Promise.all([
    supabase
      .from("token_balances")
      .select("*")
      .eq("business_id", business.id)
      .maybeSingle(),
    // Most recent subscription row. `subscription_status` reflects current
    // billing state of this business — frontend uses it to gate pre-sub UI.
    // active/trialing → subscribed. Anything else (null, canceled, past_due,
    // expired, incomplete) → treat as pre-sub.
    supabase
      .from("business_subscriptions")
      .select("status")
      .eq("business_id", business.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (balRes.error) {
    log.error("[billing] balance_lookup_failed", {
      slug,
      business_id: business.id,
      err: balRes.error.message,
    });
    return c.json(errBody("internal", "balance_lookup_failed"), 500);
  }
  // Non-fatal: if sub lookup errors, surface null status (frontend treats as pre-sub).
  if (subRes.error) {
    log.error("[billing] sub_lookup_failed", {
      slug,
      business_id: business.id,
      err: subRes.error.message,
    });
  }

  const subscription_status = (subRes.data?.status as string | undefined) ?? null;
  const balance = balRes.data;

  if (!balance) {
    return c.json({
      business_id: business.id,
      period_tokens_included: 0,
      period_tokens_used: 0,
      period_tokens_remaining: 0,
      topup_tokens_remaining: 0,
      total_remaining: 0,
      period_started_at: null,
      lifetime_tokens_used: 0,
      lifetime_topups_purchased: 0,
      subscription_status,
    });
  }

  const period_remaining = Math.max(
    0,
    (balance.period_tokens_included as number) - (balance.period_tokens_used as number),
  );
  const total_remaining = period_remaining + (balance.topup_tokens_remaining as number);

  return c.json({
    business_id: business.id,
    period_tokens_included:    balance.period_tokens_included,
    period_tokens_used:        balance.period_tokens_used,
    period_tokens_remaining:   period_remaining,
    topup_tokens_remaining:    balance.topup_tokens_remaining,
    total_remaining,
    period_started_at:         balance.period_started_at,
    lifetime_tokens_used:      balance.lifetime_tokens_used,
    lifetime_topups_purchased: balance.lifetime_topups_purchased,
    subscription_status,
  });
});

// ── GET /:slug/billing/subscription ──────────────────────────────────────────
app.get("/:slug/billing/subscription", async (c) => {
  const { user_id } = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  let business;
  try {
    business = await getBusinessBySlug(supabase, user_id, slug);
  } catch (err) {
    log.error("[billing] business_lookup_failed", { slug, err: String(err) });
    return c.json(errBody("internal", "business_lookup_failed"), 500);
  }
  if (!business) return c.json(errBody("not_found", "business not found"), 404);

  const { data: sub, error: subErr } = await supabase
    .from("business_subscriptions")
    .select("*")
    .eq("business_id", business.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (subErr) {
    log.error("[billing] subscription_lookup_failed", {
      slug,
      business_id: business.id,
      err: subErr.message,
    });
    return c.json(errBody("internal", "subscription_lookup_failed"), 500);
  }

  if (!sub) return c.json(errBody("not_found", "no subscription"), 404);

  return c.json({
    business_id:              business.id,
    status:                   sub.status,
    stripe_subscription_id:   sub.stripe_subscription_id,
    stripe_customer_id:       sub.stripe_customer_id,
    current_period_start:     sub.current_period_start,
    current_period_end:       sub.current_period_end,
    cancel_at_period_end:     sub.cancel_at_period_end,
    canceled_at:              sub.canceled_at,
    created_at:               sub.created_at,
    updated_at:               sub.updated_at,
  });
});

// ── GET /:slug/billing/transactions ──────────────────────────────────────────
app.get("/:slug/billing/transactions", async (c) => {
  const { user_id } = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  let business;
  try {
    business = await getBusinessBySlug(supabase, user_id, slug);
  } catch (err) {
    log.error("[billing] business_lookup_failed", { slug, err: String(err) });
    return c.json(errBody("internal", "business_lookup_failed"), 500);
  }
  if (!business) return c.json(errBody("not_found", "business not found"), 404);

  const limitRaw = parseInt(c.req.query("limit") ?? "50", 10);
  const limit = Math.min(Math.max(Number.isNaN(limitRaw) ? 50 : limitRaw, 1), 100);
  const before = c.req.query("before");

  let q = supabase
    .from("token_transactions")
    .select(
      "id, kind, tokens, task_slug, task_run_id, topup_id, description, metadata, created_at",
    )
    .eq("business_id", business.id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (before) {
    q = q.lt("created_at", before);
  }

  const { data: rows, error: txErr } = await q;

  if (txErr) {
    log.error("[billing] transactions_lookup_failed", {
      slug,
      business_id: business.id,
      err: txErr.message,
    });
    return c.json(errBody("internal", "transactions_lookup_failed"), 500);
  }

  const has_more = (rows?.length ?? 0) > limit;
  const transactions = (rows ?? []).slice(0, limit);
  const next_before = has_more
    ? (transactions[transactions.length - 1].created_at as string)
    : null;

  return c.json({ transactions, has_more, next_before });
});

// ── GET /:slug/billing/purchases ──────────────────────────────────────────────
app.get("/:slug/billing/purchases", async (c) => {
  const { user_id } = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  let business;
  try {
    business = await getBusinessBySlug(supabase, user_id, slug);
  } catch (err) {
    log.error("[billing] business_lookup_failed", { slug, err: String(err) });
    return c.json(errBody("internal", "business_lookup_failed"), 500);
  }
  if (!business) return c.json(errBody("not_found", "business not found"), 404);

  const { data: purchases, error: purErr } = await supabase
    .from("token_purchases")
    .select(
      "id, bundle_slug, tokens_purchased, amount_cents, stripe_payment_intent_id, status, succeeded_at, refunded_at, created_at",
    )
    .eq("business_id", business.id)
    .order("created_at", { ascending: false });

  if (purErr) {
    log.error("[billing] purchases_lookup_failed", {
      slug,
      business_id: business.id,
      err: purErr.message,
    });
    return c.json(errBody("internal", "purchases_lookup_failed"), 500);
  }

  return c.json({ purchases: purchases ?? [] });
});

export default app;
