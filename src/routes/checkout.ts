import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { verifySupabaseJwt } from "../lib/jwt";
import { createSupabaseClient } from "../services/supabase";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";

const app = new Hono<{ Bindings: Env }>();

const CheckoutBody = z.object({
  tier: z.enum(["core_monthly", "founder_lifetime"]),
});

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

app.post("/start", async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json(errBody("not_configured", "Stripe not yet configured — add STRIPE_SECRET_KEY secret"), 503);
  }

  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json(errBody("unauthorized", "missing Authorization header"), 401);
  }

  let auth;
  try {
    auth = await verifySupabaseJwt(authHeader.slice(7), c.env);
  } catch {
    return c.json(errBody("unauthorized", "invalid token"), 401);
  }

  let parsed;
  try {
    parsed = CheckoutBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", String(err)), 400);
  }

  const priceId =
    parsed.tier === "core_monthly"
      ? c.env.STRIPE_PRICE_ID_CORE_MONTHLY
      : c.env.STRIPE_PRICE_ID_FOUNDER_LIFETIME;

  if (!priceId) {
    return c.json(
      errBody("not_configured", `Stripe price ID for ${parsed.tier} not yet configured`),
      503,
    );
  }

  const supabase = createSupabaseClient(c.env);

  const { data: user, error: userErr } = await supabase
    .from("users")
    .select("id, email, stripe_customer_id")
    .eq("id", auth.user_id)
    .single();

  if (userErr || !user) {
    return c.json(errBody("not_found", "user not found"), 404);
  }

  let customerId: string = (user as { stripe_customer_id?: string }).stripe_customer_id ?? "";

  // Create Stripe customer on first checkout
  if (!customerId) {
    const res = await stripePost(
      "/customers",
      { email: user.email, "metadata[textos_user_id]": user.id },
      c.env.STRIPE_SECRET_KEY,
    );
    if (!res.ok) {
      const txt = await res.text();
      log.error("stripe_customer_create_failed", { err: txt });
      return c.json(errBody("upstream_error", "Stripe customer creation failed"), 502);
    }
    const customer = (await res.json()) as { id: string };
    customerId = customer.id;
    await supabase.from("users").update({ stripe_customer_id: customerId }).eq("id", user.id);
  }

  const origin = "https://textos.ai";
  const sessionParams: Record<string, string> = {
    customer: customerId,
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    mode: parsed.tier === "founder_lifetime" ? "payment" : "subscription",
    success_url: `${origin}/onboarding?checkout=success`,
    cancel_url: `${origin}/`,
    "metadata[textos_user_id]": user.id,
    "metadata[tier]": parsed.tier,
  };

  const res = await stripePost("/checkout/sessions", sessionParams, c.env.STRIPE_SECRET_KEY);
  if (!res.ok) {
    const txt = await res.text();
    log.error("stripe_session_create_failed", { err: txt });
    return c.json(errBody("upstream_error", "Stripe session creation failed"), 502);
  }

  const session = (await res.json()) as { url: string };
  log.info("checkout_session_created", { user_id: user.id, tier: parsed.tier });
  return c.json({ checkout_url: session.url });
});

export default app;
