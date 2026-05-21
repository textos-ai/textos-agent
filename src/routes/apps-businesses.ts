import { Hono } from "hono";
import { requireAuth } from "../lib/jwt";
import { createSupabaseClient } from "../services/supabase";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";
import type { Env } from "../env";

const router = new Hono<{ Bindings: Env }>();

// ── GET /api/businesses/:slug/apps ────────────────────────────────
// Returns installed + available apps for a business
router.get("/:slug/apps", requireAuth, async (c) => {
  const { user_id } = c.get("auth");
  const { slug } = c.req.param();
  const sb = createSupabaseClient(c.env);

  // Verify ownership
  const { data: biz } = await sb
    .from("businesses")
    .select("id")
    .eq("slug", slug)
    .eq("user_id", user_id)
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

// ── GET /api/businesses/:slug/leads ──────────────────────────────
// Leads for a business
router.get("/:slug/leads", requireAuth, async (c) => {
  const { user_id } = c.get("auth");
  const { slug } = c.req.param();
  const sb = createSupabaseClient(c.env);

  const { data: biz } = await sb
    .from("businesses")
    .select("id")
    .eq("slug", slug)
    .eq("user_id", user_id)
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