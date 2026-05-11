import { Hono } from "hono";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../env";
import { createSupabaseClient } from "../services/supabase";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";

const app = new Hono<{ Bindings: Env }>();

// ── Constants ──────────────────────────────────────────────────────────────
// V1.1 cleanup: move this to subscription_plans.token_allowance column.
const STANDARD_MONTHLY_TOKEN_GRANT = 30;

// Cents per top-up bundle — mirrors Stripe product prices; used to populate
// token_purchases.amount_cents without an extra Stripe API call.
const BUNDLE_AMOUNT_CENTS: Record<string, number> = {
  topup_10: 999,
  topup_30: 2499,
  topup_75: 4999,
};

// ── Stripe event type shapes ───────────────────────────────────────────────

interface StripeCheckoutSession {
  id: string;
  mode: "subscription" | "payment" | "setup";
  payment_status: string;
  payment_intent: string | null;
  subscription: string | null;
  customer: string | null;
  metadata: Record<string, string | undefined> | null;
}

interface StripeSubscriptionItem {
  current_period_start?: number;
  current_period_end?: number;
}

interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  current_period_start?: number;
  current_period_end?: number;
  items?: { data: StripeSubscriptionItem[] };
}

interface StripeInvoiceLineItem {
  period?: { start?: number; end?: number };
}

interface StripeInvoice {
  id: string;
  customer: string;
  subscription: string | null;
  billing_reason: string;
  amount_paid: number;
  lines?: { data: StripeInvoiceLineItem[] };
}

interface StripeCharge {
  id: string;
  customer: string | null;
  invoice: string | null;        // set for subscription invoice charges
  payment_intent: string | null; // set for one-time payment charges
  amount_refunded: number;       // cents; may be partial — treated as full for V1
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: unknown };
}

// ── Stripe GET helper (used by refund handler to resolve invoice → sub) ──────

async function stripeGet<T>(path: string, secretKey: string): Promise<T> {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`stripe_get_failed path=${path} status=${res.status} body=${body}`);
  }
  return res.json() as Promise<T>;
}

// ── Signature verification (unchanged from working implementation) ──────────

async function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string,
): Promise<boolean> {
  const parts: Record<string, string> = {};
  for (const chunk of header.split(",")) {
    const eq = chunk.indexOf("=");
    if (eq > -1) parts[chunk.slice(0, eq)] = chunk.slice(eq + 1);
  }
  const timestamp = parts["t"];
  const sig = parts["v1"];
  if (!timestamp || !sig) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const computed = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return computed === sig;
}

// ── Helpers ────────────────────────────────────────────────────────────────

interface BizSubRow { id: string; business_id: string; user_id: string; }

async function lookupBusinessSub(
  supabase: SupabaseClient,
  stripeSubId: string,
): Promise<BizSubRow | null> {
  const { data, error } = await supabase
    .from("business_subscriptions")
    .select("id, business_id, user_id")
    .eq("stripe_subscription_id", stripeSubId)
    .maybeSingle();
  if (error) throw new Error(`business_sub_lookup_failed stripe_subscription_id=${stripeSubId}: ${error.message}`);
  return data as BizSubRow | null;
}

function extractPeriod(sub: StripeSubscription): { start: string; end: string } | null {
  const item = sub.items?.data?.[0];
  const rawStart = item?.current_period_start ?? sub.current_period_start;
  const rawEnd   = item?.current_period_end   ?? sub.current_period_end;
  if (!rawStart || !rawEnd) return null;
  return {
    start: new Date(rawStart * 1000).toISOString(),
    end:   new Date(rawEnd   * 1000).toISOString(),
  };
}

async function markProcessed(supabase: SupabaseClient, eventId: string): Promise<void> {
  const { error } = await supabase
    .from("stripe_events")
    .update({ processed_at: new Date().toISOString() })
    .eq("event_id", eventId);
  if (error) throw new Error(`mark_processed_failed event_id=${eventId}: ${error.message}`);
}

// Best-effort: called from error paths that already return 500. If this update
// fails, we still return 500 to Stripe — the error is not lost, just unrecorded
// in stripe_events.error. Log the failure and continue.
async function markError(supabase: SupabaseClient, eventId: string, errMsg: string): Promise<void> {
  const { error } = await supabase
    .from("stripe_events")
    .update({ error: errMsg })
    .eq("event_id", eventId);
  if (error) {
    log.error("[stripe-webhook] mark_error_update_failed", { event_id: eventId, original_err: errMsg, update_err: error.message });
  }
}

// ── Event handlers ─────────────────────────────────────────────────────────

interface HandlerResult { code: number; msg: string; }

async function handleCheckoutCompleted(
  session: StripeCheckoutSession,
  supabase: SupabaseClient,
  eventId: string,
): Promise<HandlerResult> {
  const userId = session.metadata?.textos_user_id;
  if (!userId) {
    return { code: 400, msg: "checkout_completed_missing_textos_user_id" };
  }

  // ── Subscription checkout ────────────────────────────────────────────────
  if (session.mode === "subscription") {
    const businessId = session.metadata?.business_id;
    if (!businessId) {
      return { code: 400, msg: "checkout_subscription_missing_business_id" };
    }
    const stripeSubId = session.subscription;
    if (!stripeSubId) {
      return { code: 400, msg: "checkout_subscription_id_null" };
    }

    const now = new Date().toISOString();
    // period_end approximation — customer.subscription.updated corrects the real dates.
    const approxPeriodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const approxTrialEnd  = new Date(Date.now() +  3 * 24 * 60 * 60 * 1000).toISOString();

    const { error: subError } = await supabase
      .from("business_subscriptions")
      .upsert(
        {
          business_id:          businessId,
          user_id:              userId,
          plan_slug:            "standard_monthly",
          status:               "trialing",
          trial_started_at:     now,
          trial_ends_at:        approxTrialEnd,
          current_period_start: now,
          current_period_end:   approxPeriodEnd,
          stripe_customer_id:   session.customer ?? "",
          stripe_subscription_id: stripeSubId,
          payment_source:       "card",
        },
        { onConflict: "stripe_subscription_id" },
      );
    if (subError) throw new Error(`business_subscriptions_upsert_failed: ${subError.message}`);

    const { error: grantError } = await supabase.rpc("grant_period_tokens", {
      p_business_id:  businessId,
      p_user_id:      userId,
      p_tokens:       STANDARD_MONTHLY_TOKEN_GRANT,
      p_period_start: now,
      p_period_end:   approxPeriodEnd,
    });
    if (grantError) throw new Error(`grant_period_tokens_failed: ${grantError.message}`);

    log.info("[stripe-webhook] checkout_subscription_activated", {
      event_id: eventId,
      user_id: userId,
      business_id: businessId,
      stripe_subscription_id: stripeSubId,
      tokens_granted: STANDARD_MONTHLY_TOKEN_GRANT,
    });
    return { code: 200, msg: "ok" };
  }

  // ── Top-up checkout ──────────────────────────────────────────────────────
  if (session.mode === "payment") {
    const businessId = session.metadata?.business_id;
    if (!businessId) {
      // Phase 4 contract: checkout.ts must include metadata[business_id] for top-ups.
      return { code: 400, msg: "checkout_topup_missing_business_id" };
    }

    const intentMeta = session.metadata?.intent;
    if (!intentMeta?.startsWith("topup_")) {
      return { code: 400, msg: "checkout_payment_unknown_intent" };
    }
    const bundleSlug = intentMeta as "topup_10" | "topup_30" | "topup_75";

    const tokensRaw = session.metadata?.tokens;
    const tokens = tokensRaw ? parseInt(tokensRaw, 10) : NaN;
    if (!Number.isFinite(tokens) || tokens <= 0) {
      return { code: 400, msg: "checkout_topup_invalid_token_count" };
    }

    if (!session.payment_intent) {
      // Shouldn't occur for card payments; fail loud so Stripe retries.
      return { code: 500, msg: "checkout_topup_payment_intent_null" };
    }

    const amountCents = BUNDLE_AMOUNT_CENTS[bundleSlug] ?? 0;

    // Insert purchase record — stripe_payment_intent_id is UNIQUE (idempotent).
    const { data: purchaseData, error: purchaseError } = await supabase
      .from("token_purchases")
      .insert({
        business_id:                businessId,
        user_id:                    userId,
        bundle_slug:                bundleSlug,
        tokens_purchased:           tokens,
        amount_cents:               amountCents,
        stripe_payment_intent_id:   session.payment_intent,
        stripe_checkout_session_id: session.id,
        status:                     "succeeded",
        succeeded_at:               new Date().toISOString(),
      })
      .select("id")
      .single();

    if (purchaseError) {
      if (purchaseError.code === "23505") {
        log.info("[stripe-webhook] topup_already_recorded", {
          event_id: eventId,
          user_id: userId,
          business_id: businessId,
          payment_intent: session.payment_intent,
        });
        return { code: 200, msg: "topup_already_recorded" };
      }
      throw new Error(`token_purchase_insert_failed: ${purchaseError.message}`);
    }

    // add_topup_tokens expects p_topup_id = token_purchases.id (uuid).
    const { error: topupError } = await supabase.rpc("add_topup_tokens", {
      p_business_id: businessId,
      p_user_id:     userId,
      p_tokens:      tokens,
      p_topup_id:    purchaseData.id,
      p_description: `Top-up: ${tokens} tokens (${bundleSlug})`,
    });
    if (topupError) throw new Error(`add_topup_tokens_failed: ${topupError.message}`);

    log.info("[stripe-webhook] topup_completed", {
      event_id: eventId,
      user_id: userId,
      business_id: businessId,
      bundle_slug: bundleSlug,
      tokens,
      payment_intent: session.payment_intent,
    });
    return { code: 200, msg: "ok" };
  }

  // mode=setup or unknown
  log.info("[stripe-webhook] checkout_mode_unhandled", { event_id: eventId, mode: session.mode });
  return { code: 200, msg: "unhandled_checkout_mode" };
}

async function handleSubscriptionUpdated(
  sub: StripeSubscription,
  supabase: SupabaseClient,
  eventId: string,
): Promise<HandlerResult> {
  const bizSub = await lookupBusinessSub(supabase, sub.id);
  if (!bizSub) {
    // B.5: Stripe fired subscription.updated before checkout.session.completed
    // created the business_subscriptions row. Log and return 200 — the row will
    // exist once checkout.session.completed processes; subsequent events will sync.
    log.warn("[stripe-webhook] subscription_update_before_checkout_create", {
      event_id: eventId,
      stripe_subscription_id: sub.id,
      subscription_status: sub.status,
    });
    return { code: 200, msg: "subscription_update_before_checkout_create" };
  }

  const period = extractPeriod(sub);
  if (!period) {
    throw new Error(`current_period_fields_missing stripe_subscription_id=${sub.id} event_id=${eventId}`);
  }

  const { error } = await supabase
    .from("business_subscriptions")
    .update({
      status:               sub.status,
      current_period_start: period.start,
      current_period_end:   period.end,
      cancel_at_period_end: sub.cancel_at_period_end,
      updated_at:           new Date().toISOString(),
    })
    .eq("id", bizSub.id);
  if (error) throw new Error(`subscription_update_db_failed: ${error.message}`);

  log.info("[stripe-webhook] subscription_updated", {
    event_id: eventId,
    stripe_subscription_id: sub.id,
    status: sub.status,
    cancel_at_period_end: sub.cancel_at_period_end,
    business_id: bizSub.business_id,
    period_end: period.end,
  });
  return { code: 200, msg: "ok" };
}

async function handleSubscriptionDeleted(
  sub: StripeSubscription,
  supabase: SupabaseClient,
  eventId: string,
): Promise<HandlerResult> {
  const bizSub = await lookupBusinessSub(supabase, sub.id);
  if (!bizSub) {
    log.warn("[stripe-webhook] subscription_delete_before_checkout_create", {
      event_id: eventId,
      stripe_subscription_id: sub.id,
    });
    return { code: 200, msg: "subscription_delete_before_checkout_create" };
  }

  const { error } = await supabase
    .from("business_subscriptions")
    .update({
      status:      "canceled",
      canceled_at: new Date().toISOString(),
      updated_at:  new Date().toISOString(),
    })
    .eq("id", bizSub.id);
  if (error) throw new Error(`subscription_cancel_db_failed: ${error.message}`);

  log.info("[stripe-webhook] subscription_deleted", {
    event_id: eventId,
    stripe_subscription_id: sub.id,
    business_id: bizSub.business_id,
  });
  return { code: 200, msg: "ok" };
}

async function handleInvoicePaid(
  invoice: StripeInvoice,
  supabase: SupabaseClient,
  eventId: string,
): Promise<HandlerResult> {
  if (!invoice.subscription) {
    log.info("[stripe-webhook] invoice_paid_no_subscription", { event_id: eventId, invoice_id: invoice.id });
    return { code: 200, msg: "invoice_paid_no_subscription" };
  }

  const billing = invoice.billing_reason;

  // subscription_create: tokens already granted at checkout.session.completed — skip.
  if (billing === "subscription_create") {
    log.info("[stripe-webhook] invoice_paid_subscription_create_skipped", {
      event_id: eventId,
      invoice_id: invoice.id,
      billing_reason: billing,
    });
    return { code: 200, msg: "invoice_paid_subscription_create_skipped" };
  }

  // manual: out-of-cycle invoice from Stripe Dashboard — skip to prevent accidental grants.
  if (billing === "manual") {
    log.warn("[stripe-webhook] invoice_paid_manual_billing_skipped", {
      event_id: eventId,
      invoice_id: invoice.id,
      billing_reason: billing,
    });
    return { code: 200, msg: "invoice_paid_manual_billing_skipped" };
  }

  // Any billing_reason other than subscription_cycle: log + return 200.
  if (billing !== "subscription_cycle") {
    log.warn("[stripe-webhook] invoice_paid_unhandled_billing_reason", {
      event_id: eventId,
      invoice_id: invoice.id,
      billing_reason: billing,
    });
    return { code: 200, msg: `unhandled_billing_reason=${billing}` };
  }

  // subscription_cycle: renewal → look up subscription row.
  const bizSub = await lookupBusinessSub(supabase, invoice.subscription);
  if (!bizSub) {
    // We received payment for a subscription we don't recognise — loud failure.
    log.error("[stripe-webhook] invoice_paid_no_business_subscription", {
      event_id: eventId,
      invoice_id: invoice.id,
      stripe_subscription_id: invoice.subscription,
    });
    return { code: 500, msg: "invoice_paid_no_business_subscription" };
  }

  // Period dates from the first invoice line item.
  const lineItem = invoice.lines?.data?.[0];
  const rawStart = lineItem?.period?.start;
  const rawEnd   = lineItem?.period?.end;
  if (!rawStart || !rawEnd) {
    throw new Error(`invoice_period_fields_missing invoice_id=${invoice.id} event_id=${eventId}`);
  }
  const periodStart = new Date(rawStart * 1000).toISOString();
  const periodEnd   = new Date(rawEnd   * 1000).toISOString();

  const { error: subError } = await supabase
    .from("business_subscriptions")
    .update({
      status:               "active",
      current_period_start: periodStart,
      current_period_end:   periodEnd,
      updated_at:           new Date().toISOString(),
    })
    .eq("id", bizSub.id);
  if (subError) throw new Error(`subscription_period_update_failed: ${subError.message}`);

  const { error: grantError } = await supabase.rpc("grant_period_tokens", {
    p_business_id:  bizSub.business_id,
    p_user_id:      bizSub.user_id,
    p_tokens:       STANDARD_MONTHLY_TOKEN_GRANT,
    p_period_start: periodStart,
    p_period_end:   periodEnd,
  });
  if (grantError) throw new Error(`grant_period_tokens_renewal_failed: ${grantError.message}`);

  log.info("[stripe-webhook] invoice_paid_renewal_tokens_granted", {
    event_id: eventId,
    invoice_id: invoice.id,
    stripe_subscription_id: invoice.subscription,
    business_id: bizSub.business_id,
    tokens_granted: STANDARD_MONTHLY_TOKEN_GRANT,
    period_start: periodStart,
    period_end: periodEnd,
  });
  return { code: 200, msg: "ok" };
}

async function handleInvoiceFailed(
  invoice: StripeInvoice,
  supabase: SupabaseClient,
  eventId: string,
): Promise<HandlerResult> {
  if (!invoice.subscription) {
    log.info("[stripe-webhook] invoice_failed_no_subscription", { event_id: eventId, invoice_id: invoice.id });
    return { code: 200, msg: "invoice_failed_no_subscription" };
  }

  const bizSub = await lookupBusinessSub(supabase, invoice.subscription);
  if (!bizSub) {
    // Failed invoice for an unrecognised subscription — loud failure, wants investigation.
    log.error("[stripe-webhook] invoice_failed_no_business_subscription", {
      event_id: eventId,
      invoice_id: invoice.id,
      stripe_subscription_id: invoice.subscription,
    });
    return { code: 500, msg: "invoice_failed_no_business_subscription" };
  }

  const { error } = await supabase
    .from("business_subscriptions")
    .update({
      status:     "past_due",
      updated_at: new Date().toISOString(),
    })
    .eq("id", bizSub.id);
  if (error) throw new Error(`subscription_past_due_update_failed: ${error.message}`);

  log.info("[stripe-webhook] invoice_payment_failed_marked_past_due", {
    event_id: eventId,
    invoice_id: invoice.id,
    stripe_subscription_id: invoice.subscription,
    business_id: bizSub.business_id,
  });
  return { code: 200, msg: "ok" };
}

async function handleChargeRefunded(
  charge: StripeCharge,
  supabase: SupabaseClient,
  eventId: string,
  stripeSecretKey: string,
): Promise<HandlerResult> {
  // ── Case 1: Subscription invoice refund ───────────────────────────────────
  // charge.invoice is set when Stripe refunded a subscription invoice charge.
  // Fetch the invoice to get the subscription_id, then reverse the period grant.
  if (charge.invoice) {
    let subscriptionId: string | null = null;
    try {
      const invoice = await stripeGet<{ subscription: string | null }>(
        `/invoices/${charge.invoice}`,
        stripeSecretKey,
      );
      subscriptionId = invoice.subscription;
    } catch (err) {
      log.error("[stripe-webhook] refund_invoice_fetch_failed", {
        event_id: eventId,
        charge_id: charge.id,
        invoice_id: charge.invoice,
        err: err instanceof Error ? err.message : String(err),
      });
      return { code: 500, msg: "refund_invoice_fetch_failed" };
    }

    if (!subscriptionId) {
      // Invoice exists but has no subscription — unusual, can't reverse tokens.
      log.warn("[stripe-webhook] refund_invoice_no_subscription", {
        event_id: eventId,
        charge_id: charge.id,
        invoice_id: charge.invoice,
      });
      return { code: 200, msg: "refund_invoice_no_subscription" };
    }

    const bizSub = await lookupBusinessSub(supabase, subscriptionId);
    if (!bizSub) {
      log.warn("[stripe-webhook] refund_subscription_not_found", {
        event_id: eventId,
        charge_id: charge.id,
        stripe_subscription_id: subscriptionId,
      });
      return { code: 200, msg: "refund_subscription_not_found" };
    }

    // Look up the actual period grant so we reverse what was given, not the
    // current V1 constant — these diverge if plan amounts change post-launch.
    const { data: balance, error: balanceErr } = await supabase
      .from("token_balances")
      .select("period_tokens_included")
      .eq("business_id", bizSub.business_id)
      .maybeSingle();

    if (balanceErr) throw new Error(`token_balances_lookup_failed: ${balanceErr.message}`);

    if (!balance || balance.period_tokens_included <= 0) {
      log.warn("[stripe-webhook] refund_no_tokens_to_reverse", {
        event_id: eventId,
        charge_id: charge.id,
        business_id: bizSub.business_id,
        period_tokens_included: balance?.period_tokens_included ?? null,
      });
      return { code: 200, msg: "refund_no_tokens_to_reverse" };
    }

    const tokensToReverse = balance.period_tokens_included;

    const { error: refundErr } = await supabase.rpc("refund_period_tokens", {
      p_business_id: bizSub.business_id,
      p_user_id:     bizSub.user_id,
      p_tokens:      tokensToReverse,
      p_description: `Subscription refund (charge ${charge.id})`,
    });
    if (refundErr) throw new Error(`refund_period_tokens_failed: ${refundErr.message}`);

    log.info("[stripe-webhook] refund_subscription_period_reversed", {
      event_id: eventId,
      charge_id: charge.id,
      stripe_subscription_id: subscriptionId,
      business_id: bizSub.business_id,
      tokens_reversed: tokensToReverse,
    });
    return { code: 200, msg: "ok" };
  }

  // ── Case 2: Top-up refund ─────────────────────────────────────────────────
  // charge.payment_intent matches a row in token_purchases.
  if (charge.payment_intent) {
    const { data: purchase, error: lookupErr } = await supabase
      .from("token_purchases")
      .select("id, business_id, user_id, tokens_purchased, status")
      .eq("stripe_payment_intent_id", charge.payment_intent)
      .maybeSingle();

    if (lookupErr) throw new Error(`topup_purchase_lookup_failed: ${lookupErr.message}`);

    if (!purchase) {
      // payment_intent not in our records — charge from outside TextOS or pre-launch.
      log.warn("[stripe-webhook] refund_unknown_origin", {
        event_id: eventId,
        charge_id: charge.id,
        payment_intent: charge.payment_intent,
      });
      return { code: 200, msg: "refund_unknown_origin" };
    }

    if (purchase.status === "refunded") {
      log.info("[stripe-webhook] refund_topup_already_refunded", {
        event_id: eventId,
        charge_id: charge.id,
        topup_id: purchase.id,
      });
      return { code: 200, msg: "refund_topup_already_refunded" };
    }

    const { error: refundErr } = await supabase.rpc("refund_topup_tokens", {
      p_business_id: purchase.business_id,
      p_user_id:     purchase.user_id,
      p_tokens:      purchase.tokens_purchased,
      p_topup_id:    purchase.id,
      p_description: `Top-up refund (charge ${charge.id})`,
    });
    if (refundErr) throw new Error(`refund_topup_tokens_failed: ${refundErr.message}`);

    const { error: updateErr } = await supabase
      .from("token_purchases")
      .update({ status: "refunded", refunded_at: new Date().toISOString() })
      .eq("id", purchase.id);
    if (updateErr) throw new Error(`token_purchase_refund_update_failed: ${updateErr.message}`);

    log.info("[stripe-webhook] refund_topup_reversed", {
      event_id: eventId,
      charge_id: charge.id,
      topup_id: purchase.id,
      business_id: purchase.business_id,
      tokens_reversed: purchase.tokens_purchased,
    });
    return { code: 200, msg: "ok" };
  }

  // ── Neither invoice nor payment_intent ────────────────────────────────────
  log.warn("[stripe-webhook] refund_unknown_origin", {
    event_id: eventId,
    charge_id: charge.id,
    invoice: charge.invoice,
    payment_intent: charge.payment_intent,
  });
  return { code: 200, msg: "refund_unknown_origin" };
}

// ── POST /webhook ──────────────────────────────────────────────────────────

app.post("/webhook", async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET) {
    return c.json(errBody("not_configured", "STRIPE_WEBHOOK_SECRET not set"), 503);
  }

  const payload = await c.req.text();
  const sig = c.req.header("stripe-signature") ?? "";

  const valid = await verifyStripeSignature(payload, sig, c.env.STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    log.warn("[stripe-webhook] signature_invalid", { sig_prefix: sig.slice(0, 20) });
    return c.json(errBody("unauthorized", "invalid stripe signature"), 400);
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(payload) as StripeEvent;
  } catch {
    return c.json(errBody("bad_request", "invalid json payload"), 400);
  }

  const eventId   = event.id;
  const eventType = event.type;

  log.info("[stripe-webhook] received", { event_id: eventId, event_type: eventType });

  const supabase = createSupabaseClient(c.env);

  // ── Idempotency gate ───────────────────────────────────────────────────────
  // INSERT event_id as PRIMARY KEY. On conflict, check processed state:
  //   processed_at set  → clean dedup hit → 200
  //   error set         → retry after failure → clear error and re-process
  //   both null         → concurrent worker in flight → 200
  const { error: insertError } = await supabase
    .from("stripe_events")
    .insert({ event_id: eventId, event_type: eventType });

  if (insertError) {
    if (insertError.code === "23505") {
      const { data: existing } = await supabase
        .from("stripe_events")
        .select("processed_at, error")
        .eq("event_id", eventId)
        .single();

      if (existing?.processed_at) {
        log.info("[stripe-webhook] dedup_hit_already_processed", { event_id: eventId });
        return c.json({ received: true });
      }

      if (existing?.error) {
        // Stripe is retrying a previously failed event. Clear the error and re-process.
        log.info("[stripe-webhook] dedup_retry_after_error", {
          event_id: eventId,
          prev_error: existing.error,
        });
        await supabase
          .from("stripe_events")
          .update({ error: null, received_at: new Date().toISOString() })
          .eq("event_id", eventId);
        // Fall through to handler below.
      } else {
        // No processed_at and no error: assume the first delivery is still in-flight.
        // Returning 200 prevents Stripe from queuing a concurrent retry. If the
        // first delivery later fails it will set `error`; Stripe's own 72h retry
        // schedule will re-deliver and the retry-after-error branch above will clear it.
        log.info("[stripe-webhook] dedup_hit_in_flight", { event_id: eventId });
        return c.json({ received: true });
      }
    } else {
      log.error("[stripe-webhook] stripe_events_insert_failed", {
        event_id: eventId,
        err: insertError.message,
      });
      return c.json(errBody("internal", "stripe_events_insert_failed"), 500);
    }
  }

  // ── Route to handler ───────────────────────────────────────────────────────
  let result: HandlerResult;
  const obj = event.data.object;

  try {
    switch (eventType) {
      case "checkout.session.completed":
        result = await handleCheckoutCompleted(obj as StripeCheckoutSession, supabase, eventId);
        break;
      case "customer.subscription.updated":
        result = await handleSubscriptionUpdated(obj as StripeSubscription, supabase, eventId);
        break;
      case "customer.subscription.deleted":
        result = await handleSubscriptionDeleted(obj as StripeSubscription, supabase, eventId);
        break;
      case "invoice.payment_succeeded":
        result = await handleInvoicePaid(obj as StripeInvoice, supabase, eventId);
        break;
      case "invoice.payment_failed":
        result = await handleInvoiceFailed(obj as StripeInvoice, supabase, eventId);
        break;
      case "charge.refunded":
        result = await handleChargeRefunded(obj as StripeCharge, supabase, eventId, c.env.STRIPE_SECRET_KEY);
        break;
      default:
        log.info("[stripe-webhook] unhandled_event_type", { event_id: eventId, event_type: eventType });
        result = { code: 200, msg: "unhandled_event_type" };
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error("[stripe-webhook] handler_exception", {
      event_id: eventId,
      event_type: eventType,
      err: errMsg,
    });
    await markError(supabase, eventId, errMsg);
    return c.json(errBody("internal", errMsg), 500);
  }

  // ── Finalise ───────────────────────────────────────────────────────────────
  if (result.code >= 500) {
    await markError(supabase, eventId, result.msg);
    log.error("[stripe-webhook] handler_returned_5xx", {
      event_id: eventId,
      event_type: eventType,
      code: result.code,
      msg: result.msg,
    });
    return c.json(errBody("internal", result.msg), 500);
  }

  if (result.code >= 400) {
    // 4xx: invalid payload — Stripe won't retry. Mark processed so manual
    // redeliveries short-circuit at the dedup gate instead of re-erroring.
    await markProcessed(supabase, eventId);
    log.error("[stripe-webhook] handler_returned_4xx", {
      event_id: eventId,
      event_type: eventType,
      code: result.code,
      msg: result.msg,
    });
    return c.json(errBody("bad_request", result.msg), 400);
  }

  await markProcessed(supabase, eventId);
  log.info("[stripe-webhook] processed", {
    event_id: eventId,
    event_type: eventType,
    msg: result.msg,
  });
  return c.json({ received: true });
});

export default app;
