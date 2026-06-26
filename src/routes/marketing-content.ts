import { Hono } from "hono";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import { log } from "../lib/logger";
import { createSupabaseClient, getBusinessBySlug } from "../services/supabase";
import { createAnthropicClient } from "../services/anthropic";
import { loadModelConfig } from "../lib/model-config";
import { loadFeatureConfig, resolveFeatureModel } from "../lib/non-task-model-config";

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
    .in("status", ["draft", "approved"])
    .is("deleted_at", null)
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
// Two mutually exclusive modes — provide exactly one of:
//   { status: "approved" | "dismissed" }  — status transition (no body change)
//   { generated_body: "..." }             — inline body edit (status unchanged)
// Both modes require ownership: slug → businesses.user_id = auth.user_id,
// and confirm the asset belongs to this business before writing.

app.patch("/:slug/marketing/content-assets/:id", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const id = c.req.param("id");
  const supabase = createSupabaseClient(c.env);

  let body: { status?: string; generated_body?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const hasStatus = typeof body.status === "string";
  const hasBody   = typeof body.generated_body === "string";

  if (!hasStatus && !hasBody) {
    return c.json({ error: "Provide 'status' or 'generated_body'" }, 400);
  }
  if (hasStatus && hasBody) {
    return c.json({ error: "Provide 'status' or 'generated_body', not both" }, 400);
  }
  if (hasStatus && !UI_ALLOWED_STATUSES.has(body.status!)) {
    return c.json({ error: "status must be 'approved' or 'dismissed'" }, 400);
  }
  if (hasBody && body.generated_body!.trim() === "") {
    return c.json({ error: "generated_body cannot be empty" }, 400);
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

  const patch = hasStatus
    ? { status: body.status! }
    : { generated_body: body.generated_body! };

  const { error: updateErr } = await supabase
    .from("content_assets")
    .update(patch)
    .eq("id", id);

  if (updateErr) {
    log.error("[marketing-content] update_failed", { id, err: updateErr.message });
    return c.json({ error: "Failed to update" }, 500);
  }

  return c.json({ ok: true, id, ...patch });
});

// ── DELETE /:slug/marketing/content-assets/:id ───────────────────────────────
// Soft-delete: stamps deleted_at = now(). Row stays in DB; query filter excludes it.

app.delete("/:slug/marketing/content-assets/:id", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const id   = c.req.param("id");
  const supabase = createSupabaseClient(c.env);

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  const { data: asset, error: fetchErr } = await supabase
    .from("content_assets")
    .select("id")
    .eq("id", id)
    .eq("business_id", business.id)
    .is("deleted_at", null)
    .maybeSingle();

  if (fetchErr) {
    log.error("[marketing-content] delete_check_failed", { id, err: fetchErr.message });
    return c.json({ error: "Failed to look up asset" }, 500);
  }
  if (!asset) return c.json({ error: "Content asset not found" }, 404);

  const { error: delErr } = await supabase
    .from("content_assets")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);

  if (delErr) {
    log.error("[marketing-content] delete_failed", { id, err: delErr.message });
    return c.json({ error: "Failed to delete" }, 500);
  }

  log.info("[marketing-content] soft_deleted", { business_id: business.id, id });
  return c.json({ ok: true, id });
});

// ── POST /:slug/marketing/content-assets/:id/generate-hook ───────────────────
// Accepts { content: string }, extracts the opener (~first sentence or 15 words),
// and rewrites it into a sharper social hook via LLM.
// Returns { hook: string, original_opener: string }.

app.post("/:slug/marketing/content-assets/:id/generate-hook", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const id = c.req.param("id");
  const supabase = createSupabaseClient(c.env);

  let body: { content?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }

  if (typeof body.content !== "string" || body.content.trim() === "") {
    return c.json({ error: "Provide a non-empty 'content' string" }, 400);
  }

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  const { data: asset, error: fetchErr } = await supabase
    .from("content_assets")
    .select("id")
    .eq("id", id)
    .eq("business_id", business.id)
    .maybeSingle();

  if (fetchErr) {
    log.error("[marketing-content] hook_asset_check_failed", { id, err: fetchErr.message });
    return c.json({ error: "Failed to look up asset" }, 500);
  }
  if (!asset) return c.json({ error: "Content asset not found" }, 404);

  // Extract opener: first sentence (≤20 words) or first 15 words as fallback
  const content = body.content.trim();
  const sentenceMatch = content.match(/^[^.!?]*[.!?]/);
  const firstSentence = sentenceMatch ? sentenceMatch[0].trim() : null;
  const words = content.split(/\s+/);
  const fifteenWords = words.slice(0, 15).join(" ");
  const original_opener =
    firstSentence && firstSentence.split(/\s+/).length <= 20
      ? firstSentence
      : fifteenWords;

  const [models, featureConfig] = await Promise.all([
    loadModelConfig(supabase),
    loadFeatureConfig(supabase),
  ]);
  const model = resolveFeatureModel("feature-hook-generator", featureConfig, models);

  const anthropic = createAnthropicClient(c.env);
  const completion = await anthropic.messages.create({
    model,
    max_tokens: 120,
    system:
      "You are a social media copywriter. Rewrite the given opening into a sharper, more compelling hook for Bluesky. Stay under 15 words. Return ONLY the rewritten hook — no explanations, no quotes.",
    messages: [
      {
        role: "user",
        content: `Opening: ${original_opener}\n\nRewrite into a sharper hook (max 15 words):`,
      },
    ],
  });

  const block = completion.content[0];
  const hook = block.type === "text" ? block.text.trim() : "";

  log.info("[marketing-content] hook_generated", {
    business_id: business.id,
    asset_id: id,
    model,
  });

  return c.json({ hook, original_opener });
});

// ── POST /:slug/marketing/content-assets/:id/shorten ─────────────────────────
// Accepts { content: string, limit: number }, rewrites the full post to fit
// within `limit` characters while preserving voice and key points.
// Returns { shortened: string }.

app.post("/:slug/marketing/content-assets/:id/shorten", async (c) => {
  const auth = c.get("auth") as { user_id: string };
  const slug = c.req.param("slug");
  const id = c.req.param("id");
  const supabase = createSupabaseClient(c.env);

  let body: { content?: string; limit?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }

  if (typeof body.content !== "string" || body.content.trim() === "") {
    return c.json({ error: "Provide a non-empty 'content' string" }, 400);
  }
  const limit = typeof body.limit === "number" ? body.limit : 300;

  const business = await getBusinessBySlug(supabase, auth.user_id, slug);
  if (!business) return c.json({ error: "Business not found" }, 404);

  const { data: asset, error: fetchErr } = await supabase
    .from("content_assets")
    .select("id")
    .eq("id", id)
    .eq("business_id", business.id)
    .maybeSingle();

  if (fetchErr) {
    log.error("[marketing-content] shorten_asset_check_failed", { id, err: fetchErr.message });
    return c.json({ error: "Failed to look up asset" }, 500);
  }
  if (!asset) return c.json({ error: "Content asset not found" }, 404);

  const [models, featureConfig] = await Promise.all([
    loadModelConfig(supabase),
    loadFeatureConfig(supabase),
  ]);
  const model = resolveFeatureModel("feature-shorten", featureConfig, models);

  const anthropic = createAnthropicClient(c.env);
  const completion = await anthropic.messages.create({
    model,
    max_tokens: 512,
    system:
      "You are a social media editor. Rewrite the given post to fit within the character limit while preserving its voice, core message, and key points. Do not truncate or use ellipses — rewrite it to be genuinely shorter. Return ONLY the rewritten post, no explanation.",
    messages: [
      {
        role: "user",
        content: `Rewrite to fit within ${limit} characters:\n\n${body.content.trim()}`,
      },
    ],
  });

  const block = completion.content[0];
  const shortened = block.type === "text" ? block.text.trim() : "";

  log.info("[marketing-content] post_shortened", {
    business_id: business.id,
    asset_id: id,
    original_len: body.content.length,
    shortened_len: shortened.length,
    limit,
    model,
  });

  return c.json({ shortened });
});

export default app;
