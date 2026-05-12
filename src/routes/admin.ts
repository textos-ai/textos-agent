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

// requireAuth applies to every route in this router
admin.use("*", requireAuth);

// ── GET /admin/me ─────────────────────────────────────────────────────────────
// No requireAdmin — intentionally returns is_admin:false for non-admins so the
// frontend can gate gracefully without 403s.
admin.get("/me", async (c) => {
  const { user_id } = c.get("auth");
  const supabase = createSupabaseClient(c.env);
  const { data, error } = await supabase
    .from("admin_users")
    .select("user_id")
    .eq("user_id", user_id)
    .maybeSingle();
  if (error) {
    log.error("[admin] me_lookup_failed", { user_id, err: error.message });
    return c.json(errBody("internal", "me_lookup_failed"), 500);
  }
  return c.json({ is_admin: !!data });
});

// requireAdmin for every route below — explicit per-group so /me stays un-gated
admin.use("/email-queue", requireAdmin);
admin.use("/email-queue/*", requireAdmin);
admin.use("/backfill-public-site", requireAdmin);
admin.use("/grant-tokens", requireAdmin);
admin.use("/tasks", requireAdmin);
admin.use("/tasks/*", requireAdmin);
admin.use("/lifecycle-phases", requireAdmin);
admin.use("/lifecycle-phases/*", requireAdmin);
admin.use("/external-apis", requireAdmin);
admin.use("/external-apis/*", requireAdmin);
admin.use("/businesses", requireAdmin);
admin.use("/businesses/*", requireAdmin);

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

// ── GET /admin/tasks ─────────────────────────────────────────────────────
// Full task catalog ordered by execution_order. Includes lifecycle phase
// and API bindings via PostgREST nested joins.
admin.get("/tasks", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const { data, error } = await supabase
    .from("tasks")
    .select(`
      id, slug, name, description_short, plan_required, status, token_cost,
      execution_order, is_default, output_type, prompt_template,
      lifecycle_phase_id, is_regeneratable, asset_user_editable,
      lifecycle_phases(slug, name),
      task_apis(id, api_id, role, invocation_params, external_apis(slug, name, provider, output_kind))
    `)
    .order("execution_order", { ascending: true });
  if (error) {
    log.error("[admin] tasks_lookup_failed", { err: error.message });
    return c.json(errBody("internal", "tasks_lookup_failed"), 500);
  }
  return c.json({ tasks: data ?? [] });
});

// ── PATCH /admin/tasks/:id ───────────────────────────────────────────────
// Update exactly one field per request. Writes audit row to task_edits
// (non-blocking: failure logged but does not fail the response).
const PatchTaskBody = z.object({
  token_cost:          z.number().int().min(0).optional(),
  name:                z.string().min(1).max(200).optional(),
  description_short:   z.string().min(1).max(500).optional(),
  plan_required:       z.enum(["free", "core_paid", "premium_only", "premium_inactive"]).optional(),
  status:              z.enum(["draft", "active", "deprecated"]).optional(),
  lifecycle_phase_id:  z.string().uuid().nullable().optional(),
  is_regeneratable:    z.boolean().optional(),
  asset_user_editable: z.boolean().optional(),
  prompt_template:     z.string().min(1).max(10000).optional(),
});

admin.patch("/tasks/:id", async (c) => {
  const { user_id } = c.get("auth");
  const taskId = c.req.param("id");

  let parsed: z.infer<typeof PatchTaskBody>;
  try {
    parsed = PatchTaskBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", String(err)), 400);
  }

  const fields = (Object.keys(parsed) as Array<keyof typeof parsed>).filter(
    (k) => parsed[k] !== undefined,
  );
  if (fields.length === 0) return c.json(errBody("bad_request", "no fields to update"), 400);
  if (fields.length > 1)  return c.json(errBody("bad_request", "send one field per request"), 400);

  const field = fields[0];
  const newValue = parsed[field];

  const supabase = createSupabaseClient(c.env);

  // Read old value for audit log
  const { data: oldRow, error: readErr } = await supabase
    .from("tasks")
    .select(field)
    .eq("id", taskId)
    .maybeSingle();
  if (readErr) {
    log.error("[admin] task_read_failed", { taskId, err: readErr.message });
    return c.json(errBody("internal", "task_read_failed"), 500);
  }
  if (!oldRow) return c.json(errBody("not_found", "task not found"), 404);

  const oldValue = (oldRow as Record<string, unknown>)[field];

  // Apply update
  const { data: updated, error: updErr } = await supabase
    .from("tasks")
    .update({ [field]: newValue })
    .eq("id", taskId)
    .select()
    .single();
  if (updErr) {
    log.error("[admin] task_update_failed", { taskId, field, err: updErr.message });
    return c.json(errBody("internal", "task_update_failed"), 500);
  }

  // Audit log — non-blocking: failure logged loudly but does not roll back the update
  const { error: auditErr } = await supabase.from("task_edits").insert({
    task_id:    taskId,
    edited_by:  user_id,
    field_name: field,
    old_value:  String(oldValue ?? ""),
    new_value:  String(newValue ?? ""),
  });
  if (auditErr) {
    log.error("[admin] audit_insert_failed", { taskId, field, err: auditErr.message });
  }

  return c.json({ task: updated });
});

// ── GET /admin/lifecycle-phases ──────────────────────────────────────────
admin.get("/lifecycle-phases", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const { data, error } = await supabase
    .from("lifecycle_phases")
    .select("id, slug, name, sort_order")
    .order("sort_order", { ascending: true });
  if (error) {
    log.error("[admin] lifecycle_phases_lookup_failed", { err: error.message });
    return c.json(errBody("internal", "lifecycle_phases_lookup_failed"), 500);
  }
  return c.json({ lifecycle_phases: data ?? [] });
});

// ── GET /admin/external-apis ──────────────────────────────────────────────
admin.get("/external-apis", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const { data, error } = await supabase
    .from("external_apis")
    .select("id, slug, name, provider, output_kind, status, metadata")
    .order("slug", { ascending: true });
  if (error) {
    log.error("[admin] external_apis_lookup_failed", { err: error.message });
    return c.json(errBody("internal", "external_apis_lookup_failed"), 500);
  }
  return c.json({ external_apis: data ?? [] });
});

// ── POST /admin/tasks/:id/apis ────────────────────────────────────────────
// Add an API binding to a task.
const PostTaskApiBody = z.object({
  api_id:            z.string().uuid(),
  role:              z.enum(["primary", "secondary", "fallback"]),
  invocation_params: z.record(z.unknown()).optional(),
});

admin.post("/tasks/:id/apis", async (c) => {
  const taskId = c.req.param("id");

  let parsed: z.infer<typeof PostTaskApiBody>;
  try {
    parsed = PostTaskApiBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", String(err)), 400);
  }

  const supabase = createSupabaseClient(c.env);

  const { data, error } = await supabase
    .from("task_apis")
    .insert({
      task_id:           taskId,
      api_id:            parsed.api_id,
      role:              parsed.role,
      invocation_params: parsed.invocation_params ?? {},
    })
    .select("id, task_id, api_id, role, invocation_params, created_at")
    .single();

  if (error) {
    log.error("[admin] task_api_insert_failed", { taskId, err: error.message });
    // 23505 = unique_violation (task+api+role combo already exists)
    if (error.code === "23505") {
      return c.json(errBody("conflict", "binding already exists for this task/api/role"), 409);
    }
    return c.json(errBody("internal", "task_api_insert_failed"), 500);
  }

  return c.json({ binding: data }, 201);
});

// ── DELETE /admin/tasks/:id/apis/:bindingId ───────────────────────────────
// Remove a specific API binding from a task.
admin.delete("/tasks/:id/apis/:bindingId", async (c) => {
  const taskId    = c.req.param("id");
  const bindingId = c.req.param("bindingId");

  const supabase = createSupabaseClient(c.env);

  // Verify the binding belongs to this task before deleting
  const { data: existing, error: readErr } = await supabase
    .from("task_apis")
    .select("id")
    .eq("id", bindingId)
    .eq("task_id", taskId)
    .maybeSingle();

  if (readErr) {
    log.error("[admin] task_api_delete_read_failed", { taskId, bindingId, err: readErr.message });
    return c.json(errBody("internal", "task_api_delete_failed"), 500);
  }
  if (!existing) return c.json(errBody("not_found", "binding not found"), 404);

  const { error: delErr } = await supabase
    .from("task_apis")
    .delete()
    .eq("id", bindingId)
    .eq("task_id", taskId);

  if (delErr) {
    log.error("[admin] task_api_delete_failed", { taskId, bindingId, err: delErr.message });
    return c.json(errBody("internal", "task_api_delete_failed"), 500);
  }

  return c.json({ ok: true });
});

// ── GET /admin/businesses ─────────────────────────────────────────────────
// Paginated list of all businesses with owner email + subscription status.
// Query params: limit (1-100, default 50), before (ISO timestamp cursor).
admin.get("/businesses", async (c) => {
  const limitRaw = parseInt(c.req.query("limit") ?? "50", 10);
  const limit = Math.min(Math.max(Number.isNaN(limitRaw) ? 50 : limitRaw, 1), 100);
  const before = c.req.query("before");

  const supabase = createSupabaseClient(c.env);

  let q = supabase
    .from("businesses")
    .select(`
      id, slug, name, user_id, created_at,
      users!inner(email),
      business_subscriptions(status)
    `)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (before) q = q.lt("created_at", before);

  const { data: rows, error } = await q;
  if (error) {
    log.error("[admin] businesses_lookup_failed", { err: error.message });
    return c.json(errBody("internal", "businesses_lookup_failed"), 500);
  }

  const has_more = (rows?.length ?? 0) > limit;
  const businesses = (rows ?? []).slice(0, limit).map((r: any) => ({
    id:                  r.id,
    slug:                r.slug,
    name:                r.name,
    user_id:             r.user_id,
    owner_email:         r.users?.email ?? null,
    created_at:          r.created_at,
    subscription_status: r.business_subscriptions?.[0]?.status ?? null,
  }));
  const next_before = has_more ? businesses[businesses.length - 1].created_at : null;

  return c.json({ businesses, has_more, next_before });
});

export default admin;
