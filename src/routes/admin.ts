import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import { requireAdmin } from "../lib/admin";
import { createSupabaseClient } from "../services/supabase";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";
import Anthropic from "@anthropic-ai/sdk";
import { pickVisualChoices, fetchUnsplashPhoto } from "../lib/pick-visual-choices";

const admin = new Hono<{ Bindings: Env }>();

admin.use("*", requireAuth);
admin.use("*", requireAdmin);

// ── GET /admin/email-queue ─────────────────────────────────────────────────
// Returns pending and recent emails in the queue (latest 100).
admin.get("/email-queue", async (c) => {
  const supabase = createSupabaseClient(c.env);

  const { data: emails, error } = await supabase
    .from("email_queue")
    .select(
      "id, business_id, user_id, to_email, to_name, to_company, to_role, " +
      "subject, body, status, created_at, approved_at, sent_at, rejection_reason, " +
      "edited, edited_subject, edited_body",
    )
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    log.error("admin_email_queue_fetch_failed", { err: error.message });
    return c.json(errBody("upstream_error", error.message), 500);
  }

  return c.json({ emails: emails ?? [] });
});

// ── POST /admin/email-queue/:id/approve ───────────────────────────────────
admin.post("/email-queue/:id/approve", async (c) => {
  const id = c.req.param("id");
  const auth = c.get("auth");
  const supabase = createSupabaseClient(c.env);

  const { error } = await supabase
    .from("email_queue")
    .update({
      status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: auth.user_id,
    })
    .eq("id", id)
    .eq("status", "pending");

  if (error) {
    log.error("admin_email_approve_failed", { id, err: error.message });
    return c.json(errBody("upstream_error", error.message), 500);
  }

  // TODO Phase 3: enqueue SendGrid send job via Cloudflare Queue
  log.info("admin_email_approved", { id, approved_by: auth.user_id });
  return c.json({ ok: true });
});

// ── POST /admin/email-queue/:id/reject ────────────────────────────────────
admin.post("/email-queue/:id/reject", async (c) => {
  const id = c.req.param("id");
  const auth = c.get("auth");
  let reason: string | undefined;

  try {
    const body = await c.req.json<{ reason?: string }>();
    reason = body.reason;
  } catch {
    // reason is optional — ignore parse failures
  }

  const supabase = createSupabaseClient(c.env);

  const { error } = await supabase
    .from("email_queue")
    .update({
      status: "rejected",
      rejection_reason: reason ?? null,
      approved_by: auth.user_id,
      approved_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "pending");

  if (error) {
    log.error("admin_email_reject_failed", { id, err: error.message });
    return c.json(errBody("upstream_error", error.message), 500);
  }

  log.info("admin_email_rejected", { id, reason });
  return c.json({ ok: true });
});

// ── POST /admin/email-queue/:id/edit ──────────────────────────────────────
// Edit subject/body and immediately approve.
admin.post("/email-queue/:id/edit", async (c) => {
  const id = c.req.param("id");
  const auth = c.get("auth");

  let subject: string, body: string;
  try {
    const parsed = await c.req.json<{ subject: string; body: string }>();
    subject = parsed.subject;
    body = parsed.body;
    if (!subject || !body) throw new Error("subject and body required");
  } catch (err) {
    return c.json(
      errBody("bad_request", "body must include subject and body strings"),
      400,
    );
  }

  const supabase = createSupabaseClient(c.env);

  const { error } = await supabase
    .from("email_queue")
    .update({
      edited: true,
      edited_subject: subject,
      edited_body: body,
      status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: auth.user_id,
    })
    .eq("id", id);

  if (error) {
    log.error("admin_email_edit_failed", { id, err: error.message });
    return c.json(errBody("upstream_error", error.message), 500);
  }

  log.info("admin_email_edited_approved", { id, approved_by: auth.user_id });
  return c.json({ ok: true });
});

// ── POST /admin/backfill-public-site ─────────────────────────────────────
// Re-runs the visual identity + SEO generation for one or all businesses.
// Body (optional): { slug?: string }
// If slug is omitted, processes all businesses missing accent_color.
admin.post("/backfill-public-site", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const anthropic = new Anthropic({ apiKey: c.env.ANTHROPIC_API_KEY });

  const force = c.req.query("force") === "true";

  let targetSlug: string | undefined;
  try {
    const body = await c.req.json<{ slug?: string }>();
    targetSlug = body.slug;
  } catch {
    // slug is optional
  }

  // Fetch target businesses with their context
  let bizQuery = supabase
    .from("businesses")
    .select("id, slug, name")
    .order("created_at", { ascending: false });

  if (targetSlug) {
    bizQuery = bizQuery.eq("slug", targetSlug);
  } else if (!force) {
    // Idempotent: only process businesses missing a hero photo
    bizQuery = bizQuery.is("hero_image_url", null);
  }
  // force=true: no filter — process every business

  const { data: businesses, error: bizErr } = await bizQuery;
  if (bizErr) {
    return c.json(errBody("upstream_error", bizErr.message), 500);
  }
  if (!businesses?.length) {
    return c.json({ ok: true, processed: 0, message: "No businesses to backfill." });
  }

  const results: Array<{ slug: string; status: "ok" | "error"; detail?: string }> = [];

  for (const biz of businesses) {
    try {
      // Fetch business_context
      const { data: ctx } = await supabase
        .from("business_context")
        .select("*")
        .eq("business_id", biz.id)
        .single();

      const industry     = ctx?.industry ?? "";
      const summary      = ctx?.business_summary ?? "";
      const brandVoice   = ctx?.brand_voice ?? "";
      const valueProp    = ctx?.value_proposition ?? biz.name;

      const picks = await pickVisualChoices(industry, summary, brandVoice, anthropic);

      let heroImageUrl: string | null = null;
      let heroImageCredit: string | null = null;

      const unsplashQuery = picks.hero_layout === "photo"
        ? picks.unsplash_query
        : (picks.unsplash_query_atmospheric ?? picks.unsplash_query);
      const photo = await fetchUnsplashPhoto(unsplashQuery, c.env.UNSPLASH_ACCESS_KEY ?? "");
      if (photo) {
        heroImageUrl = photo.url;
        heroImageCredit = photo.credit;
      } else if (picks.hero_layout === "photo") {
        picks.hero_layout = "type";
      }

      // Haiku SEO
      let seoTitle = biz.name;
      let seoDescription = valueProp;
      let seoKeywords: string[] = [];

      try {
        const seoMsg = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 512,
          messages: [{
            role: "user",
            content: `Generate SEO metadata. Return ONLY valid JSON, no markdown.\nBusiness: ${biz.name}\nIndustry: ${industry}\nSummary: ${summary}\nValue prop: ${valueProp}\n\n{"title":"under 60 chars","description":"under 160 chars","keywords":["5-8 phrases"]}`,
          }],
        });
        const raw = (seoMsg.content[0] as { text: string }).text.trim()
          .replace(/^```json\s*/i, "").replace(/\s*```$/i, "");
        const seo = JSON.parse(raw);
        if (seo.title)       seoTitle = seo.title;
        if (seo.description) seoDescription = seo.description;
        if (Array.isArray(seo.keywords)) seoKeywords = seo.keywords.slice(0, 8);
      } catch {
        // use fallback values
      }

      await supabase
        .from("businesses")
        .update({
          accent_color:     picks.accent_color,
          hero_layout:      picks.hero_layout,
          hero_font:        picks.hero_font,
          eyebrow_vocab:    picks.eyebrow_vocab,
          hero_image_url:   heroImageUrl,
          hero_image_credit: heroImageCredit,
          seo_title:        seoTitle,
          seo_description:  seoDescription,
          seo_keywords:     seoKeywords,
        })
        .eq("id", biz.id);

      log.info("backfill_public_site_ok", { slug: biz.slug, accent: picks.accent_color, layout: picks.hero_layout });
      results.push({ slug: biz.slug, status: "ok" });
    } catch (err) {
      log.error("backfill_public_site_err", { slug: biz.slug, err: String(err) });
      results.push({ slug: biz.slug, status: "error", detail: String(err) });
    }
  }

  return c.json({ ok: true, processed: results.length, results });
});

// ── POST /admin/grant-tokens ──────────────────────────────────────────────
const GrantTokensBody = z.object({
  business_id: z.string().uuid(),
  tokens:      z.number().int().positive(),
  reason:      z.string().min(1),
});

admin.post("/grant-tokens", async (c) => {
  const auth = c.get("auth");

  let parsed: z.infer<typeof GrantTokensBody>;
  try {
    parsed = GrantTokensBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", String(err)), 400);
  }
  const { business_id, tokens, reason } = parsed;

  const supabase = createSupabaseClient(c.env);

  const { data: business, error: bizErr } = await supabase
    .from("businesses")
    .select("user_id")
    .eq("id", business_id)
    .single();

  if (bizErr && bizErr.code !== "PGRST116") {
    log.error("admin_grant_tokens_business_lookup_failed", { business_id, err: bizErr.message });
    return c.json(errBody("internal", "business_lookup_failed"), 500);
  }
  if (!business) {
    return c.json(errBody("not_found", "business not found"), 404);
  }

  const { data, error } = await supabase.rpc("admin_grant_tokens", {
    p_business_id: business_id,
    p_user_id:     business.user_id,
    p_tokens:      tokens,
    p_reason:      reason,
    p_granted_by:  auth.email,
  });

  if (error) {
    log.error("admin_grant_tokens_failed", { business_id, tokens, err: error.message });
    return c.json(errBody("internal", error.message), 500);
  }

  if (!data?.ok) {
    log.error("admin_grant_tokens_rpc_rejected", { business_id, tokens, data });
    return c.json(errBody("upstream_error", data?.reason ?? "rpc_rejected"), 502);
  }

  log.info("admin_grant_tokens_ok", { business_id, user_id: business.user_id, tokens, granted_by: auth.email });
  return c.json(data);
});

export default admin;
