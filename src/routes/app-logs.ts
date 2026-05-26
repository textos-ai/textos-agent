// Dedicated route file for the generate-business-app log panel.
//
// Mounted at /api/app-logs in src/index.ts. Lives in its own Hono
// sub-app and at its own URL prefix specifically to avoid the
// multi-mount dispatch ambiguity at /api/businesses, where five
// sub-apps share the same prefix and a new GET /:slug/app-logs
// handler kept 404-ing despite being registered.
//
// Route surface:
//   GET /api/app-logs/:slug
//     Returns the most recent stream_events rows for this business
//     filtered to event_type LIKE 'gen_app_%', shimmed to the
//     {logs:[{id, task_run_id, event, data, logged_at}]} contract
//     the frontend already consumes.

import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import { log } from "../lib/logger";
import { errBody } from "../lib/errors";
import {
  createSupabaseClient,
  getBusinessBySlug,
  type BusinessRow,
} from "../services/supabase";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);

app.get("/:slug", async (c) => {
  // Route-hit probe (kept from the prior business-task-run.ts location).
  // Bare console.log — no genAppLog, no DB writes — so it appears in
  // tail regardless of auth/sink/DB state.
  console.log(
    "[app-logs] route_hit",
    JSON.stringify({
      slug: c.req.param("slug"),
      path: c.req.path,
      ts: new Date().toISOString(),
    }),
  );
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  let business: BusinessRow | null;
  try {
    business = await getBusinessBySlug(supabase, auth.user_id, slug);
  } catch (err) {
    log.error("[app-logs] business_lookup_failed", {
      slug,
      err: String(err),
    });
    return c.json(errBody("internal", "business_lookup_failed"), 500);
  }
  if (!business) {
    return c.json(errBody("not_found", `business '${slug}' not found`), 404);
  }

  const { data, error } = await supabase
    .from("stream_events")
    .select("id, run_id, event_type, event_data, created_at")
    .eq("business_id", business.id)
    .like("event_type", "gen_app_%")
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    log.error("[app-logs] lookup_failed", {
      business_id: business.id,
      err: error.message,
    });
    return c.json(errBody("internal", "stream_events_lookup_failed"), 500);
  }

  // Reshape to the {logs:[{task_run_id, event, data, logged_at}]}
  // contract the frontend already consumes. Strip the "gen_app_" prefix
  // from event_type so apps.astro renders the original event names
  // (e.g. "design_handler_entry" rather than "gen_app_design_handler_entry").
  const logs = (data ?? []).map(
    (r: {
      id: string;
      run_id: string | null;
      event_type: string;
      event_data: Record<string, unknown> | null;
      created_at: string;
    }) => ({
      id: r.id,
      task_run_id: r.run_id,
      event: r.event_type.startsWith("gen_app_")
        ? r.event_type.slice("gen_app_".length)
        : r.event_type,
      data: r.event_data ?? {},
      logged_at: r.created_at,
    }),
  );

  return c.json({ logs });
});

export default app;
