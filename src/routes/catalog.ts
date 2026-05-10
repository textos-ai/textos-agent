import { Hono } from "hono";
import type { Env } from "../env";
import { createSupabaseClient } from "../services/supabase";
import { log } from "../lib/logger";

const app = new Hono<{ Bindings: Env }>();

/**
 * Public catalog endpoint — no auth required for discovery.
 *
 * Forward-compatible with V3 marketplace: creator field will surface
 * real author names once tasks.creator_id is added. For V1 all tasks
 * are TextOS-authored so creator is hardcoded.
 */
app.get("/tasks", async (c) => {
  const supabase = createSupabaseClient(c.env);

  const { data, error } = await supabase
    .from("tasks")
    .select(`
      id,
      slug,
      name,
      description_short,
      description_long,
      area,
      is_default,
      plan_required,
      visibility,
      price_cents,
      output_type,
      execution_order,
      status
    `)
    .eq("status", "active")
    .neq("plan_required", "premium_inactive")
    .order("execution_order", { ascending: true, nullsFirst: false })
    .order("name", { ascending: true });

  if (error) {
    log.error("catalog_fetch_failed", { err: String(error) });
    return c.json({ error: "catalog unavailable" }, 500);
  }

  const tagged = (data as any[]).map(t => ({
    ...t,
    creator: { id: null, name: "TextOS" },
    category: deriveCategory(t),
  }));

  const free       = tagged.filter(t => t.plan_required === "free");
  const core       = tagged.filter(t => t.plan_required === "core_paid");
  const premium    = tagged.filter(t => t.plan_required === "premium_only");

  c.header("Cache-Control", "public, max-age=300");
  return c.json({
    free,
    core_monthly: core,
    premium_only: premium,
    total: tagged.length,
    categories: getUniqueCategories(tagged),
  });
});

function deriveCategory(task: any): string {
  const s: string = task.slug || "";

  if (s.includes("research") || s.includes("market") ||
      s === "tam-sam-som" || s === "competitive-analysis") {
    return "Research";
  }
  if (s === "mission-document" || s === "dashboard-briefing" ||
      s === "task-queue-built" || s === "lean-canvas") {
    return "Strategy";
  }
  if (s.includes("email") || s.includes("outreach") ||
      s === "launch-tweet" || s === "social-content-plan") {
    return "Marketing & Outreach";
  }
  if (s === "business-landing-page" || s === "public-business-website" ||
      s === "business-website") {
    return "Web Presence";
  }
  if (s === "stripe-connect-setup" || s.includes("registration") ||
      s.includes("cpa") || s.includes("bookkeeper")) {
    return "Operations & Setup";
  }
  if (s === "investor-data-room" || s === "investor-deck" ||
      s === "pitch-deck" || s === "investor-alignment" ||
      s === "executive-summary") {
    return "Fundraising";
  }
  if (s === "exit-strategy" || s === "accelerator-match" ||
      s === "mentor-identification") {
    return "Growth";
  }
  if (s === "daycycle-connect" || task.area === "daycycle") {
    return "Daily Operations";
  }
  return "Other";
}

function getUniqueCategories(tasks: any[]): string[] {
  return Array.from(new Set(tasks.map(t => t.category as string))).sort();
}

export default app;
