import { Hono } from "hono";
import type { Env } from "../env";
import { createSupabaseClient } from "../services/supabase";
import { log } from "../lib/logger";

const app = new Hono<{ Bindings: Env }>();

/**
 * Public business site data endpoint — no auth required.
 * Returns both businesses table visual identity columns and business_context data.
 * V1 note: slug is unique per user; collisions impossible at alpha scale.
 */
app.get("/:slug", async (c) => {
  const slug = c.req.param("slug");

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return c.json({ error: "not_found", message: "Invalid slug" }, 404);
  }

  const supabase = createSupabaseClient(c.env);

  const { data: businessRaw, error: bizErr } = await supabase
    .from("businesses")
    .select(
      "id, name, slug, created_at, " +
      "accent_color, accent_color_override, hero_layout, hero_font, " +
      "hero_image_url, hero_image_credit, seo_title, seo_description, seo_keywords, " +
      "calendly_url, show_credentials_publicly, eyebrow_vocab",
    )
    .eq("slug", slug)
    .limit(1)
    .maybeSingle();

  const business = businessRaw as Record<string, unknown> | null;
  if (bizErr || !business) {
    log.info("site_not_found", { slug });
    return c.json({ error: "not_found", message: "Business not found" }, 404);
  }

  const { data: ctxRaw } = await supabase
    .from("business_context")
    .select(
      "business_summary, value_proposition, industry, business_model, " +
      "target_customer, positioning_statement, key_differentiators, brand_voice, agent_name",
    )
    .eq("business_id", business.id)
    .maybeSingle();

  const ctx = ctxRaw as Record<string, unknown> | null;

  c.header("Cache-Control", "public, max-age=300");
  return c.json({
    name:                     business.name,
    slug:                     business.slug,
    created_at:               business.created_at,
    // Visual identity (agent-derived, may be null before first build)
    accent_color:             business.accent_color     ?? null,
    accent_color_override:    business.accent_color_override ?? null,
    hero_layout:              business.hero_layout      ?? "type",
    hero_font:                business.hero_font        ?? "space_grotesk",
    hero_image_url:           business.hero_image_url   ?? null,
    hero_image_credit:        business.hero_image_credit ?? null,
    eyebrow_vocab:            business.eyebrow_vocab    ?? "standard",
    // SEO (agent-derived)
    seo_title:                business.seo_title        ?? null,
    seo_description:          business.seo_description  ?? null,
    seo_keywords:             business.seo_keywords     ?? [],
    // User settings
    calendly_url:             business.calendly_url     ?? null,
    show_credentials_publicly: business.show_credentials_publicly ?? false,
    // Business context
    value_proposition:        ctx?.value_proposition    ?? null,
    business_summary:         ctx?.business_summary     ?? null,
    industry:                 ctx?.industry             ?? null,
    business_model:           ctx?.business_model       ?? null,
    target_customer:          ctx?.target_customer      ?? null,
    positioning_statement:    ctx?.positioning_statement ?? null,
    key_differentiators:      ctx?.key_differentiators  ?? [],
    agent_name:               ctx?.agent_name           ?? null,
  });
});

export default app;
