import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import { createSupabaseClient } from "../services/supabase";
import { errBody } from "../lib/errors";
import { log, persistError } from "../lib/logger";
import { stripeCustomerIdColumn } from "../lib/stripe-mode";
import { validateReturnTo } from "../lib/validate-return-to";

const app = new Hono<{ Bindings: Env }>();

app.use("*", requireAuth);

// ── Slug-aware return URLs ────────────────────────────────────────────────────
// Subscription return: ?stripe_success=1 / ?stripe_cancel=1  (Phase 7A-C handler)
// Topup return:        ?topup=success&bundle=…&tokens=… / ?topup=canceled  (Phase 7D)
// Base URL is per-environment via env.FRONTEND_URL (wrangler [vars]). Fallback
// to production URL keeps things working if the var is missing on a worker.
const DEFAULT_FRONTEND_URL = "https://app.textos.ai";

// Append a query string to a (possibly query/hash-bearing) path, choosing the
// right separator and preserving any #hash. Shared by the topup return URLs.
function appendQuery(path: string, qs: string): string {
  const hashIdx = path.indexOf("#");
  const before = hashIdx >= 0 ? path.slice(0, hashIdx) : path;
  const hash   = hashIdx >= 0 ? path.slice(hashIdx)   : "";
  const sep    = before.includes("?") ? "&" : "?";
  return `${before}${sep}${qs}${hash}`;
}
// returnPath is a pre-validated path starting with "/" (no host), or null. When
// null we default to the business's Victora playbook — NEVER /builder. The
// existing topup signal (?topup=success&bundle=&tokens=) is appended so the
// frontend's balance-refresh handling still fires.
function topupSuccessUrl(env: Env, slug: string, returnPath: string | null, bundle: string, tokens: number): string {
  const base = env.FRONTEND_URL ?? DEFAULT_FRONTEND_URL;
  const path = returnPath ?? `/business/${slug}/playbook`;
  return `${base}${appendQuery(path, `topup=success&bundle=${bundle}&tokens=${tokens}`)}`;
}
function topupCancelUrl(env: Env, slug: string, returnPath: string | null): string {
  const base = env.FRONTEND_URL ?? DEFAULT_FRONTEND_URL;
  const path = returnPath ?? `/business/${slug}/playbook`;
  return `${base}${appendQuery(path, `topup=canceled`)}`;
}
// returnPath is a pre-validated path starting with "/" (no host). If null,
// the default per-business `/live` page is used. The Stripe flag is appended
// using the existing query separator so callers can pass paths that already
// contain a query string.
function appendStripeFlag(path: string, flag: "stripe_success=1" | "stripe_cancel=1"): string {
  const hashIdx = path.indexOf("#");
  const before = hashIdx >= 0 ? path.slice(0, hashIdx) : path;
  const hash   = hashIdx >= 0 ? path.slice(hashIdx)   : "";
  const sep    = before.includes("?") ? "&" : "?";
  return `${before}${sep}${flag}${hash}`;
}
function subSuccessUrl(env: Env, slug: string, returnPath: string | null): string {
  const base = env.FRONTEND_URL ?? DEFAULT_FRONTEND_URL;
  const path = returnPath ?? `/business/${slug}/live`;
  return `${base}${appendStripeFlag(path, "stripe_success=1")}`;
}
function subCancelUrl(env: Env, slug: string, returnPath: string | null): string {
  const base = env.FRONTEND_URL ?? DEFAULT_FRONTEND_URL;
  const path = returnPath ?? `/business/${slug}/live`;
  return `${base}${appendStripeFlag(path, "stripe_cancel=1")}`;
}

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
  customerCol: "stripe_customer_id" | "stripe_customer_id_test",
): Promise<string> {
  const { data: user } = await supabase
    .from("users")
    .select(customerCol)
    .eq("id", userId)
    .single();

  const existing = user ? (user as Record<string, unknown>)[customerCol] : null;
  if (existing) return existing as string;

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
    .update({ [customerCol]: customer.id })
    .eq("id", userId);
  return customer.id;
}

// ── POST /subscription ────────────────────────────────────────────────────────

const SubscriptionBody = z.object({
  business_id: z.string().uuid(),
  return_to: z.string().optional(),
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
  const returnPath = validateReturnTo(parsed.return_to);

  const supabase = createSupabaseClient(c.env);

  // Verify business ownership — collapse not-found + not-owned to 404; surface real DB errors as 500
  const { data: business, error: bizErr } = await supabase
    .from("businesses")
    .select("id, slug")
    .eq("id", business_id)
    .eq("user_id", user_id)
    .eq("is_active", true) // can't checkout for a deactivated biz
    .single();

  if (bizErr && bizErr.code !== "PGRST116") {
    log.error("[checkout] business_lookup_failed", { user_id, business_id, err: bizErr.message });
    await persistError(supabase, "error", "[checkout]", "business_lookup_failed", { user_id, business_id, err: bizErr.message });
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
    await persistError(supabase, "error", "[checkout]", "subscription_precheck_failed", { user_id, business_id, err: subCheckErr.message });
    return c.json(errBody("internal", "subscription_precheck_failed"), 500);
  }
  if (existingSub) {
    return c.json(errBody("conflict", "business already has an active subscription"), 409);
  }

  // Get or create Stripe customer (email from JWT auth context, no extra DB read)
  let customerId: string;
  try {
    customerId = await getOrCreateStripeCustomer(
      supabase,
      user_id,
      email,
      c.env.STRIPE_SECRET_KEY,
      stripeCustomerIdColumn(c.env),
    );
  } catch (err) {
    log.error("[checkout] customer_create_failed", {
      user_id,
      business_id,
      err: err instanceof Error ? err.message : String(err),
    });
    await persistError(supabase, "error", "[checkout]", "customer_create_failed", { user_id, business_id, err: err instanceof Error ? err.message : String(err) });
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
      "automatic_tax[enabled]": "true",
      "metadata[textos_user_id]": user_id,
      "metadata[business_id]": business_id,
      "customer_update[address]": "auto",
      success_url: subSuccessUrl(c.env, business.slug as string, returnPath),
      cancel_url: subCancelUrl(c.env, business.slug as string, returnPath),
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
    await persistError(supabase, "error", "[checkout]", "subscription_session_create_failed", { user_id, business_id, err: body });
    return c.json(errBody("upstream_error", "subscription_session_create_failed"), 502);
  }

  const session = (await sessionRes.json()) as { url: string };
  log.info("[checkout] subscription_session_created", {
    user_id,
    business_id,
    return_to_raw: parsed.return_to ?? null,
    return_to_used: returnPath ?? `/business/${business.slug}/live`,
  });
  return c.json({ url: session.url });
});

// ── POST /topup ───────────────────────────────────────────────────────────────

const BUNDLE_TOKENS: Record<string, number> = {
  topup_10: 10,
  topup_30: 30,
  topup_75: 75,
};

const TopupBody = z.object({
  business_id: z.string().uuid(),
  bundle: z.enum(["topup_10", "topup_30", "topup_75"]),
  return_to: z.string().optional(),
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
  // Validate/whitelist the return target (same-origin path only). Invalid or
  // missing → null → topup URLs fall back to the business's playbook. No open redirect.
  const returnPath = validateReturnTo(parsed.return_to);

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
    .select("id, slug")
    .eq("id", business_id)
    .eq("user_id", user_id)
    .eq("is_active", true) // can't checkout for a deactivated biz
    .single();

  if (bizErr && bizErr.code !== "PGRST116") {
    log.error("[checkout] business_lookup_failed", { user_id, business_id, err: bizErr.message });
    await persistError(supabase, "error", "[checkout]", "business_lookup_failed", { user_id, business_id, err: bizErr.message });
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
    await persistError(supabase, "error", "[checkout]", "subscription_precheck_failed", { user_id, business_id, err: subCheckErr.message });
    return c.json(errBody("internal", "subscription_precheck_failed"), 500);
  }
  if (!activeSub) {
    return c.json(errBody("conflict", "no active subscription — top-up requires an active subscription"), 409);
  }

  // Get or create Stripe customer
  let customerId: string;
  try {
    customerId = await getOrCreateStripeCustomer(
      supabase,
      user_id,
      email,
      c.env.STRIPE_SECRET_KEY,
      stripeCustomerIdColumn(c.env),
    );
  } catch (err) {
    log.error("[checkout] customer_create_failed", {
      user_id,
      business_id,
      err: err instanceof Error ? err.message : String(err),
    });
    await persistError(supabase, "error", "[checkout]", "customer_create_failed", { user_id, business_id, err: err instanceof Error ? err.message : String(err) });
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
      "metadata[tokens]": String(BUNDLE_TOKENS[bundle]),
      "automatic_tax[enabled]": "true",
      "customer_update[address]": "auto",
      success_url: topupSuccessUrl(c.env, business.slug as string, returnPath, bundle, BUNDLE_TOKENS[bundle]),
      cancel_url: topupCancelUrl(c.env, business.slug as string, returnPath),
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
    await persistError(supabase, "error", "[checkout]", "topup_session_create_failed", { user_id, business_id, bundle, err: body });
    return c.json(errBody("upstream_error", "topup_session_create_failed"), 502);
  }

  const session = (await sessionRes.json()) as { url: string };
  log.info("[checkout] topup_session_created", {
    user_id,
    business_id,
    bundle,
    return_to_raw: parsed.return_to ?? null,
    return_to_used: returnPath ?? `/business/${business.slug}/playbook`,
  });
  return c.json({ url: session.url });
});

export default app;

