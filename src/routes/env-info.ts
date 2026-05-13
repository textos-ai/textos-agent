import { Hono } from "hono";
import type { Env } from "../env";

const app = new Hono<{ Bindings: Env }>();

// GET /api/env/mode
// Returns { stripe_mode: "test" | "live" | "unknown" } based on the
// Stripe secret key prefix. Frontend banner renders iff stripe_mode === "test".
// "unknown" or fetch failure → no banner, which is the safe default (false
// positives on production are worse than false negatives on test).
//
// No auth required, lightweight, 60s public cache. Called once per session.
app.get("/mode", (c) => {
  const key = c.env.STRIPE_SECRET_KEY ?? "";
  const stripe_mode =
    key.startsWith("sk_test_") ? "test"
    : key.startsWith("sk_live_") ? "live"
    : "unknown";
  c.header("Cache-Control", "public, max-age=60");
  return c.json({ stripe_mode });
});

export default app;
