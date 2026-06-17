import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import { requireAdmin } from "../lib/admin";
import {
  createSupabaseClient,
  type BusinessRow,
  type TaskRow,
  TASK_SELECT_COLUMNS,
} from "../services/supabase";
import { runTaskInBackground } from "./business-task-run";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicClient } from "../services/anthropic";
import { pickVisualChoices, fetchUnsplashPhoto } from "../lib/pick-visual-choices";
import { loadModelConfig } from "../lib/model-config";
import { loadFeatureConfig, resolveFeatureModel, FEATURE_REGISTRY, type FeatureKey } from "../lib/non-task-model-config";

const admin = new Hono<{ Bindings: Env }>();

// requireAuth applies to every route in this router
admin.use("*", requireAuth);

// ── GET /admin/me ─────────────────────────────────────────────────────────────
// No requireAdmin — intentionally returns is_admin:false for non-admins so the
// frontend can gate gracefully without 403s. Reads users.is_admin (the new
// canonical source post 2026-05-14 admin_users → users.is_admin migration).
admin.get("/me", async (c) => {
  const { user_id } = c.get("auth");
  const supabase = createSupabaseClient(c.env);
  const { data, error } = await supabase
    .from("users")
    .select("is_admin")
    .eq("id", user_id)
    .maybeSingle();
  if (error) {
    log.error("[admin] me_lookup_failed", { user_id, err: error.message });
    return c.json(errBody("internal", "me_lookup_failed"), 500);
  }
  return c.json({ is_admin: !!data?.is_admin });
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
admin.use("/users", requireAdmin);
admin.use("/users/*", requireAdmin);
admin.use("/prompt-definitions", requireAdmin);
admin.use("/prompt-definitions/*", requireAdmin);
admin.use("/prompt-variables", requireAdmin);
admin.use("/task-trigger-blocks", requireAdmin);
admin.use("/task-trigger-blocks/*", requireAdmin);
admin.use("/test-harness", requireAdmin);
admin.use("/test-harness/*", requireAdmin);

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
  const anthropic = createAnthropicClient(c.env);
  const [backfillModels, backfillFeatureConfig] = await Promise.all([
    loadModelConfig(supabase),
    loadFeatureConfig(supabase),
  ]);
  const visualPickerModel = resolveFeatureModel("feature-visual-picker", backfillFeatureConfig, backfillModels);
  const adminSeoModel     = resolveFeatureModel("feature-admin-seo", backfillFeatureConfig, backfillModels);

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

      const picks = await pickVisualChoices(industry, summary, brandVoice, anthropic, visualPickerModel);

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
          model: adminSeoModel,
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
      execution_order, is_default, is_featured, output_type, prompt_template,
      lifecycle_phase_id, is_regeneratable, asset_user_editable,
      text_controllable,
      kind, config_page_path,
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

// ── POST /admin/tasks ────────────────────────────────────────────────────
// Create a new task with slug + name. All other fields use safe defaults.
// Automatically binds anthropic-claude-sonnet as the primary API.
// Audit: task_edits row with field_name='task.create'.
const PostTaskBody = z.object({
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric with hyphens"),
  name:             z.string().min(1).max(200),
  kind:             z.enum(["manual", "system", "scheduled"]).optional(),
  config_page_path: z.string().min(1).max(500).nullable().optional(),
  is_featured:      z.boolean().optional(),
});

admin.post("/tasks", async (c) => {
  const { user_id } = c.get("auth");

  let parsed: z.infer<typeof PostTaskBody>;
  try {
    parsed = PostTaskBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", String(err)), 400);
  }

  const supabase = createSupabaseClient(c.env);

  // Fetch max execution_order and claude-sonnet api_id in parallel
  const [maxOrderResult, claudeApiResult] = await Promise.all([
    supabase
      .from("tasks")
      .select("execution_order")
      .order("execution_order", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("external_apis")
      .select("id")
      .eq("slug", "anthropic-claude-sonnet")
      .maybeSingle(),
  ]);

  const nextOrder = (maxOrderResult.data?.execution_order ?? 0) + 1;

  // Insert task
  const { data: newTask, error: insertErr } = await supabase
    .from("tasks")
    .insert({
      slug:                parsed.slug,
      name:                parsed.name,
      status:              "draft",
      plan_required:       "free",
      is_default:          false,
      is_regeneratable:    false,
      asset_user_editable: false,
      token_cost:          0,
      execution_order:     nextOrder,
      area:                "business_builder",
      output_type:         "document",
      lifecycle_phase_id:  null,
      prompt_template:     null,
      description_short:   null,
      ...(parsed.kind             !== undefined && { kind:             parsed.kind }),
      ...(parsed.config_page_path !== undefined && { config_page_path: parsed.config_page_path }),
      ...(parsed.is_featured      !== undefined && { is_featured:      parsed.is_featured }),
    })
    .select("id")
    .single();

  if (insertErr) {
    log.error("[admin] task_insert_failed", { slug: parsed.slug, err: insertErr.message });
    if (insertErr.code === "23505") {
      return c.json(errBody("conflict", "slug already exists"), 409);
    }
    return c.json(errBody("internal", "task_insert_failed"), 500);
  }

  const taskId = newTask.id;

  // Bind claude-sonnet as primary API
  if (claudeApiResult.data) {
    const { error: bindErr } = await supabase.from("task_apis").insert({
      task_id:           taskId,
      api_id:            claudeApiResult.data.id,
      role:              "primary",
      invocation_params: {},
    });
    if (bindErr) {
      log.error("[admin] task_default_api_bind_failed", { taskId, err: bindErr.message });
    }
  } else {
    log.error("[admin] claude_sonnet_api_not_found", { taskId });
  }

  // Audit log — non-blocking
  const { error: auditErr } = await supabase.from("task_edits").insert({
    task_id:    taskId,
    edited_by:  user_id,
    field_name: "task.create",
    old_value:  "",
    new_value:  JSON.stringify({ slug: parsed.slug, name: parsed.name }),
  });
  if (auditErr) {
    log.error("[admin] audit_insert_failed", { taskId, field: "task.create", err: auditErr.message });
  }

  // Fresh select with full nested joins (task_apis now populated)
  const { data: fullTask, error: selectErr } = await supabase
    .from("tasks")
    .select(`
      id, slug, name, description_short, plan_required, status, token_cost,
      execution_order, is_default, is_featured, output_type, prompt_template,
      lifecycle_phase_id, is_regeneratable, asset_user_editable,
      text_controllable,
      kind, config_page_path,
      lifecycle_phases(slug, name),
      task_apis(id, api_id, role, invocation_params, external_apis(slug, name, provider, output_kind))
    `)
    .eq("id", taskId)
    .single();

  if (selectErr) {
    log.error("[admin] task_post_select_failed", { taskId, err: selectErr.message });
    return c.json(errBody("internal", "task_post_select_failed"), 500);
  }

  log.info("[admin] task_created", { taskId, slug: parsed.slug });
  return c.json({ task: fullTask }, 201);
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
  is_default:          z.boolean().optional(),
  is_featured:         z.boolean().optional(),
  text_controllable:   z.boolean().optional(),
  prompt_template:     z.string().min(1).max(10000).optional(),
  execution_order:     z.number().int().min(0).optional(),
  kind:                z.enum(["manual", "system", "scheduled"]).optional(),
  config_page_path:    z.string().min(1).max(500).nullable().optional(),
  // Migration 045: text + CHECK (tasks_output_type_check), not a pg_enum
  output_type:         z.enum(["document", "configured", "image", "image_set", "structured_data", "video"]).optional(),
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

// ── PATCH /admin/external-apis/:id ───────────────────────────────────────
// Update metadata.model for an external_api row (admin-configurable LLM).
// Validates that the new model string is non-empty and starts with "claude-".
const PatchExternalApiBody = z.object({
  model: z.string().min(1).regex(/^claude-/, { message: "model must start with 'claude-'" }),
});

admin.patch("/external-apis/:id", async (c) => {
  const { user_id } = c.get("auth");
  const apiId = c.req.param("id");

  let parsed: z.infer<typeof PatchExternalApiBody>;
  try {
    parsed = PatchExternalApiBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", String(err)), 400);
  }

  const supabase = createSupabaseClient(c.env);

  // Read current row for audit log
  const { data: existing, error: readErr } = await supabase
    .from("external_apis")
    .select("id, slug, metadata")
    .eq("id", apiId)
    .maybeSingle();

  if (readErr) {
    log.error("[admin] external_api_read_failed", { apiId, err: readErr.message });
    return c.json(errBody("internal", "external_api_read_failed"), 500);
  }
  if (!existing) return c.json(errBody("not_found", "external_api not found"), 404);

  const oldModel = (existing.metadata as Record<string, unknown> | null)?.model ?? null;

  const { data: updated, error: updateErr } = await supabase
    .from("external_apis")
    .update({ metadata: { ...(existing.metadata as Record<string, unknown> ?? {}), model: parsed.model } })
    .eq("id", apiId)
    .select("id, slug, name, metadata")
    .single();

  if (updateErr) {
    log.error("[admin] external_api_update_failed", { apiId, err: updateErr.message });
    return c.json(errBody("internal", "external_api_update_failed"), 500);
  }

  log.info("[admin] external_api_model_updated", {
    api_id:    apiId,
    slug:      existing.slug,
    edited_by: user_id,
    old_model: String(oldModel ?? ""),
    new_model: parsed.model,
  });

  return c.json({ external_api: updated });
});

// ── GET /admin/features ───────────────────────────────────────────────────
// Returns the non-task feature registry + current tier settings for /admin/models.
admin.get("/features", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const slugs = ["feature-default", ...FEATURE_REGISTRY.map((f) => f.key)];
  const { data, error } = await supabase
    .from("external_apis")
    .select("id, slug, metadata")
    .in("slug", slugs);
  if (error) {
    log.error("[admin] features_lookup_failed", { err: error.message });
    return c.json(errBody("internal", "features_lookup_failed"), 500);
  }
  const bySlug: Record<string, { id: string; tier: string | null }> = {};
  for (const row of data ?? []) {
    const tier = (row.metadata as Record<string, unknown> | null)?.tier;
    bySlug[row.slug as string] = { id: row.id as string, tier: typeof tier === "string" ? tier : null };
  }
  return c.json({ bySlug, registry: FEATURE_REGISTRY });
});

// ── PATCH /admin/features/:slug ───────────────────────────────────────────
// Set metadata.tier for a feature or the default row. Accepts null to clear override.
const PatchFeatureBody = z.object({
  tier: z.enum(["haiku", "sonnet", "opus"]).nullable(),
});

admin.patch("/features/:slug", async (c) => {
  const { user_id } = c.get("auth");
  const slug = c.req.param("slug");

  let parsed: z.infer<typeof PatchFeatureBody>;
  try {
    parsed = PatchFeatureBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", String(err)), 400);
  }

  const supabase = createSupabaseClient(c.env);

  const { data: existing, error: readErr } = await supabase
    .from("external_apis")
    .select("id, slug, metadata")
    .eq("slug", slug)
    .maybeSingle();

  if (readErr) {
    log.error("[admin] feature_read_failed", { slug, err: readErr.message });
    return c.json(errBody("internal", "feature_read_failed"), 500);
  }
  if (!existing) return c.json(errBody("not_found", "feature not found"), 404);

  const oldTier = (existing.metadata as Record<string, unknown> | null)?.tier ?? null;

  // null tier clears the override (feature falls back to default)
  const newMeta =
    parsed.tier === null
      ? Object.fromEntries(
          Object.entries(existing.metadata as Record<string, unknown> ?? {}).filter(([k]) => k !== "tier")
        )
      : { ...(existing.metadata as Record<string, unknown> ?? {}), tier: parsed.tier };

  const { data: updated, error: updateErr } = await supabase
    .from("external_apis")
    .update({ metadata: newMeta })
    .eq("slug", slug)
    .select("id, slug, metadata")
    .single();

  if (updateErr) {
    log.error("[admin] feature_update_failed", { slug, err: updateErr.message });
    return c.json(errBody("internal", "feature_update_failed"), 500);
  }

  log.info("[admin] feature_tier_updated", {
    slug,
    edited_by: user_id,
    old_tier:  String(oldTier ?? ""),
    new_tier:  String(parsed.tier ?? "(cleared)"),
  });

  return c.json({ feature: updated });
});

// ── POST /admin/tasks/:id/apis ────────────────────────────────────────────
// Add an API binding to a task.
const PostTaskApiBody = z.object({
  api_id:            z.string().uuid(),
  role:              z.enum(["primary", "secondary", "fallback"]),
  invocation_params: z.record(z.unknown()).optional(),
});

admin.post("/tasks/:id/apis", async (c) => {
  const { user_id } = c.get("auth");
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
    if (error.code === "23505") {
      return c.json(errBody("conflict", "binding already exists for this task/api/role"), 409);
    }
    return c.json(errBody("internal", "task_api_insert_failed"), 500);
  }

  // Audit log — non-blocking
  const { error: auditErr } = await supabase.from("task_edits").insert({
    task_id:    taskId,
    edited_by:  user_id,
    field_name: "task_apis.add",
    old_value:  "",
    new_value:  JSON.stringify({ api_id: data.api_id, role: data.role, invocation_params: data.invocation_params }),
  });
  if (auditErr) {
    log.error("[admin] audit_insert_failed", { taskId, field: "task_apis.add", err: auditErr.message });
  }

  return c.json({ binding: data }, 201);
});

// ── DELETE /admin/tasks/:id/apis/:bindingId ───────────────────────────────
// Remove a specific API binding from a task.
admin.delete("/tasks/:id/apis/:bindingId", async (c) => {
  const { user_id } = c.get("auth");
  const taskId    = c.req.param("id");
  const bindingId = c.req.param("bindingId");

  const supabase = createSupabaseClient(c.env);

  // Read binding before delete — needed for audit log and 404 guard
  const { data: existing, error: readErr } = await supabase
    .from("task_apis")
    .select("id, api_id, role, invocation_params")
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

  // Audit log — non-blocking
  const { error: auditErr } = await supabase.from("task_edits").insert({
    task_id:    taskId,
    edited_by:  user_id,
    field_name: "task_apis.remove",
    old_value:  JSON.stringify({ api_id: existing.api_id, role: existing.role, invocation_params: existing.invocation_params }),
    new_value:  "",
  });
  if (auditErr) {
    log.error("[admin] audit_insert_failed", { taskId, field: "task_apis.remove", err: auditErr.message });
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
      id, slug, name, user_id, created_at, is_active,
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
    is_active:           r.is_active,
    owner_email:         r.users?.email ?? null,
    created_at:          r.created_at,
    subscription_status: r.business_subscriptions?.[0]?.status ?? null,
  }));
  const next_before = has_more ? businesses[businesses.length - 1].created_at : null;

  return c.json({ businesses, has_more, next_before });
});

// ── PATCH /admin/businesses/:id/active ────────────────────────────────────
// Flip a business's is_active flag. Admin-only. Used by the admin index page
// to deactivate (hide from owner) or reactivate businesses.
const PatchActiveBody = z.object({ is_active: z.boolean() });

admin.patch("/businesses/:id/active", async (c) => {
  const { user_id } = c.get("auth");
  const id = c.req.param("id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return c.json(errBody("bad_request", "invalid business id"), 400);
  }
  let parsed;
  try {
    parsed = PatchActiveBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", String(err)), 400);
  }
  const supabase = createSupabaseClient(c.env);
  const { data, error } = await supabase
    .from("businesses")
    .update({ is_active: parsed.is_active })
    .eq("id", id)
    .select("id, is_active")
    .maybeSingle();
  if (error) {
    log.error("[admin] biz_active_update_failed", { id, err: error.message });
    return c.json(errBody("internal", "biz_active_update_failed"), 500);
  }
  if (!data) return c.json(errBody("not_found", "business not found"), 404);

  // Best-effort audit row — non-blocking
  await supabase.from("task_edits").insert({
    task_id:    null,
    edited_by:  user_id,
    field_name: "business.is_active",
    old_value:  String(!parsed.is_active),
    new_value:  String(parsed.is_active),
    metadata:   { business_id: id },
  }).then(undefined, () => { /* table may not accept null task_id; ignore */ });

  return c.json({ id: data.id, is_active: data.is_active });
});

// ── DELETE /admin/businesses/:id ──────────────────────────────────────────
// Soft delete: flips is_active=false, mangles slug + name so the original
// slug is free to reuse and the row is visually flagged as deleted. All
// dependent records (token history, subscriptions, business_context, etc.)
// are PRESERVED — hard delete is reserved for the manual purge SQL.
admin.delete("/businesses/:id", async (c) => {
  const { user_id } = c.get("auth");
  const id = c.req.param("id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return c.json(errBody("bad_request", "invalid business id"), 400);
  }
  const supabase = createSupabaseClient(c.env);

  // Read current slug + name first to compute the mangled values.
  const { data: existing, error: readErr } = await supabase
    .from("businesses")
    .select("id, slug, name")
    .eq("id", id)
    .maybeSingle();
  if (readErr) {
    log.error("[admin] biz_delete_read_failed", { id, err: readErr.message });
    return c.json(errBody("internal", "biz_delete_read_failed"), 500);
  }
  if (!existing) return c.json(errBody("not_found", "business not found"), 404);

  const ts = Math.floor(Date.now() / 1000);
  const newSlug = `${existing.slug}_deleted_${ts}`;
  const newName = `[DELETED] ${existing.name}`;

  const { error: updErr } = await supabase
    .from("businesses")
    .update({ is_active: false, slug: newSlug, name: newName })
    .eq("id", id);
  if (updErr) {
    log.error("[admin] biz_delete_update_failed", { id, err: updErr.message });
    return c.json(errBody("internal", "biz_delete_update_failed"), 500);
  }

  await supabase.from("task_edits").insert({
    task_id:    null,
    edited_by:  user_id,
    field_name: "business.soft_delete",
    old_value:  `slug=${existing.slug} name=${existing.name}`,
    new_value:  `slug=${newSlug} name=${newName}`,
    metadata:   { business_id: id },
  }).then(undefined, () => { /* tolerate audit failure */ });

  log.info("[admin] biz_soft_deleted", { id, original_slug: existing.slug });
  return c.json({ id, deleted: true });
});

// ── /admin/users — list, detail, comp-month (P1-5) ──────────────────────────
import { loadUserProfile, listUsers } from "../lib/user-profile";

// GET /admin/users?q=…&page=1&page_size=50
admin.get("/users", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const q         = c.req.query("q") ?? undefined;
  const pageRaw   = parseInt(c.req.query("page") ?? "1", 10);
  const sizeRaw   = parseInt(c.req.query("page_size") ?? "50", 10);
  const page      = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const page_size = Number.isFinite(sizeRaw) && sizeRaw > 0 ? sizeRaw : 50;

  try {
    const result = await listUsers(supabase, { q, page, page_size });
    return c.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("[admin] users_list_failed", { err: msg });
    return c.json(errBody("internal", "users_list_failed", msg), 500);
  }
});

// GET /admin/users/:id — full profile via shared helper
admin.get("/users/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return c.json(errBody("bad_request", "invalid user id"), 400);
  }
  const supabase = createSupabaseClient(c.env);
  try {
    const profile = await loadUserProfile(supabase, id);
    if (!profile) return c.json(errBody("not_found", "user not found"), 404);
    return c.json(profile);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("[admin] user_profile_load_failed", { target_user_id: id, err: msg });
    return c.json(errBody("internal", "profile_load_failed", msg), 500);
  }
});

// POST /admin/users/:id/comp-month
//
// Body: { business_id, months?: number (default 1), notes?: string }
//
// Three behaviors based on the business's current subscription state:
//
//   CASE A — No sub, or sub in canceled/expired/incomplete:
//     - Create (or revive) a comp sub: status='active', payment_source='comp',
//       stripe_subscription_id=NULL, period_start=now, period_end=now + N×30d
//     - grant_period_tokens RPC → fresh 30×N tokens for the new period
//     - mode='created', action_kind='comp_month_granted'
//
//   CASE B — Existing active/trialing sub with payment_source='card':
//     - DO NOT touch the sub row (no payment_source overwrite, no period change).
//       Spec rationale: don't disrupt a paying user's billing cycle.
//     - add_topup_tokens RPC → 30×N tokens into the persistent topup bucket
//       (does not reset period_tokens_used, doesn't touch period dates)
//     - mode='tokens_only', action_kind='tokens_granted_comp'
//
//   CASE C — Existing active/trialing sub with payment_source='comp':
//     - Extend current_period_end by N×30d (from later of now or existing end)
//     - grant_period_tokens RPC → fresh 30×N tokens for the extended period
//     - mode='extended', action_kind='comp_month_granted'
//
// admin_actions.action_kind soft enum (no DB constraint):
//   'comp_month_granted'   — sub row created or extended with payment_source='comp'
//   'tokens_granted_comp'  — tokens-only grant to a paying user, sub untouched
//   (extend this list when new admin actions are added)
const CompMonthBody = z.object({
  business_id: z.string().uuid(),
  months:      z.number().int().min(1).max(12).optional(),
  notes:       z.string().max(1000).optional(),
}).strict();

const STANDARD_MONTHLY_TOKEN_GRANT = 30;

admin.post("/users/:id/comp-month", async (c) => {
  const target_user_id = c.req.param("id");
  const { user_id: admin_user_id } = c.get("auth");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target_user_id)) {
    return c.json(errBody("bad_request", "invalid user id"), 400);
  }

  let body: z.infer<typeof CompMonthBody>;
  try {
    body = CompMonthBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", String(err)), 400);
  }
  const months = body.months ?? 1;

  const supabase = createSupabaseClient(c.env);

  // 1. Verify business belongs to target user
  const { data: biz, error: bizErr } = await supabase
    .from("businesses")
    .select("id, slug, name, user_id")
    .eq("id", body.business_id)
    .eq("user_id", target_user_id)
    .maybeSingle();
  if (bizErr) {
    log.error("[admin] comp_business_lookup_failed", { target_user_id, business_id: body.business_id, err: bizErr.message });
    return c.json(errBody("internal", "business_lookup_failed"), 500);
  }
  if (!biz) {
    return c.json(errBody("not_found", "business not found for that user"), 404);
  }

  // 2. Look up most recent subscription row
  const { data: existingSub } = await supabase
    .from("business_subscriptions")
    .select("id, status, current_period_end, payment_source")
    .eq("business_id", biz.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // 3. Determine which case we're in
  const subIsActive =
    !!existingSub &&
    (existingSub.status === "active" || existingSub.status === "trialing");

  let mode: "created" | "extended" | "tokens_only";
  let actionKind: "comp_month_granted" | "tokens_granted_comp";

  if (!subIsActive) {
    mode       = "created";
    actionKind = "comp_month_granted";
  } else if (existingSub!.payment_source === "card") {
    mode       = "tokens_only";
    actionKind = "tokens_granted_comp";
  } else {
    // payment_source === 'comp' (or unexpected like 'connect_revenue_share' —
    // treat as extend since the sub is active/trialing). Default to extend.
    mode       = "extended";
    actionKind = "comp_month_granted";
  }

  // 4. Compute period dates for sub-touching modes (created / extended)
  const now     = new Date();
  const monthMs = 30 * 24 * 60 * 60 * 1000;
  let newPeriodStart: Date = now;
  let newPeriodEnd:   Date = new Date(now.getTime() + months * monthMs);

  if (mode === "extended") {
    const existingEnd = new Date(existingSub!.current_period_end as string);
    newPeriodStart = existingEnd > now ? existingEnd : now;
    newPeriodEnd   = new Date(newPeriodStart.getTime() + months * monthMs);
  }

  // 5. Apply sub change (CASE A inserts/revives, CASE C extends, CASE B is no-op)
  if (mode === "created") {
    if (existingSub) {
      // Revive an existing inactive row
      const { error: updErr } = await supabase
        .from("business_subscriptions")
        .update({
          status:               "active",
          payment_source:       "comp",
          current_period_start: newPeriodStart.toISOString(),
          current_period_end:   newPeriodEnd.toISOString(),
          cancel_at_period_end: false,
          canceled_at:          null,
          updated_at:           now.toISOString(),
        })
        .eq("id", existingSub.id as string);
      if (updErr) {
        log.error("[admin] comp_sub_revive_failed", { target_user_id, business_id: biz.id, err: updErr.message });
        return c.json(errBody("internal", "comp_sub_revive_failed"), 500);
      }
    } else {
      // Fresh insert
      const { error: insErr } = await supabase
        .from("business_subscriptions")
        .insert({
          business_id:            biz.id,
          user_id:                target_user_id,
          plan_slug:              "standard_monthly",
          status:                 "active",
          current_period_start:   newPeriodStart.toISOString(),
          current_period_end:     newPeriodEnd.toISOString(),
          payment_source:         "comp",
          stripe_subscription_id: null,
          stripe_customer_id:     null,
        });
      if (insErr) {
        log.error("[admin] comp_sub_insert_failed", { target_user_id, business_id: biz.id, err: insErr.message });
        return c.json(errBody("internal", "comp_sub_insert_failed"), 500);
      }
    }
  } else if (mode === "extended") {
    const { error: updErr } = await supabase
      .from("business_subscriptions")
      .update({
        current_period_end: newPeriodEnd.toISOString(),
        updated_at:         now.toISOString(),
      })
      .eq("id", existingSub!.id as string);
    if (updErr) {
      log.error("[admin] comp_sub_extend_failed", { target_user_id, business_id: biz.id, err: updErr.message });
      return c.json(errBody("internal", "comp_sub_extend_failed"), 500);
    }
  }
  // mode === 'tokens_only': skip sub mutation entirely.

  // 6. Grant tokens. Different RPC per mode:
  //    created / extended → grant_period_tokens (resets the period to fresh 30×N)
  //    tokens_only        → add_topup_tokens (adds to persistent topup bucket,
  //                         does NOT touch period dates or used count)
  const tokensToGrant = STANDARD_MONTHLY_TOKEN_GRANT * months;

  if (mode === "tokens_only") {
    const description =
      "Comp tokens granted by admin" +
      (body.notes ? `: ${body.notes}` : "");
    const { error: topupErr } = await supabase.rpc("add_topup_tokens", {
      p_business_id: biz.id,
      p_user_id:     target_user_id,
      p_tokens:      tokensToGrant,
      p_topup_id:    null,
      p_description: description,
    });
    if (topupErr) {
      log.error("[admin] comp_topup_grant_failed", { target_user_id, business_id: biz.id, err: topupErr.message });
      return c.json(errBody("internal", "comp_grant_failed"), 500);
    }
  } else {
    const { error: grantErr } = await supabase.rpc("grant_period_tokens", {
      p_business_id:  biz.id,
      p_user_id:      target_user_id,
      p_tokens:       tokensToGrant,
      p_period_start: newPeriodStart.toISOString(),
      p_period_end:   newPeriodEnd.toISOString(),
    });
    if (grantErr) {
      log.error("[admin] comp_grant_failed", { target_user_id, business_id: biz.id, err: grantErr.message });
      return c.json(errBody("internal", "comp_grant_failed"), 500);
    }
  }

  // 7. Audit row — admin_actions
  const previousStatus = (existingSub?.status as string | undefined) ?? null;
  const auditMetadata: Record<string, unknown> = {
    business_id:    biz.id,
    business_slug:  biz.slug,
    months,
    tokens_granted: tokensToGrant,
    mode,
    previous_status: previousStatus,
    notes:          body.notes ?? null,
  };
  if (mode === "tokens_only") {
    auditMetadata.sub_payment_source     = existingSub!.payment_source as string;
    auditMetadata.sub_status             = existingSub!.status as string;
    auditMetadata.new_current_period_end = null;
  } else {
    auditMetadata.new_current_period_end = newPeriodEnd.toISOString();
  }

  const { error: auditErr } = await supabase.from("admin_actions").insert({
    admin_user_id,
    target_user_id,
    action_kind: actionKind,
    metadata:    auditMetadata,
  });
  if (auditErr) {
    // Audit failure shouldn't undo the user-visible grant — log + continue.
    log.error("[admin] comp_audit_failed", { target_user_id, business_id: biz.id, err: auditErr.message });
  }

  log.info("[admin] comp_month_granted", {
    admin_user_id,
    target_user_id,
    business_id:    biz.id,
    months,
    tokens_granted: tokensToGrant,
    mode,
    action_kind:    actionKind,
  });

  return c.json({
    success:            true,
    mode,
    business_id:        biz.id,
    months,
    tokens_granted:     tokensToGrant,
    current_period_end: mode === "tokens_only" ? null : newPeriodEnd.toISOString(),
    previous_status:    previousStatus,
  });
});

const RevokeCompBody = z.object({
  business_id: z.string().uuid(),
  notes:       z.string().max(1000).optional(),
}).strict();

admin.post("/users/:id/revoke-comp", async (c) => {
  const target_user_id = c.req.param("id");
  const { user_id: admin_user_id } = c.get("auth");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target_user_id)) {
    return c.json(errBody("bad_request", "invalid user id"), 400);
  }

  let body: z.infer<typeof RevokeCompBody>;
  try {
    body = RevokeCompBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", String(err)), 400);
  }

  const supabase = createSupabaseClient(c.env);

  // 1. Verify business belongs to target user
  const { data: biz, error: bizErr } = await supabase
    .from("businesses")
    .select("id, slug, name, user_id")
    .eq("id", body.business_id)
    .eq("user_id", target_user_id)
    .maybeSingle();
  if (bizErr) {
    log.error("[admin] revoke_comp_biz_lookup_failed", { target_user_id, business_id: body.business_id, err: bizErr.message });
    return c.json(errBody("internal", "business_lookup_failed"), 500);
  }
  if (!biz) {
    return c.json(errBody("not_found", "business not found for that user"), 404);
  }

  // 2. Find the most recent active subscription
  const { data: existingSub, error: subErr } = await supabase
    .from("business_subscriptions")
    .select("id, status, payment_source, current_period_end")
    .eq("business_id", biz.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (subErr) {
    log.error("[admin] revoke_comp_sub_lookup_failed", { target_user_id, business_id: biz.id, err: subErr.message });
    return c.json(errBody("internal", "sub_lookup_failed"), 500);
  }

  const subIsActive =
    !!existingSub &&
    (existingSub.status === "active" || existingSub.status === "trialing");

  if (!subIsActive) {
    return c.json(errBody("conflict", "no_active_sub", "No active subscription to revoke."), 409);
  }
  if (existingSub!.payment_source === "card") {
    return c.json(errBody("conflict", "cannot_revoke_card_sub", "This business has a card-paid subscription. Only comp subscriptions can be revoked here."), 409);
  }

  // 3. Cancel the comp sub
  const now = new Date();
  const { error: cancelErr } = await supabase
    .from("business_subscriptions")
    .update({
      status:               "canceled",
      canceled_at:          now.toISOString(),
      cancel_at_period_end: false,
      updated_at:           now.toISOString(),
    })
    .eq("id", existingSub!.id as string);
  if (cancelErr) {
    log.error("[admin] revoke_comp_cancel_failed", { target_user_id, business_id: biz.id, err: cancelErr.message });
    return c.json(errBody("internal", "revoke_failed"), 500);
  }

  // 4. Audit row
  const { error: auditErr } = await supabase.from("admin_actions").insert({
    admin_user_id,
    target_user_id,
    action_kind: "comp_revoked",
    metadata: {
      business_id:     biz.id,
      business_slug:   biz.slug,
      previous_status: existingSub!.status as string,
      payment_source:  existingSub!.payment_source as string,
      notes:           body.notes ?? null,
    },
  });
  if (auditErr) {
    log.error("[admin] revoke_comp_audit_failed", { target_user_id, business_id: biz.id, err: auditErr.message });
  }

  log.info("[admin] comp_revoked", {
    admin_user_id,
    target_user_id,
    business_id:     biz.id,
    previous_status: existingSub!.status as string,
  });

  return c.json({
    success:         true,
    business_id:     biz.id,
    previous_status: existingSub!.status as string,
    canceled_at:     now.toISOString(),
  });
});

// ── GET /admin/prompt-definitions ────────────────────────────────────────────
// Returns the active prompt definition for every task that has one.
admin.get("/prompt-definitions", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const { data, error } = await supabase
    .from("prompt_definitions")
    .select("id, task_slug, version, system_prompt, user_prompt_template, is_active, created_at, created_by, change_note")
    .eq("is_active", true)
    .order("task_slug", { ascending: true });
  if (error) {
    log.error("[admin] prompt_definitions_list_failed", { err: error.message });
    return c.json(errBody("internal", "prompt_definitions_list_failed"), 500);
  }
  return c.json({ prompt_definitions: data ?? [] });
});

// ── GET /admin/prompt-definitions/:taskSlug ───────────────────────────────────
// Returns all versions for a specific task, newest first.
admin.get("/prompt-definitions/:taskSlug", async (c) => {
  const taskSlug = c.req.param("taskSlug");
  const supabase = createSupabaseClient(c.env);
  const { data, error } = await supabase
    .from("prompt_definitions")
    .select("id, task_slug, version, system_prompt, user_prompt_template, is_active, created_at, created_by, change_note")
    .eq("task_slug", taskSlug)
    .order("version", { ascending: false });
  if (error) {
    log.error("[admin] prompt_definitions_task_failed", { taskSlug, err: error.message });
    return c.json(errBody("internal", "prompt_definitions_task_failed"), 500);
  }
  return c.json({ versions: data ?? [] });
});

// ── POST /admin/prompt-definitions/:taskSlug ──────────────────────────────────
// Creates a new version for a task (increments version, makes it active,
// deactivates the previous active version). Never overwrites existing rows.
const PostPromptBody = z.object({
  user_prompt_template: z.string().min(1, "user_prompt_template is required"),
  system_prompt:        z.string().nullable().optional(),
  change_note:          z.string().max(500).nullish(),
});

admin.post("/prompt-definitions/:taskSlug", async (c) => {
  const { user_id } = c.get("auth");
  const taskSlug = c.req.param("taskSlug");

  let body: z.infer<typeof PostPromptBody>;
  try {
    body = PostPromptBody.parse(await c.req.json());
  } catch (err) {
    log.error("[admin] prompt_definition_parse_failed", { taskSlug, err: String(err) });
    return c.json(errBody("bad_request", "invalid body", String(err)), 400);
  }

  const supabase = createSupabaseClient(c.env);

  const { data: task, error: taskErr } = await supabase
    .from("tasks")
    .select("slug")
    .eq("slug", taskSlug)
    .maybeSingle();
  if (taskErr) return c.json(errBody("internal", "task_lookup_failed"), 500);
  if (!task)   return c.json(errBody("not_found", `task '${taskSlug}' not found`), 404);

  // Find the highest existing version for this task.
  const { data: maxRow } = await supabase
    .from("prompt_definitions")
    .select("version")
    .eq("task_slug", taskSlug)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion = (maxRow?.version ?? 0) + 1;

  // Deactivate the current active version (if any).
  await supabase
    .from("prompt_definitions")
    .update({ is_active: false })
    .eq("task_slug", taskSlug)
    .eq("is_active", true);

  // Insert the new version as active.
  const { data: created, error: insertErr } = await supabase
    .from("prompt_definitions")
    .insert({
      task_slug:            taskSlug,
      version:              nextVersion,
      system_prompt:        body.system_prompt ?? null,
      user_prompt_template: body.user_prompt_template,
      is_active:            true,
      created_by:           user_id,
      change_note:          body.change_note ?? null,
    })
    .select()
    .single();

  if (insertErr) {
    log.error("[admin] prompt_definition_create_failed", { taskSlug, err: insertErr.message });
    return c.json(errBody("internal", "prompt_definition_create_failed"), 500);
  }

  log.info("[admin] prompt_definition_created", { taskSlug, version: nextVersion, user_id });
  return c.json({ prompt_definition: created }, 201);
});

// ── PATCH /admin/prompt-definitions/:id/activate ─────────────────────────────
// Re-activates a specific version (no-op if already active).
admin.patch("/prompt-definitions/:id/activate", async (c) => {
  const { user_id } = c.get("auth");
  const defId = c.req.param("id");
  const supabase = createSupabaseClient(c.env);

  const { data: def, error: readErr } = await supabase
    .from("prompt_definitions")
    .select("id, task_slug, version, is_active")
    .eq("id", defId)
    .maybeSingle();
  if (readErr) return c.json(errBody("internal", "prompt_definition_read_failed"), 500);
  if (!def)    return c.json(errBody("not_found", "prompt definition not found"), 404);

  if (def.is_active) {
    return c.json({ prompt_definition: def }); // already active — no-op
  }

  const taskSlug = def.task_slug as string;

  // Deactivate whichever version is currently active.
  await supabase
    .from("prompt_definitions")
    .update({ is_active: false })
    .eq("task_slug", taskSlug)
    .eq("is_active", true);

  // Activate the requested version.
  const { data: activated, error: activateErr } = await supabase
    .from("prompt_definitions")
    .update({ is_active: true })
    .eq("id", defId)
    .select()
    .single();

  if (activateErr) {
    log.error("[admin] prompt_definition_activate_failed", { defId, err: activateErr.message });
    return c.json(errBody("internal", "prompt_definition_activate_failed"), 500);
  }

  log.info("[admin] prompt_definition_activated", {
    defId,
    taskSlug,
    version: def.version,
    user_id,
  });
  return c.json({ prompt_definition: activated });
});

// ── GET /admin/prompt-variables ───────────────────────────────────────────────
// Returns the full variable catalog for the authoring UX.
admin.get("/prompt-variables", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const { data, error } = await supabase
    .from("prompt_variables")
    .select("id, name, description, source, created_at")
    .order("name", { ascending: true });
  if (error) {
    log.error("[admin] prompt_variables_list_failed", { err: error.message });
    return c.json(errBody("internal", "prompt_variables_list_failed"), 500);
  }
  return c.json({ variables: data ?? [] });
});

// ── POST /admin/task-trigger-blocks/clear ────────────────────────────────────
// Clears the attempt block for a (business_id, task_slug) pair so the task
// can be triggered again after admin review. Called after a human has
// investigated the 2-failure block and determined it's safe to re-run.
//
// Body: { business_id: string, task_slug: string }
// Response: { ok: true, cleared_at: string }
admin.post("/task-trigger-blocks/clear", async (c) => {
  const { user_id } = c.get("auth");
  const supabase = createSupabaseClient(c.env);

  let body: { business_id?: string; task_slug?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json(errBody("bad_request", "invalid JSON body"), 400);
  }

  const { business_id, task_slug } = body;
  if (!business_id || !task_slug) {
    return c.json(errBody("bad_request", "business_id and task_slug are required"), 400);
  }

  // Resolve task_id from slug
  const { data: taskRow, error: taskErr } = await supabase
    .from("tasks")
    .select("id")
    .eq("slug", task_slug)
    .maybeSingle();
  if (taskErr) {
    log.error("[admin] task_trigger_block_clear_task_lookup_failed", { task_slug, err: taskErr.message });
    return c.json(errBody("internal", "task_lookup_failed"), 500);
  }
  if (!taskRow) {
    return c.json(errBody("not_found", `task '${task_slug}' not found`), 404);
  }

  const cleared_at = new Date().toISOString();
  const { data: updated, error: updateErr } = await supabase
    .from("task_trigger_blocks")
    .update({ cleared_at })
    .eq("business_id", business_id)
    .eq("task_id", (taskRow as { id: string }).id)
    .is("cleared_at", null)
    .select("business_id, task_id, blocked_at, cleared_at")
    .maybeSingle();

  if (updateErr) {
    log.error("[admin] task_trigger_block_clear_failed", {
      business_id,
      task_slug,
      err: updateErr.message,
    });
    return c.json(errBody("internal", "task_trigger_block_clear_failed"), 500);
  }
  if (!updated) {
    return c.json(
      { error: "not_blocked", message: `No active block found for business '${business_id}' task '${task_slug}'.` },
      404,
    );
  }

  log.info("[admin] task_trigger_block_cleared", {
    business_id,
    task_slug,
    cleared_by: user_id,
    cleared_at,
  });
  return c.json({ ok: true, cleared_at });
});

// ── POST /admin/test-harness/run ──────────────────────────────────────────────
// Runs every eligible task once against a given business, polls for completion,
// returns a results table. Admin/dev tool only.
//
// Eligible = active + non-system + non-configured + slug NOT LIKE generate-business-app%
//          + has an active prompt_definitions row.
//
// Excluded (documented in response):
//   - generate-business-app* tasks: legitimately run 60-120s; excluded to keep harness ≤90s
//   - output_type='configured' tasks: no LLM path
//   - kind='system' tasks: no user-facing LLM path
//   - tasks with no active prompt_definitions row: nothing to run
admin.post("/test-harness/run", async (c) => {
  const supabase = createSupabaseClient(c.env);

  let body: { business_slug?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json(errBody("bad_request", "invalid JSON body"), 400);
  }
  const { business_slug } = body;
  if (!business_slug) {
    return c.json(errBody("bad_request", "business_slug required"), 400);
  }

  // 1. Fetch test business (admin path — no user_id scoping)
  const { data: bizRow, error: bizErr } = await supabase
    .from("businesses")
    .select("id, user_id, slug, name, kind, existing_business_url, existing_business_data, created_at")
    .eq("slug", business_slug)
    .eq("is_active", true)
    .maybeSingle();
  if (bizErr) {
    log.error("[harness] business_lookup_failed", { business_slug, err: bizErr.message });
    return c.json(errBody("internal", "business_lookup_failed"), 500);
  }
  if (!bizRow) {
    return c.json(errBody("not_found", `business '${business_slug}' not found`), 404);
  }
  const business = bizRow as BusinessRow;

  // 2. Find eligible tasks
  const { data: activePromptRows, error: promptErr } = await supabase
    .from("prompt_definitions")
    .select("task_slug")
    .eq("is_active", true);
  if (promptErr) {
    log.error("[harness] prompt_lookup_failed", { err: promptErr.message });
    return c.json(errBody("internal", "prompt_lookup_failed"), 500);
  }
  const activePromptSlugs = new Set(
    (activePromptRows ?? []).map((p: { task_slug: string }) => p.task_slug),
  );

  const { data: taskRows, error: taskErr } = await supabase
    .from("tasks")
    .select(TASK_SELECT_COLUMNS)
    .eq("status", "active")
    .neq("kind", "system")
    .neq("output_type", "configured")
    .not("slug", "like", "generate-business-app%");
  if (taskErr) {
    log.error("[harness] task_list_failed", { err: taskErr.message });
    return c.json(errBody("internal", "task_list_failed"), 500);
  }

  const allCandidates = (taskRows ?? []) as unknown as TaskRow[];
  const eligibleTasks = allCandidates.filter((t) => activePromptSlugs.has(t.slug));
  const noPromptExcluded = allCandidates
    .filter((t) => !activePromptSlugs.has(t.slug))
    .map((t) => ({ slug: t.slug, name: t.name, reason: "no_active_prompt" }));

  const staticExclusions = [
    { slug: "generate-business-app*", name: "App Builder tasks", reason: "long_running_excluded_≥60s" },
    { slug: "(configured)", name: "Configured output tasks", reason: "no_llm_path" },
    { slug: "(system)", name: "System tasks", reason: "system_kind_excluded" },
  ];

  if (eligibleTasks.length === 0) {
    return c.json({
      harness_run_at: new Date().toISOString(),
      test_business: { slug: business.slug, name: business.name, id: business.id },
      summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
      excluded: [...staticExclusions, ...noPromptExcluded],
      results: [],
    });
  }

  // 3. Insert task_run rows and launch via waitUntil
  type HarnessEntry = { task: TaskRow; run_id: string };
  const launched: HarnessEntry[] = [];
  const launchFailed: Array<{ slug: string; name: string; error: string }> = [];

  for (const task of eligibleTasks) {
    const { data: runRow, error: insertErr } = await supabase
      .from("task_runs")
      .insert({
        user_id: business.user_id,
        business_id: business.id,
        task_id: task.id,
        status: "running",
        started_at: new Date().toISOString(),
        config: null,
      })
      .select("id")
      .single();

    if (insertErr || !runRow) {
      log.error("[harness] task_run_insert_failed", { slug: task.slug, err: insertErr?.message });
      launchFailed.push({ slug: task.slug, name: task.name, error: insertErr?.message ?? "insert_failed" });
      continue;
    }

    const taskRunId = (runRow as { id: string }).id;
    launched.push({ task, run_id: taskRunId });

    c.executionCtx.waitUntil(
      runTaskInBackground(c.env, business, task, business.user_id, taskRunId),
    );
  }

  log.info("[harness] launched", {
    business_slug,
    count: launched.length,
    run_ids: launched.map((e) => e.run_id),
  });

  // 4. Poll for completion (max 90s, 3s intervals)
  // Apply inline 60s sweep at each tick since cron is disabled in test env.
  type RunRow = { id: string; status: string; started_at: string; completed_at: string | null; error: string | null };
  const pendingIds = new Set(launched.map((e) => e.run_id));
  const doneRows = new Map<string, RunRow>();
  const pollStart = Date.now();

  // Fetch app-builder task IDs once (for the sweep exclusion)
  const { data: appTaskRows } = await supabase
    .from("tasks")
    .select("id")
    .like("slug", "generate-business-app%");
  const appTaskIds = (appTaskRows ?? []).map((r: { id: string }) => r.id);

  while (pendingIds.size > 0 && Date.now() - pollStart < 90_000) {
    await new Promise<void>((resolve) => setTimeout(resolve, 3000));

    // Inline 60s sweep for stuck runs (mirrors business-task-run.ts poll path)
    const sweepCutoff = new Date(Date.now() - 60_000).toISOString();
    const pendingArr = Array.from(pendingIds);
    const sweepQ = supabase
      .from("task_runs")
      .update({ status: "failed", error: "timeout_60s", completed_at: new Date().toISOString() })
      .eq("status", "running")
      .lt("started_at", sweepCutoff)
      .in("id", pendingArr);
    await (appTaskIds.length > 0
      ? sweepQ.not("task_id", "in", `(${appTaskIds.join(",")})`)
      : sweepQ);

    // Check current status of all pending runs
    const { data: statusRows } = await supabase
      .from("task_runs")
      .select("id, status, started_at, completed_at, error")
      .in("id", pendingArr);

    for (const row of (statusRows ?? []) as RunRow[]) {
      if (row.status !== "running") {
        doneRows.set(row.id, row);
        pendingIds.delete(row.id);
      }
    }
  }

  // 5. Assemble results
  type HarnessResult = {
    task: string; name: string; status: string;
    duration_s: number | null; error: string | null; task_run_id: string;
  };
  const results: HarnessResult[] = [];

  for (const entry of launched) {
    const row = doneRows.get(entry.run_id);
    if (row) {
      const duration_s =
        row.completed_at && row.started_at
          ? Math.round((new Date(row.completed_at).getTime() - new Date(row.started_at).getTime()) / 1000)
          : null;
      results.push({
        task: entry.task.slug,
        name: entry.task.name,
        status: row.status,
        duration_s,
        error: row.error ?? null,
        task_run_id: entry.run_id,
      });
    } else {
      // Still running after 90s — shouldn't happen after 60s sweep, but cover it
      results.push({
        task: entry.task.slug,
        name: entry.task.name,
        status: "still_running",
        duration_s: null,
        error: "did_not_complete_in_90s",
        task_run_id: entry.run_id,
      });
    }
  }

  for (const lf of launchFailed) {
    results.push({
      task: lf.slug,
      name: lf.name,
      status: "failed",
      duration_s: null,
      error: `launch_failed:${lf.error}`,
      task_run_id: "",
    });
  }

  const passed = results.filter((r) => r.status === "completed").length;
  const failed = results.filter((r) => r.status !== "completed").length;

  log.info("[harness] complete", {
    business_slug,
    total: results.length,
    passed,
    failed,
  });

  return c.json({
    harness_run_at: new Date().toISOString(),
    test_business: { slug: business.slug, name: business.name, id: business.id },
    summary: { total: results.length, passed, failed, skipped: noPromptExcluded.length },
    excluded: [...staticExclusions, ...noPromptExcluded],
    results,
  });
});

export default admin;
