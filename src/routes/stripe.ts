import { Hono } from "hono";
import type { Env } from "../env";
import { createSupabaseClient } from "../services/supabase";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";

const app = new Hono<{ Bindings: Env }>();

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

app.post("/webhook", async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET) {
    return c.json(errBody("not_configured", "webhook secret not set"), 503);
  }

  const payload = await c.req.text();
  const sig = c.req.header("stripe-signature") ?? "";

  const valid = await verifyStripeSignature(payload, sig, c.env.STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    return c.json(errBody("unauthorized", "invalid stripe signature"), 400);
  }

  let event: { type: string; data: { object: Record<string, unknown> } };
  try {
    event = JSON.parse(payload);
  } catch {
    return c.json(errBody("bad_request", "invalid json"), 400);
  }

  const supabase = createSupabaseClient(c.env);
  const now = new Date().toISOString();

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Record<string, Record<string, string>>;
    const userId = session.metadata?.textos_user_id;
    const tier = session.metadata?.tier as "core_monthly" | "founder_lifetime" | undefined;
    if (userId && tier) {
      const { error } = await supabase
        .from("users")
        .update({ tier, tier_updated_at: now })
        .eq("id", userId);
      if (error) log.error("webhook_tier_update_failed", { err: String(error), userId });
      else log.info("tier_updated", { userId, tier, event: event.type });
    }
  } else if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object as Record<string, string>;
    const customerId = sub.customer;
    if (customerId) {
      const { error } = await supabase
        .from("users")
        .update({ tier: "free", tier_updated_at: now })
        .eq("stripe_customer_id", customerId);
      if (error) log.error("webhook_tier_downgrade_failed", { err: String(error), customerId });
      else log.info("tier_downgraded", { customerId, event: event.type });
    }
  }

  return c.json({ received: true });
});

export default app;
