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
    log.error("apps.list_failed", { error: error.message });
    return c.json(errBody("Failed to load apps"), 500);
  }
  return c.json({ apps });
});

// ── POST /api/apps/provision ──────────────────────────────────────
// Provision an app for a business (admin or user)
router.post("/provision", requireAuth, async (c) => {
  const { user_id } = c.get("auth");
  const { business_id, app_slug, config } = await c.req.json();
  if (!business_id || !app_slug || !config) {
    return c.json(errBody("business_id, app_slug, and config are required"), 400);
  }
  const sb = createSupabaseClient(c.env);

  // Verify business ownership (or admin)
  const { data: userRow } = await sb
    .from("users")
    .select("is_admin")
    .eq("id", user_id)
    .maybeSingle();
  const isAdmin = userRow?.is_admin === true;

  const bizQuery = sb
    .from("businesses")
    .select("id, user_id")
    .eq("id", business_id)
    .eq("is_active", true);
  if (!isAdmin) bizQuery.eq("user_id", user_id);
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
  const ownerId = isAdmin ? biz.user_id : user_id;
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
    log.error("apps.provision_insert_failed", {
      error: insertErr?.message,
    });
    return c.json(errBody("Failed to create app instance"), 500);
  }

  log.info("apps.provisioning_started", {
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
    log.error("apps.provision_activate_failed", {
      error: updateErr.message,
    });
  }

  return c.json({ success: true, instance_id: instance.id });
});

export default router;