import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import { log } from "../lib/logger";
import { createSupabaseClient, getBusinessBySlug } from "../services/supabase";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);

// Only these statuses may be written from the review UI — blocks arbitrary status writes.
const UI_ALLOWED_STATUSES = new Set(["approved", "dismissed"]);

// ── GET /:slug/marketing/content-assets ─────────────────────────────────────
// Returns draft content_assets for this business, newest first.
// Joins content_types for card render hints (preview_component, label, suited_platforms).

app.get("/:slug/marketing/content-assets", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  const { data, error } = await supabase
    .from("content_assets")
    .select(`
      id,
      content_type,
      target_platform,
      generated_body,
      status,
      created_at,
      source_asset_id,
      content_types (
        label,
        preview_component,
        suited_platforms
      )
    `)
    .eq("business_id", business.id)
    .eq("status", "draft")
    .order("created_at", { ascending: false });

  if (error) {
    log.error("[marketing-content] list_failed", {
      business_id: business.id,
      err: error.message,
    });
    return c.json({ error: "Failed to load content" }, 500);
  }

  const items = (data ?? []).map((row: any) => ({
    id: row.id,
    content_type: row.content_type,
    target_platform: row.target_platform ?? null,
    generated_body: row.generated_body,
    status: row.status,
    created_at: row.created_at,
    source_asset_id: row.source_asset_id ?? null,
    content_type_meta: row.content_types
      ? {
          label: (row.content_types as any).label,
          preview_component: (row.content_types as any).preview_component,
          suited_platforms: (row.content_types as any).suited_platforms,
        }
      : null,
  }));

  return c.json({ items });
});

// ── PATCH /:slug/marketing/content-assets/:id ────────────────────────────────
// Moves a draft to 'approved' or 'dismissed'.
// Validates status against UI_ALLOWED_STATUSES, confirms business ownership,
// and confirms the asset belongs to this business before updating.

app.patch("/:slug/marketing/content-assets/:id", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const id = c.req.param("id");
  const supabase = createSupabaseClient(c.env);

  let body: { status?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }

  if (!body.status || !UI_ALLOWED_STATUSES.has(body.status)) {
    return c.json({ error: "status must be 'approved' or 'dismissed'" }, 400);
  }

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  // Cross-business write guard: confirm asset belongs to this business
  const { data: asset, error: fetchErr } = await supabase
    .from("content_assets")
    .select("id")
    .eq("id", id)
    .eq("business_id", business.id)
    .maybeSingle();

  if (fetchErr) {
    log.error("[marketing-content] asset_check_failed", { id, err: fetchErr.message });
    return c.json({ error: "Failed to look up asset" }, 500);
  }
  if (!asset) return c.json({ error: "Content asset not found" }, 404);

  const { error: updateErr } = await supabase
    .from("content_assets")
    .update({ status: body.status })
    .eq("id", id);

  if (updateErr) {
    log.error("[marketing-content] update_failed", { id, err: updateErr.message });
    return c.json({ error: "Failed to update status" }, 500);
  }

  return c.json({ ok: true, id, status: body.status });
});

export default app;
