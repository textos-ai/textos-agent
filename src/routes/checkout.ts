import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import { createSupabaseClient } from "../services/supabase";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";

const app = new Hono<{ Bindings: Env }>();

app.use("*", requireAuth);

const SUCCESS_URL = "https://app.textos.ai/business/builder?stripe_success=1";
const CANCEL_URL  = "https://app.textos.ai/business/builder?stripe_cancel=1";

// ── Stripe helper ─────────────────────────────────────────────────────────────

async function stripePost(
  path: string,
  params: Record<string, string>,
  secretKey: string,
): Promise<Response> {
  return fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });
}

// ── Customer helper ───────────────────────────────────────────────────────────

async function getOrCreateStripeCustomer(
  supabase: ReturnType<typeof createSupabaseClient>,
  userId: string,
  email: string,
  stripeSecretKey: string,
): Promise<string> {
  const { data: user } = await supabase
    .from("users")
    .select("stripe_customer_id")
    .eq("id", userId)
    .single();

  if (user?.stripe_customer_id) return user.stripe_customer_id as string;

  const res = await stripePost(
    "/customers",
    { email, "metadata[textos_user_id]": userId },
    stripeSecretKey,
  );
  if (!res.ok) {
    const body = await res.text();
    log.error("[checkout] customer_create_failed", { user_id: userId, err: body });
    throw new Error("customer_create_failed");
  }
  const customer = (await res.json()) as { id: string };
  await supabase
    .from("users")
    .update({ stripe_customer_id: customer.id })
    .eq("id", userId);
  return customer.id;
}

// ── POST /subscription ────────────────────────────────────────────────────────

const SubscriptionBody = z.object({
  business_id: z.string().uuid(),
});

app.post("/subscription", async (c) => {
  const { user_id, email } = c.get("auth");

  if (!c.env.STRIPE_SECRET_KEY || !c.env.STRIPE_PRICE_STANDARD_MONTHLY) {
    return c.json(errBody("not_configured", "Stripe not configured"), 503);
  }

  let parsed: z.infer<typeof SubscriptionBody>;
  try {
    parsed = SubscriptionBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", String(err)), 400);
  }
  const { business_id } = parsed;

  const supabase = createSupabaseClient(c.env);

  // Verify business ownership — collapse not-found + not-owned to 404; surface real DB errors as 500
  const { data: business, error: bizErr } = await supabase
    .from("businesses")
    .select("id")
    .eq("id", business_id)
    .eq("user_id", user_id)
    .single();

  if (bizErr && bizErr.code !== "PGRST116") {
    log.error("[checkout] business_lookup_failed", { user_id, business_id, err: bizErr.message });
    return c.json(errBody("internal", "business_lookup_failed"), 500);
  }
  if (!business) {
    return c.json(errBody("not_found", "business not found"), 404);
  }

  // Pre-check: reject if active/trialing/past_due subscription already exists
  const { data: existingSub, error: subCheckErr } = await supabase
    .from("business_subscriptions")
    .select("id")
    .eq("business_id", business_id)
    .in("status", ["trialing", "active", "past_due"])
    .maybeSingle();

  if (subCheckErr) {
    log.error("[checkout] subscription_precheck_failed", {
      user_id,
      business_id,
      err: subCheckErr.message,
    });
    return c.json(errBody("internal", "subscription_precheck_failed"), 500);
  }
  if (existingSub) {
    return c.json(errBody("conflict", "business already has an active subscription"), 409);
  }

  // Get or create Stripe customer (email from JWT auth context, no extra DB read)
  let customerId: string;
  try {
    customerId = await getOrCreateStripeCustomer(supabase, user_id, email, c.env.STRIPE_SECRET_KEY);
  } catch (err) {
    log.error("[checkout] customer_create_failed", {
      user_id,
      business_id,
      err: err instanceof Error ? err.message : String(err),
    });
    return c.json(errBody("upstream_error", "customer_create_failed"), 502);
  }

  // Create Stripe Checkout Session (subscription mode, 3-day trial)
  const sessionRes = await stripePost(
    "/checkout/sessions",
    {
      mode: "subscription",
      customer: customerId,
      "line_items[0][price]": c.env.STRIPE_PRICE_STANDARD_MONTHLY,
      "line_items[0][quantity]": "1",
      "subscription_data[trial_period_days]": "3",
      allow_promotion_codes: "true",
      "metadata[textos_user_id]": user_id,
      "metadata[business_id]": business_id,
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
    },
    c.env.STRIPE_SECRET_KEY,
  );

  if (!sessionRes.ok) {
    const body = await sessionRes.text();
    log.error("[checkout] subscription_session_create_failed", {
      user_id,
      business_id,
      err: body,
    });
    return c.json(errBody("upstream_error", "subscription_session_create_failed"), 502);
  }

  const session = (await sessionRes.json()) as { url: string };
  log.info("[checkout] subscription_session_created", { user_id, business_id });
  return c.json({ url: session.url });
});

// ── POST /topup ───────────────────────────────────────────────────────────────

const BUNDLE_TOKENS: Record<string, string> = {
  topup_10: "10",
  topup_30: "30",
  topup_75: "75",
};

const TopupBody = z.object({
  business_id: z.string().uuid(),
  bundle: z.enum(["topup_10", "topup_30", "topup_75"]),
});

app.post("/topup", async (c) => {
  const { user_id, email } = c.get("auth");

  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json(errBody("not_configured", "Stripe not configured"), 503);
  }

  let parsed: z.infer<typeof TopupBody>;
  try {
    parsed = TopupBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", String(err)), 400);
  }
  const { business_id, bundle } = parsed;

  // Map bundle → price ID (env var must be set for the selected bundle)
  const priceId = {
    topup_10: c.env.STRIPE_PRICE_TOPUP_10,
    topup_30: c.env.STRIPE_PRICE_TOPUP_30,
    topup_75: c.env.STRIPE_PRICE_TOPUP_75,
  }[bundle];

  if (!priceId) {
    return c.json(errBody("not_configured", `Stripe price ID for ${bundle} not configured`), 503);
  }

  const supabase = createSupabaseClient(c.env);

  // Verify business ownership — collapse not-found + not-owned to 404; surface real DB errors as 500
  const { data: business, error: bizErr } = await supabase
    .from("businesses")
    .select("id")
    .eq("id", business_id)
    .eq("user_id", user_id)
    .single();

  if (bizErr && bizErr.code !== "PGRST116") {
    log.error("[checkout] business_lookup_failed", { user_id, business_id, err: bizErr.message });
    return c.json(errBody("internal", "business_lookup_failed"), 500);
  }
  if (!business) {
    return c.json(errBody("not_found", "business not found"), 404);
  }

  // Pre-check: top-up requires an active or trialing subscription (past_due excluded)
  const { data: activeSub, error: subCheckErr } = await supabase
    .from("business_subscriptions")
    .select("id")
    .eq("business_id", business_id)
    .in("status", ["trialing", "active"])
    .maybeSingle();

  if (subCheckErr) {
    log.error("[checkout] subscription_precheck_failed", {
      user_id,
      business_id,
      err: subCheckErr.message,
    });
    return c.json(errBody("internal", "subscription_precheck_failed"), 500);
  }
  if (!activeSub) {
    return c.json(errBody("conflict", "no active subscription — top-up requires an active subscription"), 409);
  }

  // Get or create Stripe customer
  let customerId: string;
  try {
    customerId = await getOrCreateStripeCustomer(supabase, user_id, email, c.env.STRIPE_SECRET_KEY);
  } catch (err) {
    log.error("[checkout] customer_create_failed", {
      user_id,
      business_id,
      err: err instanceof Error ? err.message : String(err),
    });
    return c.json(errBody("upstream_error", "customer_create_failed"), 502);
  }

  // Create Stripe Checkout Session (payment mode, one-time top-up)
  const sessionRes = await stripePost(
    "/checkout/sessions",
    {
      mode: "payment",
      customer: customerId,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      "metadata[textos_user_id]": user_id,
      "metadata[business_id]": business_id,
      "metadata[intent]": bundle,
      "metadata[tokens]": BUNDLE_TOKENS[bundle],
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
    },
    c.env.STRIPE_SECRET_KEY,
  );

  if (!sessionRes.ok) {
    const body = await sessionRes.text();
    log.error("[checkout] topup_session_create_failed", {
      user_id,
      business_id,
      bundle,
      err: body,
    });
    return c.json(errBody("upstream_error", "topup_session_create_failed"), 502);
  }

  const session = (await sessionRes.json()) as { url: string };
  log.info("[checkout] topup_session_created", { user_id, business_id, bundle });
  return c.json({ url: session.url });
});

export default app;

