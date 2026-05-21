import { Hono } from "hono";
import { requireAuth } from "../lib/jwt";
import { createSupabaseClient } from "../services/supabase";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";
import type { Env } from "../env";

const router = new Hono<{ Bindings: Env }>();

// ── GET /api/apps ─────────────────────────────────────────────────
// Returns all active apps in the catalog
router.get("/", requireAuth, async (c) => {
  const sb = createSupabaseClient(c.env);
  const { data: apps, error } = await sb
    .from("apps")
    .select("*")
    .eq("status", "active")
    .order("sort_order");
  if (error) {
    log("error", "apps.list_failed", { error: error.message });
    return c.json(errBody("Failed to load apps"), 500);
  }
  return c.json({ apps });
});

// ── GET /api/businesses/:slug/apps ────────────────────────────────
// Returns installed + available apps for a business
router.get("/businesses/:slug/apps", requireAuth, async (c) => {
  const user = c.get("user");
  const { slug } = c.req.param();
  const sb = createSupabaseClient(c.env);

  // Verify ownership
  const { data: biz } = await sb
    .from("businesses")
    .select("id")
    .eq("slug", slug)
    .eq("user_id", user.id)
    .eq("is_active", true)
    .maybeSingle();
  if (!biz) return c.json(errBody("Business not found"), 404);

  // Installed apps
  const { data: installed } = await sb
    .from("business_apps")
    .select("*, app:apps(*)")
    .eq("business_id", biz.id)
    .neq("status", "deprovisioned");

  // All active apps
  const { data: catalog } = await sb
    .from("apps")
    .select("*")
    .eq("status", "active")
    .order("sort_order");

  const installedAppIds = new Set(
    (installed || []).map((i: any) => i.app_id)
  );
  const available = (catalog || []).filter(
    (a: any) => !installedAppIds.has(a.id)
  );

  return c.json({ installed: installed || [], available });
});

// ── POST /api/apps/provision ──────────────────────────────────────
// Provision an app for a business (admin or user)
router.post("/provision", requireAuth, async (c) => {
  const user = c.get("user");
  const { business_id, app_slug, config } = await c.req.json();
  if (!business_id || !app_slug || !config) {
    return c.json(errBody("business_id, app_slug, and config are required"), 400);
  }
  const sb = createSupabaseClient(c.env);

  // Verify business ownership (or admin)
  const { data: userRow } = await sb
    .from("users")
    .select("is_admin")
    .eq("id", user.id)
    .maybeSingle();
  const isAdmin = userRow?.is_admin === true;

  const bizQuery = sb
    .from("businesses")
    .select("id, user_id")
    .eq("id", business_id)
    .eq("is_active", true);
  if (!isAdmin) bizQuery.eq("user_id", user.id);
  const { data: biz } = await bizQuery.maybeSingle();
  if (!biz) return c.json(errBody("Business not found"), 404);

  // Get app definition
  const { data: app } = await sb
    .from("apps")
    .select("*")
    .eq("slug", app_slug)
    .eq("status", "active")
    .maybeSingle();
  if (!app) return c.json(errBody("App not found"), 404);

  // Check for existing instance
  const { data: existing } = await sb
    .from("business_apps")
    .select("id, status")
    .eq("business_id", business_id)
    .eq("app_id", app.id)
    .maybeSingle();
  if (existing && existing.status !== "deprovisioned") {
    return c.json(errBody("App already installed for this business"), 409);
  }

  // Create business_apps row — status provisioning
  const ownerId = isAdmin ? biz.user_id : user.id;
  const trialEndsAt = new Date(
    Date.now() + app.trial_days * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data: instance, error: insertErr } = await sb
    .from("business_apps")
    .upsert({
      business_id,
      app_id: app.id,
      user_id: ownerId,
      status: "provisioning",
      config,
      trial_ends_at: trialEndsAt,
    })
    .select()
    .single();
  if (insertErr || !instance) {
    log("error", "apps.provision_insert_failed", {
      error: insertErr?.message,
    });
    return c.json(errBody("Failed to create app instance"), 500);
  }

  log("info", "apps.provisioning_started", {
    business_id,
    app_slug,
    instance_id: instance.id,
  });

  // For voice-receptionist: Twilio provisioning happens in a
  // separate endpoint once Twilio is wired in Phase 1.
  // For now, mark active so the UI can show the instance.
  // TODO: replace with real Twilio provisioning call
  const { error: updateErr } = await sb
    .from("business_apps")
    .update({
      status: "active",
      activated_at: new Date().toISOString(),
      provisioned_data: { note: "twilio_pending" },
    })
    .eq("id", instance.id);
  if (updateErr) {
    log("error", "apps.provision_activate_failed", {
      error: updateErr.message,
    });
  }

  return c.json({ success: true, instance_id: instance.id });
});

// ── PATCH /api/business-apps/:id/config ───────────────────────────
// Update config for an installed app
router.patch("/business-apps/:id/config", requireAuth, async (c) => {
  const user = c.get("user");
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
    .eq("id", user.id)
    .maybeSingle();
  const isAdmin = userRow?.is_admin === true;
  if (!isAdmin && instance.user_id !== user.id) {
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
router.post("/business-apps/:id/pause", requireAuth, async (c) => {
  const user = c.get("user");
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
    .eq("id", user.id)
    .maybeSingle();
  const isAdmin = userRow?.is_admin === true;
  if (!isAdmin && instance.user_id !== user.id) {
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
router.delete("/business-apps/:id", requireAuth, async (c) => {
  const user = c.get("user");
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
    .eq("id", user.id)
    .maybeSingle();
  const isAdmin = userRow?.is_admin === true;
  if (!isAdmin && instance.user_id !== user.id) {
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
  log("info", "apps.deprovisioned", { instance_id: id });
  return c.json({ success: true });
});

// ── GET /api/business-apps/:id/events ────────────────────────────
// Recent events for an app instance (calls, transcripts)
router.get("/business-apps/:id/events", requireAuth, async (c) => {
  const user = c.get("user");
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
    .eq("id", user.id)
    .maybeSingle();
  const isAdmin = userRow?.is_admin === true;
  if (!isAdmin && instance.user_id !== user.id) {
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

// ── GET /api/businesses/:slug/leads ──────────────────────────────
// Leads for a business
router.get("/businesses/:slug/leads", requireAuth, async (c) => {
  const user = c.get("user");
  const { slug } = c.req.param();
  const sb = createSupabaseClient(c.env);

  const { data: biz } = await sb
    .from("businesses")
    .select("id")
    .eq("slug", slug)
    .eq("user_id", user.id)
    .eq("is_active", true)
    .maybeSingle();
  if (!biz) return c.json(errBody("Business not found"), 404);

  const { data: leads } = await sb
    .from("leads")
    .select("*")
    .eq("business_id", biz.id)
    .order("created_at", { ascending: false })
    .limit(50);

  return c.json({ leads: leads || [] });
});

export default router;