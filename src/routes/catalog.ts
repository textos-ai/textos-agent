import { Hono } from "hono";
import type { Env } from "../env";
import { createSupabaseClient } from "../services/supabase";
import { log } from "../lib/logger";

const app = new Hono<{ Bindings: Env }>();

/** Public catalog endpoint — no auth required. Used by the marketing homepage. */
app.get("/tasks", async (c) => {
  const supabase = createSupabaseClient(c.env);

  const { data, error } = await supabase
    .from("tasks")
    .select("slug, name, plan_required, price_cents")
    .eq("status", "active")
    .neq("plan_required", "premium_inactive")
    .order("execution_order", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    log.error("catalog_fetch_failed", { err: String(error) });
    return c.json({ error: "catalog unavailable" }, 500);
  }

  const free        = data.filter((t) => t.plan_required === "free");
  const core        = data.filter((t) => t.plan_required === "core_paid");
  const premium     = data.filter((t) => t.plan_required === "premium_only");

  c.header("Cache-Control", "public, max-age=300");
  return c.json({ free, core_monthly: core, premium_only: premium });
});

export default app;
