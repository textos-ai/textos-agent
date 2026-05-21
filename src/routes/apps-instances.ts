import { Hono } from "hono";
import { requireAuth } from "../lib/jwt";
import { createSupabaseClient } from "../services/supabase";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";
import type { Env } from "../env";

const router = new Hono<{ Bindings: Env }>();

// ── PATCH /api/business-apps/:id/config ───────────────────────────
// Update config for an installed app
router.patch("/:id/config", requireAuth, async (c) => {
  const { user_id } = c.get("auth");
  const { id } = c.req.param();
  const { config } = await c.req.json();
  if (!config) return c.json(errBody("config is required"), 400);
  const sb = createSupabaseClient(c.env);

  const { data: instance } = await sb
    .from("business_apps")
    .select("id, user_id")
    .eq("id", id)
    .maybeSingle();
  if (!instance) return c.json(errBody("App instance not found"), 404);

  const { data: userRow } = await sb
    .from("users")
    .select("is_admin")
    .eq("id", user_id)
    .maybeSingle();
  const isAdmin = userRow?.is_admin === true;
  if (!isAdmin && instance.user_id !== user_id) {
    return c.json(errBody("Unauthorized"), 403);
  }

  const { error } = await sb
    .from("business_apps")
    .update({ config, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return c.json(errBody("Failed to update config"), 500);

  return c.json({ success: true });
});

// ── POST /api/business-apps/:id/pause ────────────────────────────
// Pause an active app instance
router.post("/:id/pause", requireAuth, async (c) => {
  const { user_id } = c.get("auth");
  const { id } = c.req.param();
  const sb = createSupabaseClient(c.env);

  const { data: instance } = await sb
    .from("business_apps")
    .select("id, user_id, status")
    .eq("id", id)
    .maybeSingle();
  if (!instance) return c.json(errBody("App instance not found"), 404);

  const { data: userRow } = await sb
    .from("users")
    .select("is_admin")
    .eq("id", user_id)
    .maybeSingle();
  const isAdmin = userRow?.is_admin === true;
  if (!isAdmin && instance.user_id !== user_id) {
    return c.json(errBody("Unauthorized"), 403);
  }

  const { error } = await sb
    .from("business_apps")
    .update({ status: "paused", updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return c.json(errBody("Failed to pause app"), 500);

  return c.json({ success: true });
});

// ── DELETE /api/business-apps/:id ────────────────────────────────
// Deprovision an app instance
router.delete("/:id", requireAuth, async (c) => {
  const { user_id } = c.get("auth");
  const { id } = c.req.param();
  const sb = createSupabaseClient(c.env);

  const { data: instance } = await sb
    .from("business_apps")
    .select("id, user_id")
    .eq("id", id)
    .maybeSingle();
  if (!instance) return c.json(errBody("App instance not found"), 404);

  const { data: userRow } = await sb
    .from("users")
    .select("is_admin")
    .eq("id", user_id)
    .maybeSingle();
  const isAdmin = userRow?.is_admin === true;
  if (!isAdmin && instance.user_id !== user_id) {
    return c.json(errBody("Unauthorized"), 403);
  }

  const { error } = await sb
    .from("business_apps")
    .update({
      status: "deprovisioned",
      deactivated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) return c.json(errBody("Failed to deprovision app"), 500);

  // TODO: release Twilio number when wired
  log.info("apps.deprovisioned", { instance_id: id });
  return c.json({ success: true });
});

// ── GET /api/business-apps/:id/events ────────────────────────────
// Recent events for an app instance (calls, transcripts)
router.get("/:id/events", requireAuth, async (c) => {
  const { user_id } = c.get("auth");
  const { id } = c.req.param();
  const limit = Number(c.req.query("limit") || 20);
  const sb = createSupabaseClient(c.env);

  const { data: instance } = await sb
    .from("business_apps")
    .select("id, user_id")
    .eq("id", id)
    .maybeSingle();
  if (!instance) return c.json(errBody("App instance not found"), 404);

  const { data: userRow } = await sb
    .from("users")
    .select("is_admin")
    .eq("id", user_id)
    .maybeSingle();
  const isAdmin = userRow?.is_admin === true;
  if (!isAdmin && instance.user_id !== user_id) {
    return c.json(errBody("Unauthorized"), 403);
  }

  const { data: events } = await sb
    .from("business_app_events")
    .select("*")
    .eq("business_app_id", id)
    .order("created_at", { ascending: false })
    .limit(limit);

  return c.json({ events: events || [] });
});

export default router;