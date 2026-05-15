import type { Env } from "../env";

/**
 * Stripe enforces strict mode isolation: live-mode and test-mode customers
 * cannot see each other. A single `stripe_customer_id` column on
 * public.users would mean the column's value is only valid for one mode
 * at a time — flipping a worker's STRIPE_SECRET_KEY between modes breaks
 * every existing user.
 *
 * We solve this with two columns:
 *   - public.users.stripe_customer_id        — LIVE-mode customer ID
 *   - public.users.stripe_customer_id_test   — TEST-mode customer ID
 *
 * This helper returns the column name appropriate for the worker's
 * configured Stripe key. Callers should select / update that column
 * instead of hardcoding "stripe_customer_id".
 */
export function stripeCustomerIdColumn(
  env: Env,
): "stripe_customer_id" | "stripe_customer_id_test" {
  return env.STRIPE_SECRET_KEY?.startsWith("sk_test_")
    ? "stripe_customer_id_test"
    : "stripe_customer_id";
}
