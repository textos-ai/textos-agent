import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import {
  createSupabaseClient,
  countBusinessContextByUser,
} from "../services/supabase";

const app = new Hono<{ Bindings: Env }>();

app.use("*", requireAuth);

app.get("/", async (c) => {
  const auth = c.get("auth");
  const supabase = createSupabaseClient(c.env);

  // Smoke test for business_context table (Sprint 3.5).
  // Returns 0 for new users — that's correct. Any DB error here means
  // the table doesn't exist or RLS is misconfigured.
  const business_context_count = await countBusinessContextByUser(
    supabase,
    auth.user_id,
  );

  return c.json({ ...auth, business_context_count });
});

export default app;
