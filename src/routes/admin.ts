import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
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
import { FREE_BUILD_TASK_HANDLERS } from "../lib/free-build-orchestrator";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicClient } from "../services/anthropic";
import { pickVisualChoices, fetchUnsplashPhoto } from "../lib/pick-visual-choices";
import { loadModelConfig } from "../lib/model-config";
import { loadFeatureConfig, resolveFeatureModel, FEATURE_REGISTRY, type FeatureKey } from "../lib/non-task-model-config";
import {
  loadProviders, validateProviderDefinition, ProviderDefinitionError,
  PLACEMENTS, POSITIONS,
} from "../lib/site-render/integrations";

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
admin.use("/harness", requireAdmin);
admin.use("/harness/*", requireAdmin);
admin.use("/platforms", requireAdmin);
admin.use("/platforms/*", requireAdmin);
admin.use("/pillar-methods", requireAdmin);
admin.use("/pillar-methods/*", requireAdmin);
admin.use("/pillar-data-sources", requireAdmin);

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

  // Flag tasks that can't run: no active prompt_definitions row AND no dedicated
  // handler AND not a tool/retrieval task. Turns the silent catalog-drop into a
  // loud admin signal so a prompt-less task can never vanish unnoticed again.
  const { data: promptRows } = await supabase
    .from("prompt_definitions")
    .select("task_slug")
    .eq("is_active", true);
  const activePromptSlugs = new Set(
    ((promptRows as Array<{ task_slug: string }> | null) ?? []).map((r) => r.task_slug),
  );
  const tasks = ((data as any[]) ?? []).map((t) => {
    const has_active_prompt = activePromptSlugs.has(t.slug);
    const hasHandler = t.slug in FREE_BUILD_TASK_HANDLERS;
    const isToolOrRetrieval = t.output_type === "configured" || t.output_type === "retrieval";
    return {
      ...t,
      has_active_prompt,
      will_not_run: !has_active_prompt && !hasHandler && !isToolOrRetrieval,
    };
  });
  return c.json({ tasks });
});

// ── POST /admin/tasks/:slug/generate-prompt ──────────────────────────────────
// Generate a system_prompt + user_prompt_template from the task's name + brief,
// grounded in the prompt_variables catalog. Returns the text only (NO write) —
// the client persists it via the existing POST /admin/prompt-definitions/:slug
// flow. Manual, admin-triggered; nothing goes active until the client writes it.
admin.post("/tasks/:slug/generate-prompt", async (c) => {
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  const { data: task, error: tErr } = await supabase
    .from("tasks")
    .select("slug, name, description_short, description_long, output_type")
    .eq("slug", slug)
    .maybeSingle();
  if (tErr) return c.json(errBody("internal", "task_lookup_failed"), 500);
  if (!task) return c.json(errBody("not_found", `task '${slug}' not found`), 404);

  const { data: vars } = await supabase
    .from("prompt_variables")
    .select("name, description")
    .order("name");
  const varCatalog = ((vars as Array<{ name: string; description: string | null }> | null) ?? [])
    .map((v) => `- {{${v.name}}}: ${v.description ?? ""}`)
    .join("\n");

  const t = task as { name: string; description_short: string | null; description_long: string | null; output_type: string };
  const brief = t.description_long || t.description_short || t.name;
  const anthropic = createAnthropicClient(c.env);
  const models = await loadModelConfig(supabase);

  const system =
    "You author production prompts for an internal AI task system. Given a task's " +
    "name and brief, write a system_prompt (the agent's role, rules, output " +
    "discipline) and a user_prompt_template (the rendered instruction). The " +
    "user_prompt_template MUST reference ONLY variables from the provided catalog " +
    "using {{double.brace}} syntax -- never invent variables. It must instruct the " +
    "model to produce the task's output and state the exact output shape.\n\n" +
    "OUTPUT-SIZE DISCIPLINE (REQUIRED -- prompts that ignore this get rejected):\n" +
    "The task runs inside a worker with a bounded lifetime, so the prompt you write " +
    "MUST make the model produce COMPACT output that finishes quickly. Concretely, " +
    "the prompt you author must:\n" +
    "- Cap the result at 3-6 sections. State the cap explicitly in the prompt.\n" +
    "- Cap each section to roughly 80-120 words of tight, high-signal content.\n" +
    "- Tell the model to be economical: no filler, no preamble, no restating the " +
    "brief, no repetition. Prefer structured, scannable output over long prose.\n" +
    "- State an explicit overall ceiling in the prompt (e.g. 'Keep the whole " +
    "document under ~700 words').\n" +
    "- NEVER ask for a 'comprehensive', 'exhaustive', 'detailed', 'in-depth', or " +
    "'thorough' document, and never say 'as much detail as possible'. Those phrases " +
    "produce runaway output that times out. Ask for the sharpest useful version, not " +
    "the longest.\n\n" +
    "OUTPUT-SHAPE CONTRACT (document tasks -- CRITICAL, non-negotiable):\n" +
    "The running task's response is parsed as STRICT JSON of EXACTLY this shape:\n" +
    '  { "title": string, "sections": [ { "heading": string, "body": string } ] }\n' +
    "The user_prompt_template you write MUST instruct the model to return ONLY that " +
    "JSON object -- nothing before or after it, no markdown headings like '**1. ...**', " +
    "no prose outside the JSON, no ```json fences. Map your capped 3-6 sections to the " +
    "'sections' array (so 'produce exactly N sections' means N array items); each " +
    "section's 80-120 words go in its 'body' string (markdown is allowed INSIDE the " +
    "body string). A prompt that asks for markdown sections or free-form text instead " +
    "of this JSON will fail to parse and the task will die -- always spell out the JSON " +
    "shape explicitly in the prompt you write.\n\n" +
    'Return ONLY a JSON object {"system_prompt": string, "user_prompt_template": string} ' +
    "-- no markdown fences, no commentary.";
  const userMsg =
    `Task name: ${t.name}\n` +
    `Output type: ${t.output_type}\n` +
    `Brief (the seed -- purpose / audience / content / inputs / constraints):\n${brief}\n\n` +
    `Available variables (use ONLY these):\n${varCatalog}\n\n` +
    "Write the system_prompt and user_prompt_template. The generated prompt MUST " +
    "enforce the output-size discipline from your instructions (3-6 capped sections, " +
    "~80-120 words each, an explicit overall ceiling, no 'comprehensive'/open-ended " +
    "language). Return ONLY the JSON object.";

  let msg;
  try {
    msg = await anthropic.messages.create({
      model: models.sonnet,
      max_tokens: 2000,
      system,
      messages: [{ role: "user", content: userMsg }],
    });
  } catch (err) {
    log.error("[admin] generate_prompt_llm_failed", { slug, err: String(err) });
    return c.json(errBody("upstream_error", "prompt generation failed"), 502);
  }

  const blocks = (msg as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  let raw = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
  raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "");
  const open = raw.indexOf("{");
  const close = raw.lastIndexOf("}");
  if (open >= 0 && close > open) raw = raw.slice(open, close + 1);
  let parsed: { system_prompt?: string; user_prompt_template?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return c.json(errBody("upstream_error", "prompt generation returned unparseable output"), 502);
  }
  if (!parsed.user_prompt_template || !parsed.user_prompt_template.trim()) {
    return c.json(errBody("upstream_error", "prompt generation produced no user_prompt_template"), 502);
  }
  log.info("[admin] prompt_generated", { slug });
  return c.json({
    system_prompt: parsed.system_prompt ?? null,
    user_prompt_template: parsed.user_prompt_template,
  });
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
  // Per-prompt output cap (migration 084). Omitted → defaults to a safe 1500
  // on insert (returns in ~40s); raise per-prompt by explicit choice.
  max_output_tokens:    z.number().int().min(256).max(4000).nullish(),
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

  // ── system_prompt carry-forward + reject-null ──────────────────────────────
  // system_prompt is TASK-LEVEL (generated from the task's description, never the
  // template), so editing a template's FORMAT must NOT lose it. When the request
  // doesn't supply a non-empty system_prompt (e.g. the editor's "Save as new
  // version" after a hand-edit, which sends null), inherit the most recent
  // version that has one. genericDocumentRunner throws task_missing_system_prompt
  // on an empty system_prompt, so a version with none is unrunnable — reject it
  // rather than persist it. (A DB CHECK NOT VALID constraint, migration 085, is
  // the systemic backstop for every other write path.)
  let systemPrompt =
    body.system_prompt && body.system_prompt.trim() !== ""
      ? body.system_prompt
      : null;
  if (!systemPrompt) {
    const { data: lastGood } = await supabase
      .from("prompt_definitions")
      .select("version, system_prompt")
      .eq("task_slug", taskSlug)
      .not("system_prompt", "is", null)
      .neq("system_prompt", "")
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    const carried = (lastGood as { version: number; system_prompt: string } | null);
    if (carried?.system_prompt && carried.system_prompt.trim() !== "") {
      systemPrompt = carried.system_prompt;
      log.info("[admin] prompt_system_prompt_carried_forward", {
        taskSlug, from_version: carried.version, to_version: nextVersion,
      });
    }
  }
  if (!systemPrompt) {
    // No supplied system prompt AND no prior good one to carry — do not persist
    // an unrunnable version.
    return c.json(
      errBody("bad_request", "No system prompt for this task — run Generate Prompt first."),
      400,
    );
  }

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
      system_prompt:        systemPrompt,
      user_prompt_template: body.user_prompt_template,
      is_active:            true,
      created_by:           user_id,
      change_note:          body.change_note ?? null,
      max_output_tokens:    body.max_output_tokens ?? 1500,
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

// ── Content Pillars (Stage 1) — platform methods + their pillars ─────────────
// Platform tier: pillar_methods + pillar_templates (shared to all businesses).
// business_pillars (per-business adoption) is Stage 2. Writes go through the
// service-role Worker here; data_source is validated against the DB vocab.

function pillarSlugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

const PillarInput = z.object({
  name: z.string().min(1),
  intent: z.string().nullable().optional(),
  register: z.string().nullable().optional(),
  data_source: z.string().min(1),
  display_order: z.number().optional(),
});
const PostMethodBody = z.object({
  name: z.string().min(1),
  slug: z.string().optional(),
  attributed_to: z.string().nullable().optional(),
  credential: z.string().nullable().optional(),
  premise: z.string().nullable().optional(),
  portrait_url: z.string().nullable().optional(),
  is_core: z.boolean().optional(),
  status: z.enum(["draft", "published", "coming_soon"]).optional(),
  display_order: z.number().optional(),
  pillars: z.array(PillarInput).optional(),
});
const PatchMethodBody = PostMethodBody.partial();

// GET /admin/pillar-data-sources — controlled data_source vocabulary (for the
// authoring <select>; DB-driven, not hardcoded in the frontend).
admin.get("/pillar-data-sources", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const { data, error } = await supabase
    .from("pillar_data_sources")
    .select("slug, label, description, display_order")
    .order("display_order", { ascending: true });
  if (error) {
    log.error("[admin] pillar_data_sources_list_failed", { err: error.message });
    return c.json(errBody("internal", "pillar_data_sources_list_failed"), 500);
  }
  return c.json({ data_sources: data ?? [] });
});

// GET /admin/pillar-methods — all methods with their pillars nested.
admin.get("/pillar-methods", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const [methodsRes, tplRes] = await Promise.all([
    supabase
      .from("pillar_methods")
      .select("id, slug, name, attributed_to, credential, premise, portrait_url, status, is_core, display_order, updated_at")
      .order("display_order", { ascending: true }),
    supabase
      .from("pillar_templates")
      .select("id, method_id, name, intent, register, data_source, display_order")
      .eq("is_default", false) // hide the General generation default from authoring
      .order("display_order", { ascending: true }),
  ]);
  if (methodsRes.error || tplRes.error) {
    log.error("[admin] pillar_methods_list_failed", { err: String(methodsRes.error ?? tplRes.error) });
    return c.json(errBody("internal", "pillar_methods_list_failed"), 500);
  }
  const byMethod: Record<string, unknown[]> = {};
  for (const t of tplRes.data ?? []) (byMethod[(t as { method_id: string }).method_id] ||= []).push(t);
  const methods = (methodsRes.data ?? []).map((m) => ({
    ...m,
    pillars: byMethod[(m as { id: string }).id] ?? [],
  }));
  return c.json({ methods });
});

// POST /admin/pillar-methods — create a method + its pillars (draft by default).
admin.post("/pillar-methods", async (c) => {
  let parsed: z.infer<typeof PostMethodBody>;
  try {
    parsed = PostMethodBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", String(err)), 400);
  }
  const supabase = createSupabaseClient(c.env);
  const slug = parsed.slug?.trim() ? pillarSlugify(parsed.slug) : pillarSlugify(parsed.name);
  if (!slug) return c.json(errBody("bad_request", "could not derive slug from name"), 400);

  let order = parsed.display_order;
  if (order === undefined) {
    const { data: maxRow } = await supabase
      .from("pillar_methods")
      .select("display_order")
      .order("display_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    order = ((maxRow?.display_order as number) ?? 0) + 1;
  }

  const { data: method, error: mErr } = await supabase
    .from("pillar_methods")
    .insert({
      slug,
      name: parsed.name,
      attributed_to: parsed.attributed_to ?? null,
      credential: parsed.credential ?? null,
      premise: parsed.premise ?? null,
      portrait_url: parsed.portrait_url ?? null,
      is_core: parsed.is_core ?? false,
      status: parsed.status ?? "draft",
      display_order: order,
    })
    .select("id")
    .single();
  if (mErr || !method) {
    log.error("[admin] pillar_method_insert_failed", { err: mErr?.message });
    return c.json(errBody("internal", `pillar_method_insert_failed: ${mErr?.message}`), 500);
  }
  const methodId = (method as { id: string }).id;

  const pillars = parsed.pillars ?? [];
  if (pillars.length) {
    const rows = pillars.map((p, i) => ({
      method_id: methodId,
      name: p.name,
      intent: p.intent ?? null,
      register: p.register ?? null,
      data_source: p.data_source,
      display_order: p.display_order ?? i + 1,
    }));
    const { error: pErr } = await supabase.from("pillar_templates").insert(rows);
    if (pErr) {
      log.error("[admin] pillar_templates_insert_failed", { err: pErr.message });
      return c.json(errBody("internal", `pillar_templates_insert_failed: ${pErr.message}`), 500);
    }
  }
  return c.json({ ok: true, id: methodId, slug }, 201);
});

// PATCH /admin/pillar-methods/:id — update method fields; if `pillars` is
// present, replace the method's pillar set. Publish = { status: 'published' }.
admin.patch("/pillar-methods/:id", async (c) => {
  const id = c.req.param("id");
  let parsed: z.infer<typeof PatchMethodBody>;
  try {
    parsed = PatchMethodBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", String(err)), 400);
  }
  const supabase = createSupabaseClient(c.env);

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const k of ["name", "attributed_to", "credential", "premise", "portrait_url", "is_core", "status", "display_order"] as const) {
    if (parsed[k] !== undefined) updates[k] = parsed[k];
  }
  if (parsed.slug !== undefined && parsed.slug) updates.slug = pillarSlugify(parsed.slug);

  const { error: uErr } = await supabase.from("pillar_methods").update(updates).eq("id", id);
  if (uErr) {
    log.error("[admin] pillar_method_update_failed", { id, err: uErr.message });
    return c.json(errBody("internal", `pillar_method_update_failed: ${uErr.message}`), 500);
  }

  if (parsed.pillars !== undefined) {
    await supabase.from("pillar_templates").delete().eq("method_id", id);
    const rows = (parsed.pillars ?? []).map((p, i) => ({
      method_id: id,
      name: p.name,
      intent: p.intent ?? null,
      register: p.register ?? null,
      data_source: p.data_source,
      display_order: p.display_order ?? i + 1,
    }));
    if (rows.length) {
      const { error: pErr } = await supabase.from("pillar_templates").insert(rows);
      if (pErr) {
        log.error("[admin] pillar_templates_replace_failed", { id, err: pErr.message });
        return c.json(errBody("internal", `pillar_templates_replace_failed: ${pErr.message}`), 500);
      }
    }
  }
  return c.json({ ok: true, id });
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

// ── Harness helpers ───────────────────────────────────────────────────────────

type NotRunEntry = { slug: string; name: string; disposition: string; reason: string };
type HarnessRunMeta = {
  id: string; status: string; started_at: string; completed_at: string | null;
  task_count: number; business_id: string | null;
};

function classifyTasksForHarness(
  allTasks: TaskRow[],
  activePromptSlugs: Set<string>,
): { eligibleTasks: TaskRow[]; notRun: NotRunEntry[] } {
  const eligibleTasks: TaskRow[] = [];
  const notRun: NotRunEntry[] = [];
  for (const task of allTasks) {
    if (task.status !== "active") {
      notRun.push({ slug: task.slug, name: task.name, disposition: `inactive_${task.status}`, reason: `status=${task.status}` });
    } else if (task.kind === "system") {
      notRun.push({ slug: task.slug, name: task.name, disposition: "excluded_system", reason: "kind=system, no user-facing LLM path" });
    } else if (task.output_type === "configured") {
      notRun.push({ slug: task.slug, name: task.name, disposition: "excluded_configured", reason: "output_type=configured, no LLM path" });
    } else if (task.slug.startsWith("generate-business-app") || task.slug === "public-business-website") {
      notRun.push({ slug: task.slug, name: task.name, disposition: "excluded_long_running", reason: "app-builder task or public-business-website, on 300s watchdog tier" });
    } else if (!activePromptSlugs.has(task.slug)) {
      notRun.push({ slug: task.slug, name: task.name, disposition: "skipped_no_prompt", reason: "active task but no active prompt_definitions row" });
    } else {
      eligibleTasks.push(task);
    }
  }
  return { eligibleTasks, notRun };
}

const PHASE_SLUG_TO_NUM: Record<string, number> = { foundation: 1, launch: 2, scale: 3 };

async function fetchHarnessRunStatus(
  supabase: ReturnType<typeof createSupabaseClient>,
  runId: string,
  run: HarnessRunMeta,
) {
  const NOW = Date.now();
  const SLOW_MS = 30_000;

  const [{ data: runRows }, { data: phaseRows }] = await Promise.all([
    supabase
      .from("task_runs")
      .select("id, status, started_at, completed_at, error, task_id, tasks(slug, name, output_type, lifecycle_phase_id)")
      .eq("harness_run_id", runId)
      .order("started_at"),
    supabase.from("lifecycle_phases").select("id, slug"),
  ]);

  const phaseMap: Record<string, number> = {};
  for (const p of (phaseRows ?? []) as Array<{ id: string; slug: string }>) {
    phaseMap[p.id] = PHASE_SLUG_TO_NUM[p.slug] ?? 0;
  }

  type TaskRunRow = {
    id: string; status: string; started_at: string;
    completed_at: string | null; error: string | null; task_id: string;
    tasks: { slug: string; name: string; output_type: string; lifecycle_phase_id: string | null } | null;
  };
  const rows = (runRows ?? []) as unknown as TaskRunRow[];

  const tasks = rows.map(row => {
    const startMs = new Date(row.started_at).getTime();
    const isRunning = row.status === "running";
    const isSlow = isRunning && NOW - startMs > SLOW_MS;
    const effectiveStatus = isSlow ? "slow" : row.status;
    const duration_s = row.completed_at
      ? Math.round((new Date(row.completed_at).getTime() - startMs) / 1000)
      : isRunning ? Math.round((NOW - startMs) / 1000)
      : null;
    const phaseId = row.tasks?.lifecycle_phase_id ?? null;
    return {
      task_run_id: row.id,
      slug: row.tasks?.slug ?? "",
      name: row.tasks?.name ?? "",
      output_type: row.tasks?.output_type ?? "",
      phase: phaseId ? (phaseMap[phaseId] ?? 0) : 0,
      status: effectiveStatus,
      duration_s,
      error: row.error ?? null,
      started_at: row.started_at,
      completed_at: row.completed_at,
    };
  });

  const summary = {
    total: tasks.length,
    running: tasks.filter(t => t.status === "running" || t.status === "slow").length,
    slow: tasks.filter(t => t.status === "slow").length,
    passed: tasks.filter(t => t.status === "completed").length,
    failed: tasks.filter(t => t.status === "failed").length,
    queued: tasks.filter(t => t.status === "queued").length,
  };

  let finalStatus = run.status;
  let finalCompletedAt = run.completed_at;
  if (tasks.length > 0 && run.status === "running" &&
      tasks.every(t => t.status === "completed" || t.status === "failed")) {
    finalCompletedAt = new Date().toISOString();
    const { error: closeErr } = await supabase
      .from("harness_runs")
      .update({ status: "complete", completed_at: finalCompletedAt })
      .eq("id", runId)
      .eq("status", "running");
    if (!closeErr) finalStatus = "complete";
  }

  const runStartMs = new Date(run.started_at).getTime();
  const runEndMs = finalCompletedAt ? new Date(finalCompletedAt).getTime() : NOW;
  const duration_s = Math.round((runEndMs - runStartMs) / 1000);

  return {
    harness_run_id: runId,
    status: finalStatus,
    started_at: run.started_at,
    completed_at: finalCompletedAt ?? null,
    duration_s,
    summary,
    tasks,
  };
}

// ── GET /admin/harness/run ─────────────────────────────────────────────────
// SSE stream that runs all eligible tasks sequentially (one at a time) and
// emits progress events as each finishes. Mirrors the proven free-build
// pattern: sequential awaits inside an open SSE connection keep the Worker
// alive for the full run — no Queues, no waitUntil, no orphaning.
//
// Query param: ?business_slug=<slug>
// Events: harness_start | task_start | task_complete | task_failed | harness_complete
admin.get("/harness/run", async (c) => {
  const business_slug = c.req.query("business_slug");
  if (!business_slug) return c.json(errBody("bad_request", "business_slug required"), 400);

  const supabase = createSupabaseClient(c.env);

  // Look up by slug WITHOUT maybeSingle: slugs are unique per-user, not global,
  // so two users can both have an active 'victora'. maybeSingle() 500s on >1
  // row (PGRST116), which would take down the whole harness. Pick the most
  // recently created deterministically and warn loudly if there's a duplicate.
  const { data: bizRows, error: bizErr } = await supabase
    .from("businesses")
    .select("id, user_id, slug, name, kind, existing_business_url, existing_business_data, created_at")
    .eq("slug", business_slug)
    .eq("is_active", true)
    .order("created_at", { ascending: false });
  if (bizErr) return c.json(errBody("internal", "business_lookup_failed"), 500);
  if (!bizRows || bizRows.length === 0) return c.json(errBody("not_found", `business '${business_slug}' not found`), 404);
  if (bizRows.length > 1) {
    log.warn("[harness] duplicate_active_business_slug", {
      slug: business_slug,
      count: bizRows.length,
      ids: (bizRows as Array<{ id: string }>).map((b) => b.id),
      chosen: (bizRows[0] as { id: string }).id,
    });
  }
  const business = bizRows[0] as BusinessRow;

  const [{ data: promptRows, error: promptErr }, { data: allTaskRows, error: taskErr }] = await Promise.all([
    supabase.from("prompt_definitions").select("task_slug").eq("is_active", true),
    supabase.from("tasks").select(TASK_SELECT_COLUMNS).order("slug"),
  ]);
  if (promptErr) return c.json(errBody("internal", "prompt_lookup_failed"), 500);
  if (taskErr) return c.json(errBody("internal", "task_list_failed"), 500);

  const activePromptSlugs = new Set((promptRows ?? []).map((p: { task_slug: string }) => p.task_slug));
  const allTasks = (allTaskRows ?? []) as unknown as TaskRow[];
  const { eligibleTasks, notRun } = classifyTasksForHarness(allTasks, activePromptSlugs);

  const { data: harnessRow, error: harnessErr } = await supabase
    .from("harness_runs")
    .insert({ status: "running", business_id: business.id, task_count: eligibleTasks.length })
    .select("id, started_at")
    .single();
  if (harnessErr || !harnessRow) {
    log.error("[harness/run] harness_run_insert_failed", { err: harnessErr?.message });
    return c.json(errBody("internal", "harness_run_insert_failed"), 500);
  }
  const { id: harnessRunId } = harnessRow as { id: string; started_at: string };

  return streamSSE(c, async (stream) => {
    const emit = async (type: string, data: Record<string, unknown> = {}) => {
      await stream.writeSSE({ event: type, data: JSON.stringify({ type, ts: Date.now(), ...data }) });
    };

    type TaskResult = { slug: string; name: string; status: string; duration_s: number; error: string | null };
    const results: TaskResult[] = [];

    await emit("harness_start", {
      harness_run_id: harnessRunId,
      task_count: eligibleTasks.length,
      not_run_count: notRun.length,
    });

    for (const task of eligibleTasks) {
      // Create task_run row with correct started_at for this task's actual start time.
      const taskStarted = new Date().toISOString();
      const { data: runRow, error: insertErr } = await supabase
        .from("task_runs")
        .insert({
          user_id: business.user_id,
          business_id: business.id,
          task_id: task.id,
          status: "running",
          started_at: taskStarted,
          harness_run_id: harnessRunId,
          config: null,
          is_harness: true,
        })
        .select("id")
        .single();

      if (insertErr || !runRow) {
        await emit("task_failed", { slug: task.slug, name: task.name, duration_s: 0, error: "task_run_insert_failed" });
        results.push({ slug: task.slug, name: task.name, status: "failed", duration_s: 0, error: "task_run_insert_failed" });
        continue;
      }

      const taskRunId = (runRow as { id: string }).id;
      const taskStartMs = Date.now();
      await emit("task_start", { slug: task.slug, name: task.name, task_run_id: taskRunId });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60_000);

      try {
        await runTaskInBackground(c.env, business, task, business.user_id, taskRunId, controller.signal, true);

        const duration_s = Math.round((Date.now() - taskStartMs) / 1000);

        // runTaskInBackground writes the terminal status — read it back.
        const { data: finalRow } = await supabase
          .from("task_runs")
          .select("status, error, input_tokens, output_tokens")
          .eq("id", taskRunId)
          .maybeSingle();

        const finalStatus = (finalRow?.status as string) ?? "unknown";
        const finalError = (finalRow?.error as string | null) ?? null;
        const totalTokens = ((finalRow?.input_tokens as number | null) ?? 0) +
                            ((finalRow?.output_tokens as number | null) ?? 0);

        if (finalStatus === "completed") {
          await emit("task_complete", { slug: task.slug, name: task.name, task_run_id: taskRunId, duration_s, total_tokens: totalTokens || null });
          results.push({ slug: task.slug, name: task.name, status: "completed", duration_s, error: null });
        } else {
          await emit("task_failed", { slug: task.slug, name: task.name, task_run_id: taskRunId, duration_s, error: finalError });
          results.push({ slug: task.slug, name: task.name, status: "failed", duration_s, error: finalError });
        }
      } catch (err) {
        const duration_s = Math.round((Date.now() - taskStartMs) / 1000);
        const errMsg = err instanceof Error ? err.message : String(err);
        await emit("task_failed", { slug: task.slug, name: task.name, task_run_id: taskRunId, duration_s, error: errMsg });
        results.push({ slug: task.slug, name: task.name, status: "failed", duration_s, error: errMsg });
      } finally {
        clearTimeout(timeoutId);
      }
    }

    // Mark harness_run complete.
    await supabase
      .from("harness_runs")
      .update({ status: "complete", completed_at: new Date().toISOString() })
      .eq("id", harnessRunId);

    // Final summary sorted slowest-first.
    const sorted = [...results].sort((a, b) => b.duration_s - a.duration_s);
    await emit("harness_complete", {
      harness_run_id: harnessRunId,
      total: results.length,
      passed: results.filter(r => r.status === "completed").length,
      failed: results.filter(r => r.status === "failed").length,
      results: sorted,
    });

    log.info("[harness/run] complete", {
      harness_run_id: harnessRunId,
      business_slug,
      total: results.length,
      passed: results.filter(r => r.status === "completed").length,
      failed: results.filter(r => r.status === "failed").length,
    });
  });
});

// ── GET /admin/harness/current ─────────────────────────────────────────────
// Returns the most recent harness run + per-task statuses. Used on page load
// to show the last run without triggering a new one.
admin.get("/harness/current", async (c) => {
  const supabase = createSupabaseClient(c.env);

  const { data: run } = await supabase
    .from("harness_runs")
    .select("id, status, started_at, completed_at, task_count, business_id")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!run) return c.json({ run: null, tasks: [], summary: null });

  const data = await fetchHarnessRunStatus(supabase, (run as HarnessRunMeta).id, run as HarnessRunMeta);
  return c.json(data);
});

// ── GET /admin/harness/:run_id/status ──────────────────────────────────────
// Polling endpoint. Returns per-task statuses + run summary every 2-3s.
// Derives slow = status='running' AND started_at < now()-30s.
// Marks harness_run complete when all tasks reach a terminal status.
admin.get("/harness/:run_id/status", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const runId = c.req.param("run_id");

  const { data: run } = await supabase
    .from("harness_runs")
    .select("id, status, started_at, completed_at, task_count, business_id")
    .eq("id", runId)
    .maybeSingle();

  if (!run) return c.json(errBody("not_found", "harness run not found"), 404);

  const data = await fetchHarnessRunStatus(supabase, runId, run as HarnessRunMeta);
  return c.json(data);
});

// ── POST /admin/test-harness/run ──────────────────────────────────────────────
// Runs every eligible task once against a given business, polls for completion,
// returns a full accounting of every task in the catalog.
//
// Every task appears in the response — either in `results` (ran) or `not_run`
// (with an exact per-task disposition). The summary.catalog_total must equal
// results.length + not_run.length at all times.
//
// Dispositions for not_run tasks:
//   inactive_draft / inactive_deprecated — task not in production
//   excluded_system                      — kind=system, no user-facing LLM path
//   excluded_configured                  — output_type=configured, no LLM path
//   excluded_long_running                — legitimately runs >60s (300s watchdog tier)
//   skipped_no_prompt                    — active but no prompt_definitions row
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

  // 1. Fetch test business (admin path — no user_id scoping). Slugs are unique
  // per-user, not global, so >1 active row can share a slug — don't maybeSingle
  // (it 500s on PGRST116). Pick most-recent deterministically; warn on dupes.
  const { data: bizRows, error: bizErr } = await supabase
    .from("businesses")
    .select("id, user_id, slug, name, kind, existing_business_url, existing_business_data, created_at")
    .eq("slug", business_slug)
    .eq("is_active", true)
    .order("created_at", { ascending: false });
  if (bizErr) {
    log.error("[harness] business_lookup_failed", { business_slug, err: bizErr.message });
    return c.json(errBody("internal", "business_lookup_failed"), 500);
  }
  if (!bizRows || bizRows.length === 0) {
    return c.json(errBody("not_found", `business '${business_slug}' not found`), 404);
  }
  if (bizRows.length > 1) {
    log.warn("[harness] duplicate_active_business_slug", {
      slug: business_slug,
      count: bizRows.length,
      ids: (bizRows as Array<{ id: string }>).map((b) => b.id),
      chosen: (bizRows[0] as { id: string }).id,
    });
  }
  const business = bizRows[0] as BusinessRow;

  // 2. Fetch ALL tasks (every status) + active prompt slugs in parallel
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

  const { data: allTaskRows, error: taskErr } = await supabase
    .from("tasks")
    .select(TASK_SELECT_COLUMNS)
    .order("slug", { ascending: true });
  if (taskErr) {
    log.error("[harness] task_list_failed", { err: taskErr.message });
    return c.json(errBody("internal", "task_list_failed"), 500);
  }
  const allTasks = (allTaskRows ?? []) as unknown as TaskRow[];

  // 3. Classify every task into eligible (will run) or not_run (with exact reason)
  const { eligibleTasks, notRun } = classifyTasksForHarness(allTasks, activePromptSlugs);

  if (eligibleTasks.length === 0) {
    return c.json({
      harness_run_at: new Date().toISOString(),
      test_business: { slug: business.slug, name: business.name, id: business.id },
      summary: {
        catalog_total: allTasks.length,
        ran: 0, passed: 0, failed: 0,
        not_run: notRun.length,
      },
      not_run: notRun,
      results: [],
    });
  }

  // 4. Insert task_run rows and launch via waitUntil
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

  // 5. Poll for completion (max 90s, 3s intervals)
  // Apply inline 60s sweep at each tick since cron is disabled in test env.
  type RunRow = { id: string; status: string; started_at: string; completed_at: string | null; error: string | null };
  const pendingIds = new Set(launched.map((e) => e.run_id));
  const doneRows = new Map<string, RunRow>();
  const pollStart = Date.now();

  // Long-task IDs for the sweep exclusion (same set excluded from eligibility above)
  const { data: longTaskRowsForSweep } = await supabase
    .from("tasks")
    .select("id")
    .or("slug.like.generate-business-app%,slug.eq.public-business-website");
  const longTaskIdsForSweep = (longTaskRowsForSweep ?? []).map((r: { id: string }) => r.id);

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
    await (longTaskIdsForSweep.length > 0
      ? sweepQ.not("task_id", "in", `(${longTaskIdsForSweep.join(",")})`)
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

  // 6. Assemble results (tasks that ran)
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
    catalog_total: allTasks.length,
    ran: results.length,
    passed,
    failed,
    not_run: notRun.length,
  });

  return c.json({
    harness_run_at: new Date().toISOString(),
    test_business: { slug: business.slug, name: business.name, id: business.id },
    summary: {
      catalog_total: allTasks.length,
      ran: results.length,
      passed,
      failed,
      not_run: notRun.length,
      not_run_breakdown: {
        inactive: notRun.filter((r) => r.disposition.startsWith("inactive")).length,
        excluded: notRun.filter((r) => r.disposition.startsWith("excluded")).length,
        skipped_no_prompt: notRun.filter((r) => r.disposition === "skipped_no_prompt").length,
      },
    },
    not_run: notRun,
    results,
  });
});

// ── GET /admin/harness/runs ───────────────────────────────────────────────────
// List of harness runs (newest-first), each with pass/fail counts.
// Used by the per-day/per-run history page (view d).
admin.get("/harness/runs", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const limit = Math.min(parseInt(c.req.query("limit") ?? "100"), 500);

  const { data: runs, error: runsErr } = await supabase
    .from("harness_runs")
    .select("id, status, started_at, completed_at, task_count, business_id")
    .order("started_at", { ascending: false })
    .limit(limit);

  if (runsErr) return c.json(errBody("internal", "harness_runs_fetch_failed"), 500);

  const runIds = (runs ?? []).map((r: { id: string }) => r.id);
  let statsMap: Record<string, { passed: number; failed: number }> = {};

  if (runIds.length > 0) {
    const { data: taskRows } = await supabase
      .from("task_runs")
      .select("harness_run_id, status")
      .in("harness_run_id", runIds);

    for (const row of (taskRows ?? []) as { harness_run_id: string; status: string }[]) {
      const s = statsMap[row.harness_run_id] ?? { passed: 0, failed: 0 };
      if (row.status === "completed") s.passed++;
      else if (row.status === "failed") s.failed++;
      statsMap[row.harness_run_id] = s;
    }
  }

  const result = (runs ?? []).map((r: { id: string; status: string; started_at: string; completed_at: string | null; task_count: number; business_id: string }) => {
    const s = statsMap[r.id] ?? { passed: 0, failed: 0 };
    const startMs = r.started_at ? new Date(r.started_at).getTime() : null;
    const endMs = r.completed_at ? new Date(r.completed_at).getTime() : null;
    return {
      id: r.id,
      status: r.status,
      started_at: r.started_at,
      completed_at: r.completed_at,
      task_count: r.task_count,
      business_id: r.business_id,
      passed: s.passed,
      failed: s.failed,
      duration_s: startMs && endMs ? Math.round((endMs - startMs) / 1000) : null,
    };
  });

  return c.json({ runs: result });
});

// ── GET /admin/harness/runs/:run_id/tasks ─────────────────────────────────────
// All task_runs for a specific harness run, sorted slowest-first.
// Used by the all-tasks comparison page (view c).
admin.get("/harness/runs/:run_id/tasks", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const runId = c.req.param("run_id");

  const [{ data: run }, { data: tasks, error: tasksErr }] = await Promise.all([
    supabase
      .from("harness_runs")
      .select("id, status, started_at, completed_at, task_count, business_id")
      .eq("id", runId)
      .maybeSingle(),
    supabase
      .from("task_runs")
      .select("id, status, started_at, completed_at, error, model, output_data, tasks!inner(slug, name)")
      .eq("harness_run_id", runId)
      .order("started_at"),
  ]);

  if (!run) return c.json(errBody("not_found", "harness run not found"), 404);
  if (tasksErr) return c.json(errBody("internal", "task_runs_fetch_failed"), 500);

  type TaskRunRow = { id: string; status: string; started_at: string; completed_at: string | null; error: string | null; model: string | null; output_data: unknown; tasks: { slug: string; name: string } };
  const mapped = ((tasks ?? []) as unknown as TaskRunRow[]).map((t) => {
    const startMs = t.started_at ? new Date(t.started_at).getTime() : null;
    const endMs = t.completed_at ? new Date(t.completed_at).getTime() : null;
    return {
      task_run_id: t.id,
      slug: t.tasks.slug,
      name: t.tasks.name,
      status: t.status,
      started_at: t.started_at,
      completed_at: t.completed_at,
      duration_s: startMs && endMs ? Math.round((endMs - startMs) / 1000) : null,
      model: t.model,
      error: t.error,
      has_output: !!t.output_data,
    };
  });

  // Sort slowest-first (nulls last)
  mapped.sort((a, b) => {
    if (a.duration_s == null && b.duration_s == null) return 0;
    if (a.duration_s == null) return 1;
    if (b.duration_s == null) return -1;
    return b.duration_s - a.duration_s;
  });

  const runRow = run as { id: string; status: string; started_at: string; completed_at: string | null; task_count: number; business_id: string };
  const startMs = runRow.started_at ? new Date(runRow.started_at).getTime() : null;
  const endMs = runRow.completed_at ? new Date(runRow.completed_at).getTime() : null;

  return c.json({
    run: {
      ...runRow,
      duration_s: startMs && endMs ? Math.round((endMs - startMs) / 1000) : null,
      passed: mapped.filter(t => t.status === "completed").length,
      failed: mapped.filter(t => t.status === "failed").length,
    },
    tasks: mapped,
  });
});

// ── GET /admin/harness/tasks ──────────────────────────────────────────────────
// All task slugs/names that have at least one run (harness or user), with run count.
// Used to populate the task picker on the per-task history page (view b).
admin.get("/harness/tasks", async (c) => {
  const supabase = createSupabaseClient(c.env);

  const { data: rows, error } = await supabase
    .from("task_runs")
    .select("task_id, tasks!inner(slug, name)")
    .order("task_id");

  if (error) return c.json(errBody("internal", "harness_tasks_fetch_failed"), 500);

  type Row = { task_id: string; tasks: { slug: string; name: string } };
  const countMap: Record<string, { slug: string; name: string; run_count: number }> = {};
  for (const r of (rows ?? []) as unknown as Row[]) {
    const key = r.tasks.slug;
    if (!countMap[key]) countMap[key] = { slug: r.tasks.slug, name: r.tasks.name, run_count: 0 };
    countMap[key].run_count++;
  }

  const tasks = Object.values(countMap).sort((a, b) => a.name.localeCompare(b.name));
  return c.json({ tasks });
});

// ── GET /admin/harness/tasks/:slug/history ────────────────────────────────────
// All runs (harness + user) of a specific task, newest-first.
// Used by the per-task history page (view b).
admin.get("/harness/tasks/:slug/history", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const slug = c.req.param("slug");

  const { data: rows, error } = await supabase
    .from("task_runs")
    .select("id, status, started_at, completed_at, error, model, harness_run_id, is_harness, tasks!inner(slug, name)")
    .eq("tasks.slug", slug)
    .order("started_at", { ascending: false })
    .limit(200);

  if (error) return c.json(errBody("internal", "task_history_fetch_failed"), 500);

  type Row = { id: string; status: string; started_at: string; completed_at: string | null; error: string | null; model: string | null; harness_run_id: string; is_harness: boolean; tasks: { slug: string; name: string } };
  const typed = (rows ?? []) as unknown as Row[];

  if (typed.length === 0) return c.json(errBody("not_found", `no runs found for task '${slug}'`), 404);

  const taskName = typed[0].tasks.name;
  const mapped = typed.map((r) => {
    const startMs = r.started_at ? new Date(r.started_at).getTime() : null;
    const endMs = r.completed_at ? new Date(r.completed_at).getTime() : null;
    return {
      task_run_id: r.id,
      harness_run_id: r.harness_run_id,
      is_harness: r.is_harness,
      status: r.status,
      started_at: r.started_at,
      completed_at: r.completed_at,
      duration_s: startMs && endMs ? Math.round((endMs - startMs) / 1000) : null,
      model: r.model,
      error: r.error,
    };
  });

  return c.json({ slug, name: taskName, runs: mapped });
});

// ── GET /admin/harness/task-runs/:id/output ───────────────────────────────────
// Returns output_data for any task_run (harness or user).
// Used by the output viewer (view e) — reads task_runs.output_data directly.
admin.get("/harness/task-runs/:id/output", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const id = c.req.param("id");

  const { data: row, error } = await supabase
    .from("task_runs")
    .select("id, status, output_data, error, tasks!inner(slug, name)")
    .eq("id", id)
    .maybeSingle();

  if (error) return c.json(errBody("internal", "output_fetch_failed"), 500);
  if (!row) return c.json(errBody("not_found", "task run not found"), 404);

  type Row = { id: string; status: string; output_data: unknown; error: string | null; tasks: { slug: string; name: string } };
  const typed = row as unknown as Row;

  return c.json({
    task_run_id: typed.id,
    slug: typed.tasks.slug,
    name: typed.tasks.name,
    status: typed.status,
    error: typed.error,
    output_data: typed.output_data ?? null,
  });
});

// ── GET /admin/platforms ──────────────────────────────────────────────────────
// Returns ALL platforms including inactive (admin needs to see and re-activate).
admin.get("/platforms", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const { data, error } = await supabase
    .from("platforms")
    .select("id, slug, display_name, char_limit, hashtag_limit, constraints, is_active, sort_order, recommended_cadence, cadence_reason, cadence_updated_at, updated_at")
    .order("sort_order", { ascending: true });
  if (error) {
    log.error("[admin] platforms_fetch_failed", { err: error.message });
    return c.json(errBody("internal", "platforms_fetch_failed"), 500);
  }
  return c.json({ platforms: data ?? [] });
});

// ── POST /admin/platforms ─────────────────────────────────────────────────────
admin.post("/platforms", async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json(errBody("bad_request", "invalid json"), 400); }

  const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
  const display_name = typeof body.display_name === "string" ? body.display_name.trim() : "";
  if (!slug || !display_name) return c.json(errBody("bad_request", "slug and display_name required"), 400);

  const supabase = createSupabaseClient(c.env);
  const { data, error } = await supabase
    .from("platforms")
    .insert({
      slug,
      display_name,
      char_limit:    typeof body.char_limit    === "number" ? body.char_limit    : null,
      hashtag_limit: typeof body.hashtag_limit === "number" ? body.hashtag_limit : null,
      constraints:   typeof body.constraints   === "object" && body.constraints !== null ? body.constraints : {},
      is_active:     body.is_active !== false,
      sort_order:    typeof body.sort_order === "number" ? body.sort_order : 0,
      recommended_cadence: typeof body.recommended_cadence === "string" ? body.recommended_cadence.trim() || null : null,
      cadence_reason:      typeof body.cadence_reason      === "string" ? body.cadence_reason.trim()      || null : null,
    })
    .select("id, slug, display_name, char_limit, hashtag_limit, constraints, is_active, sort_order, recommended_cadence, cadence_reason, cadence_updated_at")
    .single();

  if (error) {
    log.error("[admin] platform_create_failed", { slug, err: error.message });
    return c.json(errBody("internal", error.message), error.code === "23505" ? 409 : 500);
  }
  log.info("[admin] platform_created", { slug });
  return c.json({ platform: data }, 201);
});

// ── PATCH /admin/platforms/:id ────────────────────────────────────────────────
admin.patch("/platforms/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json(errBody("bad_request", "invalid json"), 400); }

  const patch: Record<string, unknown> = {};
  if (typeof body.display_name  === "string")  patch.display_name  = body.display_name.trim();
  if (typeof body.char_limit    === "number")   patch.char_limit    = body.char_limit;
  if (body.char_limit           === null)       patch.char_limit    = null;
  if (typeof body.hashtag_limit === "number")   patch.hashtag_limit = body.hashtag_limit;
  if (body.hashtag_limit        === null)       patch.hashtag_limit = null;
  if (typeof body.is_active     === "boolean")  patch.is_active     = body.is_active;
  if (typeof body.sort_order    === "number")   patch.sort_order    = body.sort_order;
  if (typeof body.constraints   === "object" && body.constraints !== null) patch.constraints = body.constraints;
  if (typeof body.recommended_cadence === "string") patch.recommended_cadence = body.recommended_cadence.trim() || null;
  if (body.recommended_cadence        === null)     patch.recommended_cadence = null;
  if (typeof body.cadence_reason      === "string") patch.cadence_reason      = body.cadence_reason.trim()      || null;
  if (body.cadence_reason             === null)     patch.cadence_reason      = null;
  if ("recommended_cadence" in patch || "cadence_reason" in patch) {
    patch.cadence_updated_at = new Date().toISOString();
  }

  if (Object.keys(patch).length === 0) return c.json(errBody("bad_request", "no patchable fields"), 400);

  const supabase = createSupabaseClient(c.env);
  const { data, error } = await supabase
    .from("platforms")
    .update(patch)
    .eq("id", id)
    .select("id, slug, display_name, char_limit, hashtag_limit, constraints, is_active, sort_order, recommended_cadence, cadence_reason, cadence_updated_at")
    .single();

  if (error) {
    log.error("[admin] platform_update_failed", { id, err: error.message });
    return c.json(errBody("internal", error.message), 500);
  }
  if (!data) return c.json(errBody("not_found", "platform not found"), 404);

  log.info("[admin] platform_updated", { id, patch: Object.keys(patch) });
  return c.json({ platform: data });
});

// ── Integration providers (Phase 3A part A) ───────────────────────────────
//
// THE REGISTRY IS DATA. Rob defines a provider here and an operator can
// configure it immediately — no deploy, no code change, no new renderer. That is
// the whole point: the Worker knows how to compose a template, not what Housecall
// Pro is.
//
// Admin-only, because embed_template is the one place markup is written. An
// operator never reaches this surface; they supply values against the fields
// defined here and nothing else.
admin.use("/integration-providers", requireAdmin);
admin.use("/integration-providers/*", requireAdmin);

const ProviderFieldBody = z.object({
  key: z.string(),
  label: z.string(),
  help: z.string().nullable().optional(),
  // Presence is checked here; the real rules (anchored, compilable, bounded)
  // live in validateProviderDefinition so the route and the renderer cannot
  // disagree about what a valid field is.
  pattern: z.string(),
  required: z.boolean().optional(),
  placeholder: z.string().nullable().optional(),
});

const ProviderBody = z.object({
  provider_key: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "provider_key must be kebab-case"),
  display_name: z.string().trim().min(1),
  category: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "category must be kebab-case"),
  embed_template: z.string().trim().min(1),
  placement: z.enum(["head", "body_end", "inline_mount"]).default("body_end"),
  fields: z.array(ProviderFieldBody).default([]),
  position: z.enum(["bottom-right", "bottom-left", "top-right", "top-left", "fullscreen"])
    .nullable().optional().transform((v) => v ?? null),
  requires_consent: z.boolean().default(false),
  provider_domains: z.array(z.string().trim().min(1)).default([]),
  docs_url: z.string().trim().nullable().optional().transform((v) => v ?? null),
  active: z.boolean().default(true),
});

admin.get("/integration-providers", async (c) => {
  const supabase = createSupabaseClient(c.env);
  // Inactive included: this is the definition surface, and a retired provider
  // still has to be visible to be un-retired.
  const providers = await loadProviders(supabase, { includeInactive: true });
  return c.json({ providers, placements: PLACEMENTS, positions: POSITIONS });
});

admin.put("/integration-providers/:provider_key", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const key = c.req.param("provider_key");

  let body: z.infer<typeof ProviderBody>;
  try {
    body = ProviderBody.parse({ ...(await c.req.json()), provider_key: key });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json(errBody("bad_request", "provider_invalid",
        err.issues.map((i) => ({ field: i.path.join("."), message: i.message }))), 400);
    }
    return c.json(errBody("bad_request", "body must be valid JSON"), 400);
  }

  // The rules that make the values-only guarantee hold: every field carries an
  // anchored, compilable pattern, no template placeholder is undefined, and the
  // template uses no raw-output construct. A provider that fails these would
  // render an operator's value unescaped onto a public site.
  let fields;
  try {
    fields = validateProviderDefinition(body);
  } catch (err) {
    if (err instanceof ProviderDefinitionError) {
      return c.json(errBody("bad_request", err.message), 400);
    }
    throw err;
  }

  const { data, error } = await supabase
    .from("site_integration_providers")
    .upsert({ ...body, fields, updated_at: new Date().toISOString() },
      { onConflict: "provider_key" })
    .select("provider_key")
    .single();
  if (error) {
    log.error("[admin] provider_upsert_failed", { provider_key: key, err: error.message });
    return c.json(errBody("internal", `provider_upsert_failed: ${error.message}`), 500);
  }
  log.info("[admin] provider_saved", { provider_key: key, fields: fields.length });
  return c.json({ ok: true, provider_key: (data as { provider_key: string }).provider_key });
});

// Retire rather than delete. A provider row is referenced by every site using
// it (ON DELETE RESTRICT), so removing one would either fail or take working
// widgets off client sites; `active:false` hides it from the picker and leaves
// existing installs alone.
admin.post("/integration-providers/:provider_key/retire", async (c) => {
  const supabase = createSupabaseClient(c.env);
  const key = c.req.param("provider_key");
  const { error } = await supabase
    .from("site_integration_providers")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("provider_key", key);
  if (error) return c.json(errBody("internal", `provider_retire_failed: ${error.message}`), 500);

  const { count } = await supabase
    .from("site_integrations")
    .select("id", { count: "exact", head: true })
    .eq("provider", key).eq("is_active", true);
  log.info("[admin] provider_retired", { provider_key: key, still_installed: count ?? 0 });
  return c.json({ ok: true, provider_key: key, still_installed_on_sites: count ?? 0 });
});

export default admin;
