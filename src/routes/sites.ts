import { Hono } from "hono";
import type { Env } from "../env";
import { createSupabaseClient } from "../services/supabase";
import { log } from "../lib/logger";

const app = new Hono<{ Bindings: Env }>();

/**
 * Public business site data endpoint — no auth required.
 * Reads businesses + business_context using the service role key (bypasses RLS).
 * Returns only public-safe fields for rendering /sites/{slug}.
 *
 * V1 note: businesses.slug is unique per user, not globally.
 * For alpha (5–10 users) slug collisions are effectively impossible.
 * Sprint 9 wildcard DNS will replace this with real per-business domains.
 */
app.get("/:slug", async (c) => {
  const slug = c.req.param("slug");

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return c.json({ error: "not_found", message: "Invalid slug" }, 404);
  }

  const supabase = createSupabaseClient(c.env);

  const { data: business, error: bizErr } = await supabase
    .from("businesses")
    .select("id, name, slug")
    .eq("slug", slug)
    .limit(1)
    .maybeSingle();

  if (bizErr || !business) {
    log.info("site_not_found", { slug });
    return c.json({ error: "not_found", message: "Business not found" }, 404);
  }

  const { data: ctxRaw } = await supabase
    .from("business_context")
    .select(
      "business_summary, value_proposition, industry, business_model, " +
      "target_customer, positioning_statement, key_differentiators, brand_voice, agent_name"
    )
    .eq("business_id", business.id)
    .maybeSingle();

  const ctx = ctxRaw as any;

  c.header("Cache-Control", "public, max-age=300");
  return c.json({
    name:                  business.name,
    slug:                  business.slug,
    value_proposition:     ctx?.value_proposition     ?? null,
    business_summary:      ctx?.business_summary      ?? null,
    industry:              ctx?.industry              ?? null,
    business_model:        ctx?.business_model        ?? null,
    target_customer:       ctx?.target_customer       ?? null,
    positioning_statement: ctx?.positioning_statement ?? null,
    key_differentiators:   ctx?.key_differentiators   ?? [],
    agent_name:            ctx?.agent_name            ?? null,
  });
});

export default app;
