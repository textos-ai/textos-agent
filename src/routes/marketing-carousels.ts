import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import { log } from "../lib/logger";
import {
  createSupabaseClient,
  getBusinessBySlug,
  getUserSubscriptionPlan,
} from "../services/supabase";
import { generateStoryCards } from "../services/storyCardGenerator";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);

const VALID_COUNTS = [3, 5, 8, 10];

// ── GET /:slug/marketing/stories ───────────────────────────────────────────

app.get("/:slug/marketing/stories", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ ok: false, error: "Business not found" }, 404);

  const [carouselsRes, bizMetaRes, planRes] = await Promise.allSettled([
    supabase
      .from("marketing_carousels")
      .select("id, topic, card_count, cards, created_at, saved_at, is_locked")
      .eq("business_id", business.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("businesses")
      .select("name, accent_color, accent_color_override, hero_font")
      .eq("id", business.id)
      .single(),
    getUserSubscriptionPlan(supabase, auth.user_id),
  ]);

  const carousels =
    carouselsRes.status === "fulfilled" && !carouselsRes.value.error
      ? (carouselsRes.value.data ?? [])
      : [];

  const bizMeta =
    bizMetaRes.status === "fulfilled" && !bizMetaRes.value.error
      ? bizMetaRes.value.data
      : null;

  const plan = planRes.status === "fulfilled" ? planRes.value : null;
  const isSubscribed = plan !== null;

  const locked = carousels.filter((c: any) => c.is_locked);
  const draft = carousels.find((c: any) => !c.is_locked) ?? null;

  return c.json({
    ok: true,
    carousels: locked,
    draft,
    is_subscribed: isSubscribed,
    locked_count: locked.length,
    biz: bizMeta
      ? {
          name: business.name,
          accent_color: (bizMeta as any).accent_color_override ?? (bizMeta as any).accent_color ?? "charcoal",
          hero_font: (bizMeta as any).hero_font ?? "space_grotesk",
        }
      : { name: business.name, accent_color: "charcoal", hero_font: "space_grotesk" },
  });
});

// ── POST /:slug/marketing/stories ──────────────────────────────────────────

app.post("/:slug/marketing/stories", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ ok: false, error: "Business not found" }, 404);

  // Quota check
  const plan = await getUserSubscriptionPlan(supabase, auth.user_id);
  const isSubscribed = plan !== null;

  if (!isSubscribed) {
    const { count } = await supabase
      .from("marketing_carousels")
      .select("*", { count: "exact", head: true })
      .eq("user_id", auth.user_id)
      .eq("is_locked", true);

    if ((count ?? 0) >= 1) {
      return c.json(
        {
          ok: false,
          error: "Subscribe to create more carousels",
          paywall: true,
          locked_carousel_count: count,
        },
        402,
      );
    }
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const count = typeof body.count === "number" ? body.count : 8;
  const topic = typeof body.topic === "string" ? body.topic.trim() : "";

  if (!VALID_COUNTS.includes(count)) {
    return c.json({ ok: false, error: "count must be 3, 5, 8, or 10" }, 400);
  }
  if (topic.length > 500) {
    return c.json({ ok: false, error: "topic too long" }, 400);
  }

  const result = await generateStoryCards(
    {
      topic,
      count,
      context: { kind: "business", businessId: business.id, businessName: business.name },
    },
    c.env,
    supabase,
  );

  if (!result.ok) {
    return c.json(result, 502);
  }

  // Save as draft (is_locked=false), replacing any existing draft
  await supabase
    .from("marketing_carousels")
    .delete()
    .eq("business_id", business.id)
    .eq("user_id", auth.user_id)
    .eq("is_locked", false);

  const { data: carousel, error: insertErr } = await supabase
    .from("marketing_carousels")
    .insert({
      business_id: business.id,
      user_id: auth.user_id,
      topic: topic || null,
      card_count: count,
      cards: result.cards,
      is_locked: false,
    })
    .select("id")
    .single();

  if (insertErr) {
    log.error("marketing_carousel_insert_error", { err: String(insertErr) });
    return c.json({ ok: false, error: "Failed to save carousel" }, 500);
  }

  return c.json({ ok: true, cards: result.cards, carousel_id: (carousel as any).id });
});

// ── POST /:slug/marketing/stories/:id/save ─────────────────────────────────

app.post("/:slug/marketing/stories/:id/save", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const id = c.req.param("id");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ ok: false, error: "Business not found" }, 404);

  // Quota check before locking
  const plan = await getUserSubscriptionPlan(supabase, auth.user_id);
  const isSubscribed = plan !== null;

  if (!isSubscribed) {
    const { count } = await supabase
      .from("marketing_carousels")
      .select("*", { count: "exact", head: true })
      .eq("user_id", auth.user_id)
      .eq("is_locked", true);

    if ((count ?? 0) >= 1) {
      return c.json(
        {
          ok: false,
          error: "Subscribe to save more carousels",
          paywall: true,
        },
        402,
      );
    }
  }

  const { error } = await supabase
    .from("marketing_carousels")
    .update({ is_locked: true, saved_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", auth.user_id)
    .eq("is_locked", false);

  if (error) {
    log.error("marketing_carousel_save_error", { err: String(error) });
    return c.json({ ok: false, error: "Failed to save carousel" }, 500);
  }

  return c.json({ ok: true });
});

export default app;
