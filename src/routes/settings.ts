import { Hono } from "hono";
import type { Env } from "../env";
import { createSupabaseClient } from "../services/supabase";
import { requireAuth } from "../lib/jwt";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);

const VALID_ACCENT_COLORS = [
  "terracotta", "sage", "navy", "charcoal", "sienna", "forest", "brass", "ink",
] as const;

// ── Helper: fetch business by slug with ownership check ───────────────────

async function getOwnedBusiness(
  supabase: ReturnType<typeof createSupabaseClient>,
  user_id: string,
  slug: string,
) {
  const { data, error } = await supabase
    .from("businesses")
    .select(
      "id, slug, name, created_at, calendly_url, show_credentials_publicly, " +
      "accent_color, accent_color_override, hero_font, hero_layout",
    )
    .eq("slug", slug)
    .eq("user_id", user_id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// ── GET /api/settings/user ────────────────────────────────────────────────
// Returns authenticated user profile + list of their businesses.

app.get("/user", async (c) => {
  const auth = c.get("auth");
  const supabase = createSupabaseClient(c.env);

  const [profileRes, bizRes] = await Promise.allSettled([
    supabase
      .from("users")
      .select("id, handle, created_at")
      .eq("id", auth.user_id)
      .maybeSingle(),
    supabase
      .from("businesses")
      .select("id, slug, name, created_at")
      .eq("user_id", auth.user_id)
      .order("created_at", { ascending: true }),
  ]);

  const profile = profileRes.status === "fulfilled" ? profileRes.value.data : null;
  const businesses = bizRes.status === "fulfilled" ? (bizRes.value.data ?? []) : [];

  return c.json({
    user: {
      id: auth.user_id,
      email: auth.email,
      handle: (profile as any)?.handle ?? null,
      created_at: (profile as any)?.created_at ?? null,
    },
    businesses: businesses.map((b: any) => ({
      id: b.id,
      slug: b.slug,
      name: b.name,
      created_at: b.created_at,
    })),
  });
});

// ── GET /api/settings/business/:slug ─────────────────────────────────────
// Returns per-business settings + credentials summary.

app.get("/business/:slug", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  let business: any;
  try {
    business = await getOwnedBusiness(supabase, auth.user_id, slug);
  } catch (err) {
    log.error("settings_get_biz", { err: String(err), slug });
    return c.json(errBody("internal", "failed to fetch business"), 500);
  }
  if (!business) return c.json(errBody("not_found", "business not found or not yours"), 404);

  // Credentials counts — 3 parallel queries, all graceful on failure
  const [completionsRes, allBadgesRes, earningsRes] = await Promise.allSettled([
    supabase
      .from("lesson_completions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", auth.user_id)
      .eq("business_id", business.id),
    supabase
      .from("badges")
      .select("id, tier"),
    supabase
      .from("badge_earnings")
      .select("badge_id")
      .eq("user_id", auth.user_id)
      .eq("business_id", business.id),
  ]);

  const lessons_completed =
    completionsRes.status === "fulfilled" ? (completionsRes.value.count ?? 0) : 0;

  const allBadges =
    allBadgesRes.status === "fulfilled" ? (allBadgesRes.value.data ?? []) : [];
  const earnings =
    earningsRes.status === "fulfilled" ? (earningsRes.value.data ?? []) : [];

  const earnedIds = new Set(earnings.map((e: any) => e.badge_id as string));
  const task_badges_earned = allBadges.filter(
    (b: any) => b.tier === "task" && earnedIds.has(b.id),
  ).length;
  const ceo_earned = allBadges.some(
    (b: any) => b.tier === "master" && earnedIds.has(b.id),
  );

  return c.json({
    business: {
      id: business.id,
      slug: business.slug,
      name: business.name,
      calendly_url: business.calendly_url ?? null,
      show_credentials_publicly: business.show_credentials_publicly ?? false,
      accent_color: business.accent_color ?? null,
      accent_color_override: business.accent_color_override ?? null,
      hero_font: business.hero_font ?? null,
      hero_layout: business.hero_layout ?? null,
    },
    credentials_count: {
      lessons_completed,
      task_badges_earned,
      ceo_earned,
    },
  });
});

// ── PUT /api/settings/business/:slug ─────────────────────────────────────
// Updates user-editable settings fields. All body fields are optional.

app.put("/business/:slug", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  let business: any;
  try {
    business = await getOwnedBusiness(supabase, auth.user_id, slug);
  } catch (err) {
    log.error("settings_put_biz_fetch", { err: String(err), slug });
    return c.json(errBody("internal", "failed to fetch business"), 500);
  }
  if (!business) return c.json(errBody("not_found", "business not found or not yours"), 404);

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json(errBody("bad_request", "invalid JSON body"), 400);
  }

  const updates: Record<string, unknown> = {};

  if ("calendly_url" in body) {
    const url = body.calendly_url;
    if (url === null || url === "") {
      updates.calendly_url = null;
    } else if (typeof url === "string" && url.startsWith("https://calendly.com/")) {
      updates.calendly_url = url;
    } else {
      return c.json(
        errBody("bad_request", "calendly_url must start with https://calendly.com/ or be null"),
        400,
      );
    }
  }

  if ("show_credentials_publicly" in body) {
    if (typeof body.show_credentials_publicly !== "boolean") {
      return c.json(errBody("bad_request", "show_credentials_publicly must be a boolean"), 400);
    }
    updates.show_credentials_publicly = body.show_credentials_publicly;
  }

  if ("accent_color_override" in body) {
    const override = body.accent_color_override;
    if (override === null) {
      updates.accent_color_override = null;
    } else if (typeof override === "string" && (VALID_ACCENT_COLORS as readonly string[]).includes(override)) {
      updates.accent_color_override = override;
    } else {
      return c.json(
        errBody(
          "bad_request",
          `accent_color_override must be one of: ${VALID_ACCENT_COLORS.join(", ")}, or null`,
        ),
        400,
      );
    }
  }

  if (Object.keys(updates).length === 0) {
    return c.json(errBody("bad_request", "no valid fields provided"), 400);
  }

  const { error: updateErr } = await supabase
    .from("businesses")
    .update(updates)
    .eq("id", business.id);

  if (updateErr) {
    log.error("settings_put_update", { err: updateErr.message, business_id: business.id });
    return c.json(errBody("internal", "failed to save settings"), 500);
  }

  log.info("settings_updated", {
    business_id: business.id,
    fields: Object.keys(updates),
  });

  // Return the updated row
  let updated: any;
  try {
    updated = await getOwnedBusiness(supabase, auth.user_id, slug);
  } catch {
    updated = business;
  }

  return c.json({
    ok: true,
    business: {
      id: updated.id,
      slug: updated.slug,
      name: updated.name,
      calendly_url: updated.calendly_url ?? null,
      show_credentials_publicly: updated.show_credentials_publicly ?? false,
      accent_color: updated.accent_color ?? null,
      accent_color_override: updated.accent_color_override ?? null,
      hero_font: updated.hero_font ?? null,
      hero_layout: updated.hero_layout ?? null,
    },
  });
});

export default app;
