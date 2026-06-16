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
      is_featured,
      plan_required,
      visibility,
      price_cents,
      token_cost,
      prompt_template,
      output_type,
      execution_order,
      status,
      kind,
      config_page_path,
      lifecycle_phase_id,
      is_regeneratable,
      asset_user_editable,
      text_controllable,
      lifecycle_phases(slug, name)
    `)
    .eq("status", "active")
    .neq("plan_required", "premium_inactive")
    .neq("surface", "silent")
    .neq("kind", "system")
    .order("execution_order", { ascending: true, nullsFirst: false })
    .order("name", { ascending: true });

  if (error) {
    log.error("catalog_fetch_failed", { err: String(error) });
    return c.json({ error: "catalog unavailable" }, 500);
  }

  // Redact prompt_template from public payload — admins author these in the
  // admin panel; frontend only needs to know if one exists (for Coming Soon
  // detection at the tile level).
  const tagged = (data as any[]).map((t) => {
    const { prompt_template, ...rest } = t;
    return {
      ...rest,
      has_prompt_template:
        typeof prompt_template === "string" && prompt_template.trim() !== "",
      creator: { id: null, name: "Victora" },
      category: deriveCategory(t),
    };
  });

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

// GET /api/catalog/lifecycle-phases
// Returns the small static list of business lifecycle phases (~6 rows).
// Public — no auth required. Uses service-role Supabase client to bypass
// RLS on the lifecycle_phases table, which is otherwise locked to admins
// and would silently return null for nested joins from the frontend.
app.get("/lifecycle-phases", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const { data, error } = await supabase
    .from("lifecycle_phases")
    .select("id, slug, name, sort_order")
    .order("sort_order", { ascending: true });
  if (error) {
    log.error("lifecycle_phases_fetch_failed", { err: String(error) });
    return c.json({ error: "lifecycle_phases unavailable" }, 500);
  }
  c.header("Cache-Control", "public, max-age=300");
  return c.json({ phases: data ?? [] });
});

// GET /api/catalog/objectives
// Returns the customer objectives (migration 046) + each objective's tasks.
// Public — no auth. Uses service-role to bypass RLS on objectives /
// task_objectives (owner-locked, like lifecycle_phases). Business-agnostic:
// the per-business done state is computed frontend-side from task_runs.
// Excludes is_utility objectives (not a customer mission). prompt_template is
// REDACTED → has_prompt_template (same as /tasks; frontend uses it for the
// runnable / Coming Soon check via isTaskRunnableNow).
app.get("/objectives", async (c) => {
  const supabase = createSupabaseClient(c.env);

  const [objsRes, linksRes] = await Promise.all([
    supabase
      .from("objectives")
      .select("id, slug, name, tagline, display_order, is_utility")
      .order("display_order", { ascending: true }),
    supabase.from("task_objectives").select("task_id, objective_id"),
  ]);

  if (objsRes.error || linksRes.error) {
    log.error("objectives_fetch_failed", {
      err: String(objsRes.error ?? linksRes.error),
    });
    return c.json({ error: "objectives unavailable" }, 500);
  }

  const links = linksRes.data ?? [];
  const taskIds = Array.from(new Set(links.map((l) => l.task_id)));

  const { data: taskRows, error: tErr } = await supabase
    .from("tasks")
    .select(
      "id, slug, name, output_type, token_cost, prompt_template, status, config_page_path, description_long, description_short, lifecycle_phase_id, execution_order, kind, is_featured, progress_verb",
    )
    .in("id", taskIds)
    .neq("kind", "system")
    .neq("status", "deprecated");

  if (tErr) {
    log.error("objectives_tasks_fetch_failed", { err: String(tErr) });
    return c.json({ error: "objectives unavailable" }, 500);
  }

  const tasks: Record<string, any> = {};
  for (const t of taskRows ?? []) {
    const { prompt_template, kind, ...rest } = t as any;
    tasks[t.id] = {
      ...rest,
      has_prompt_template:
        typeof prompt_template === "string" && prompt_template.trim() !== "",
    };
  }

  const byObjective: Record<string, string[]> = {};
  for (const l of links) {
    if (!tasks[l.task_id]) continue; // dropped by the system/deprecated filter
    (byObjective[l.objective_id] ||= []).push(l.task_id);
  }

  const objectives = (objsRes.data ?? [])
    .filter((o) => !o.is_utility)
    .map((o) => ({
      id: o.id,
      slug: o.slug,
      name: o.name,
      tagline: o.tagline,
      display_order: o.display_order,
      task_ids: byObjective[o.id] ?? [],
    }));

  c.header("Cache-Control", "public, max-age=300");
  return c.json({ objectives, tasks });
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
