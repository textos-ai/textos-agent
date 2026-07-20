import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import {
  createSupabaseClient,
  getBusinessesByUser,
  getBusinessBySlug,
  getBusinessContext,
  upsertBusinessContext,
  getAllActiveTasks,
  getTaskRunsForBusiness,
  countUserBusinesses,
  createBusiness,
  createEmptyBusinessContext,
  setAgentName,
  type TaskRow,
  type TaskRunRow,
} from "../services/supabase";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";
import { pickAgentName } from "../lib/agentNames";
import { createAnthropicClient } from "../services/anthropic";
import { loadModelConfig } from "../lib/model-config";
import {
  CONTEXT_FIELD_SHAPES,
  validateField,
  extractFromText,
  flattenAssetData,
  pickStructured,
} from "../lib/context-rebuild";

const app = new Hono<{ Bindings: Env }>();
app.use("*", requireAuth);

// ── GET / ─────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  const auth = c.get("auth");
  const supabase = createSupabaseClient(c.env);

  try {
    const businesses = await getBusinessesByUser(supabase, auth.user_id);
    return c.json({ businesses });
  } catch (err) {
    log.error("get_businesses_failed", { err: String(err) });
    return c.json(errBody("upstream_error", String(err)), 502);
  }
});

// ── Add-business gate ────────────────────────────────────────────────────────
// ONE rule, shared by GET /can-add (client UX) and POST / (enforcement):
//   admin (users.is_admin)        → unlimited
//   else 1st business (count 0)   → free
//   else active/trialing sub      → allowed
//   else                          → needs a subscription
// Subscriptions are per-business; "is a subscriber" = has ≥1 active/trialing
// business_subscriptions row. Nothing hardcoded — reads users + subs live.
async function evaluateAddBusiness(
  supabase: ReturnType<typeof createSupabaseClient>,
  userId: string,
): Promise<{ allowed: boolean; reason: "admin" | "first_free" | "subscribed" | "needs_subscription"; isAdmin: boolean; isSubscriber: boolean; businessCount: number }> {
  const [userRes, businessCount, subRes] = await Promise.all([
    supabase.from("users").select("is_admin").eq("id", userId).maybeSingle(),
    countUserBusinesses(supabase, userId),
    supabase
      .from("business_subscriptions")
      .select("status")
      .eq("user_id", userId)
      .in("status", ["active", "trialing"])
      .limit(1),
  ]);
  const isAdmin = !!(userRes.data as { is_admin?: boolean } | null)?.is_admin;
  const isSubscriber = Array.isArray(subRes.data) && subRes.data.length > 0;
  let allowed: boolean;
  let reason: "admin" | "first_free" | "subscribed" | "needs_subscription";
  if (isAdmin) { allowed = true; reason = "admin"; }
  else if (businessCount === 0) { allowed = true; reason = "first_free"; }
  else if (isSubscriber) { allowed = true; reason = "subscribed"; }
  else { allowed = false; reason = "needs_subscription"; }
  return { allowed, reason, isAdmin, isSubscriber, businessCount };
}

// ── GET /can-add ─────────────────────────────────────────────────────────────
// Frontend uses this to decide: route to /start (allowed) vs show the paywall
// modal (needs_subscription). Registered before /:slug so it isn't read as a slug.
app.get("/can-add", async (c) => {
  const auth = c.get("auth");
  const supabase = createSupabaseClient(c.env);
  try {
    return c.json(await evaluateAddBusiness(supabase, auth.user_id));
  } catch (err) {
    log.error("can_add_business_check_failed", { err: String(err) });
    return c.json(errBody("upstream_error", String(err)), 502);
  }
});

// ── GET /:slug ─────────────────────────────────────────────────────────
// NOTE: this must come BEFORE /:slug/tasks or Hono will treat "tasks" as a slug param.
// Hono matches routes in registration order, so /:slug/tasks registered first wins.
app.get("/:slug/tasks", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  let business;
  try {
    business = await getBusinessBySlug(supabase, auth.user_id, slug);
  } catch (err) {
    log.error("get_business_for_tasks_failed", { err: String(err), slug });
    return c.json(errBody("upstream_error", String(err)), 502);
  }

  if (!business) {
    return c.json(errBody("not_found", `business '${slug}' not found`), 404);
  }

  let tasks: TaskRow[] = [];
  let runs: TaskRunRow[] = [];
  try {
    [tasks, runs] = await Promise.all([
      getAllActiveTasks(supabase),
      getTaskRunsForBusiness(supabase, business.id),
    ]);
  } catch (err) {
    log.error("get_tasks_failed", { err: String(err), slug });
    return c.json(errBody("upstream_error", String(err)), 502);
  }

  // Index latest run by task_id (runs already ordered desc by started_at)
  const runByTask = new Map<string, TaskRunRow>();
  for (const run of runs) {
    if (!runByTask.has(run.task_id)) {
      runByTask.set(run.task_id, run);
    }
  }

  const planOrder: Record<string, number> = {
    free: 0,
    core_paid: 1,
    premium_only: 2,
    premium_inactive: 3,
  };

  const sorted = [...tasks].sort((a, b) => {
    if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
    const pa = planOrder[a.plan_required] ?? 9;
    const pb = planOrder[b.plan_required] ?? 9;
    if (pa !== pb) return pa - pb;
    return a.area.localeCompare(b.area);
  });

  const taskList = sorted.map((task) => {
    const run = runByTask.get(task.id);
    let status: string;

    if (run) {
      status = run.status;
    } else if (task.plan_required === "free") {
      status = "queued";
    } else if (task.plan_required === "core_paid") {
      status = "locked";
    } else {
      status = "premium";
    }

    return {
      id: task.id,
      slug: task.slug,
      name: task.name,
      description_short: task.description_short,
      description_long: task.description_long,
      area: task.area,
      plan_required: task.plan_required,
      visibility: task.visibility,
      price_cents: task.price_cents,
      token_cost: task.token_cost,
      // Redacted — frontend only needs existence
      has_prompt_template:
        typeof task.prompt_template === "string" &&
        task.prompt_template.trim() !== "",
      output_type: task.output_type,
      is_default: task.is_default,
      kind: task.kind,
      config_page_path: task.config_page_path,
      lifecycle_phase_id: task.lifecycle_phase_id,
      is_regeneratable: task.is_regeneratable,
      asset_user_editable: task.asset_user_editable,
      text_controllable: task.text_controllable,
      progress_verb: task.progress_verb ?? null,
      status,
      started_at: run?.started_at ?? null,
      completed_at: run?.completed_at ?? null,
      eta_seconds: run?.status === "running" ? 240 : null,
      output_summary:
        run?.status === "completed" && run.output_data
          ? extractOutputSummary(task.slug, run.output_data)
          : null,
      output_data: run?.output_data ?? null,
    };
  });

  // Free-build status — the frontend gates paid tile buttons on this (D3).
  // The list of free-build slugs is sourced from the DB at request time
  // (tasks WHERE is_default=true AND status='active'). No hardcoded list.
  const freeBuildSlugs = tasks
    .filter((t) => t.is_default === true && t.status === "active")
    .map((t) => t.slug);
  const freeBuildTasks = taskList.filter((t) => freeBuildSlugs.includes(t.slug));
  const free_build_complete =
    freeBuildSlugs.length > 0 &&
    freeBuildTasks.length === freeBuildSlugs.length &&
    freeBuildTasks.every((t) => t.status === "completed");
  const free_build_running_task =
    freeBuildTasks.find((t) => t.status === "running")?.slug ?? null;

  return c.json({
    tasks: taskList,
    free_build_complete,
    free_build_running_task,
  });
});

app.get("/:slug", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  let business;
  try {
    business = await getBusinessBySlug(supabase, auth.user_id, slug);
  } catch (err) {
    log.error("get_business_failed", { err: String(err), slug });
    return c.json(errBody("upstream_error", String(err)), 502);
  }

  if (!business) {
    return c.json(errBody("not_found", `business '${slug}' not found`), 404);
  }

  let context = null;
  try {
    context = await getBusinessContext(supabase, business.id);
  } catch (err) {
    log.warn("get_business_context_failed", {
      err: String(err),
      business_id: business.id,
    });
  }

  return c.json({
    business,
    context,
    agent_name: context?.agent_name ?? null,
  });
});

// ── PATCH /:slug/agent-name ────────────────────────────────────────────
const AgentNameBody = z.object({
  agent_name: z
    .string()
    .min(1)
    .max(30)
    .regex(/^[\w\s']+$/, "agent name may only contain letters, numbers, spaces, underscores, apostrophes"),
});

app.patch("/:slug/agent-name", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  let parsed;
  try {
    parsed = AgentNameBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", err instanceof Error ? err.message : err), 400);
  }

  let business;
  try {
    business = await getBusinessBySlug(supabase, auth.user_id, slug);
  } catch (err) {
    return c.json(errBody("upstream_error", String(err)), 502);
  }
  if (!business) return c.json(errBody("not_found", `business '${slug}' not found`), 404);

  try {
    await setAgentName(supabase, business.id, parsed.agent_name.trim());
  } catch (err) {
    return c.json(errBody("upstream_error", String(err)), 502);
  }

  return c.json({ agent_name: parsed.agent_name.trim() });
});

// ── PATCH /:slug/profile ──────────────────────────────────────────────
// Whitelist-only update of safe businesses.* display/identity columns.
// Does NOT touch business_context fields, system columns, or IDs.
const PatchBusinessProfileBody = z.object({
  name: z.string().min(1).max(200).optional(),
  existing_business_url: z.string().max(2000).nullable().optional(),
});

app.patch("/:slug/profile", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  let parsed: z.infer<typeof PatchBusinessProfileBody>;
  try {
    parsed = PatchBusinessProfileBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", err instanceof Error ? err.message : err), 400);
  }

  // Strip HTML tags and normalise whitespace on name (safety for identity anchor)
  const cleanName = parsed.name !== undefined
    ? parsed.name.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()
    : undefined;
  if (cleanName !== undefined && !cleanName) {
    return c.json(errBody("bad_request", "name cannot be empty after stripping whitespace"), 400);
  }

  let business;
  try {
    business = await getBusinessBySlug(supabase, auth.user_id, slug);
  } catch (err) {
    return c.json(errBody("upstream_error", String(err)), 502);
  }
  if (!business) return c.json(errBody("not_found", `business '${slug}' not found`), 404);

  const updates: Record<string, unknown> = {};
  if (cleanName !== undefined) updates.name = cleanName;
  if (parsed.existing_business_url !== undefined) {
    updates.existing_business_url = parsed.existing_business_url?.trim() || null;
  }

  if (Object.keys(updates).length === 0) {
    return c.json(errBody("bad_request", "no fields provided to update"), 400);
  }

  const { error } = await supabase
    .from("businesses")
    .update(updates)
    .eq("id", business.id);

  if (error) {
    log.error("patch_business_profile_failed", { err: error.message, business_id: business.id });
    return c.json(errBody("upstream_error", error.message), 502);
  }

  log.info("[businesses] profile_updated", { business_id: business.id, fields: Object.keys(updates) });
  return c.json({ ok: true, ...updates });
});

// ── POST / ────────────────────────────────────────────────────────────
const CreateBusinessBody = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(2)
    .max(80)
    .regex(
      /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]{2}$/,
      "slug must be lowercase alphanumeric and hyphens, start and end with alphanumeric",
    ),
  kind: z.enum(["new_idea", "find_for_me", "existing"]),
  existing_business_url: z.string().url().optional(),
  existing_business_data: z.record(z.unknown()).optional(),
});

app.post("/", async (c) => {
  let parsed;
  try {
    parsed = CreateBusinessBody.parse(await c.req.json());
  } catch (err) {
    log.warn("businesses_validation_failed", {
      error: err instanceof z.ZodError ? err.format() : String(err),
    });
    return c.json(
      errBody("bad_request", "invalid request body", err instanceof Error ? err.message : err),
      400,
    );
  }

  const auth = c.get("auth");
  const supabase = createSupabaseClient(c.env);

  // Gate: 1st business free, admins unlimited, otherwise a subscription is
  // required to add more than one. Same rule as GET /can-add.
  let gate;
  try {
    gate = await evaluateAddBusiness(supabase, auth.user_id);
  } catch (err) {
    log.error("quota_check_failed", { err: String(err) });
    return c.json(errBody("upstream_error", String(err)), 502);
  }
  if (!gate.allowed) {
    return c.json(
      errBody(
        "subscription_required",
        "Adding more than one business requires a monthly subscription.",
      ),
      402,
    );
  }

  let business;
  try {
    business = await createBusiness(supabase, {
      user_id: auth.user_id,
      slug: parsed.slug,
      name: parsed.name,
      kind: parsed.kind,
      ...(parsed.existing_business_url && {
        existing_business_url: parsed.existing_business_url,
      }),
      ...(parsed.existing_business_data && {
        existing_business_data: parsed.existing_business_data,
      }),
    });
  } catch (err) {
    // Supabase/PostgREST throws a STRUCTURED error object ({ code, message,
    // details, hint }), not an Error. String(err) on it yields "[object Object]",
    // which both hid the real message AND broke duplicate detection below (so a
    // (user_id, slug) collision fell through to a 502 instead of a 409).
    const e = err as { code?: string; message?: string };
    const msg = e?.message ?? (err instanceof Error ? err.message : String(err));
    const isDuplicate =
      e?.code === "23505" ||
      msg.toLowerCase().includes("duplicate") ||
      msg.includes("23505");
    if (isDuplicate) {
      // Per-account uniqueness is on (user_id, slug), so the submitted slug IS
      // the existing business's slug — hand it back so the client can link to it.
      return c.json(
        errBody(
          "conflict",
          `You already have a business for '${parsed.slug}'.`,
          { slug: parsed.slug },
        ),
        409,
      );
    }
    log.error("create_business_failed", { err: msg });
    return c.json(errBody("upstream_error", msg), 502);
  }

  const agentName = await pickAgentName(supabase, auth.user_id);
  try {
    await createEmptyBusinessContext(supabase, business.id, auth.user_id, agentName);
  } catch (err) {
    console.error("[business-create] context creation FAILED:", err);
    log.warn("create_empty_context_failed", {
      err: String(err),
      business_id: business.id,
    });
    // Non-fatal — orchestrator will seed agent_name if context row is missing
  }

  const context = await getBusinessContext(supabase, business.id).catch(
    () => null,
  );

  return c.json({ business, context, agent_name: agentName }, 201);
});

// ── GET /:slug/tasks/:taskId ───────────────────────────────────────────────
// Task detail: state, timestamps, work_log, and linked business_assets.
// NOTE: must be registered before /:slug or Hono will treat taskId as a slug.
app.get("/:slug/tasks/:taskId", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const taskId = c.req.param("taskId");
  const supabase = createSupabaseClient(c.env);

  let business;
  try {
    business = await getBusinessBySlug(supabase, auth.user_id, slug);
  } catch (err) {
    return c.json(errBody("upstream_error", String(err)), 502);
  }
  if (!business) {
    return c.json(errBody("not_found", `business '${slug}' not found`), 404);
  }

  const { data: run, error } = await supabase
    .from("task_runs")
    .select(
      "id, task_id, status, state, proposed_at, started_at, completed_at, failed_at, work_log, error",
    )
    .eq("id", taskId)
    .eq("business_id", business.id)
    .maybeSingle();

  if (error) {
    log.error("get_task_run_failed", { err: error.message, taskId });
    return c.json(errBody("upstream_error", error.message), 502);
  }
  if (!run) {
    return c.json(errBody("not_found", `task run '${taskId}' not found`), 404);
  }

  // Fetch linked business_assets
  const { data: assets } = await supabase
    .from("business_assets")
    .select("id, asset_type, asset_subtype, asset_url, asset_text, created_at")
    .eq("task_run_id", taskId)
    .order("created_at", { ascending: true });

  return c.json({ task: { ...run, assets: assets ?? [] } });
});

// ── Helpers — document asset normalization ────────────────────────────────
// Lock state is stored in metadata JSONB (is_locked, locked_at) rather than
// dedicated columns — no migration needed; metadata already exists on the table.
function docAssetMeta(raw: { metadata?: Record<string, unknown> | null }) {
  const m = raw.metadata ?? {};
  return {
    is_locked: m.is_locked === true,
    locked_at: typeof m.locked_at === "string" ? m.locked_at : null,
  };
}

function prettySubtype(subtype: string | null): string {
  if (!subtype) return "Document";
  return subtype
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function normalizeDocAsset(row: {
  id: string;
  task_run_id: string | null;
  asset_text: string | null;
  asset_subtype?: string | null;
  asset_data?: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}) {
  const { is_locked, locked_at } = docAssetMeta(row);
  // Title for pickers/lists: prefer the document's own title (asset_data.title),
  // fall back to a humanized subtype (the task slug that produced it).
  const dataTitle = typeof row.asset_data?.title === "string" ? (row.asset_data.title as string).trim() : "";
  const title = dataTitle || prettySubtype(row.asset_subtype ?? null);
  return {
    id: row.id,
    task_run_id: row.task_run_id,
    asset_text: row.asset_text,
    asset_subtype: row.asset_subtype ?? null,
    title,
    is_locked,
    locked_at,
  };
}

// ── GET /:slug/document-assets ────────────────────────────────────────────
// Returns all business_assets of type 'document' for the business.
// Lock/edit state is stored in metadata JSONB (no extra columns needed).
app.get("/:slug/document-assets", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  let business;
  try {
    business = await getBusinessBySlug(supabase, auth.user_id, slug);
  } catch (err) {
    return c.json(errBody("upstream_error", String(err)), 502);
  }
  if (!business) return c.json(errBody("not_found", `business '${slug}' not found`), 404);

  const { data: rows, error } = await supabase
    .from("business_assets")
    .select("id, task_run_id, asset_text, asset_subtype, asset_data, metadata")
    .eq("business_id", business.id)
    .eq("asset_type", "document")
    .order("created_at", { ascending: true });

  if (error) {
    log.error("get_document_assets_failed", { err: error.message, business_id: business.id });
    return c.json(errBody("upstream_error", error.message), 502);
  }
  return c.json({ assets: (rows ?? []).map(normalizeDocAsset) });
});

// ── GET /:slug/brand-assets ───────────────────────────────────────────────
// Returns logo and website type assets for the Overview page.
// Ordered newest-first so the overview picks up the latest generated version.
app.get("/:slug/brand-assets", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  let business;
  try {
    business = await getBusinessBySlug(supabase, auth.user_id, slug);
  } catch (err) {
    return c.json(errBody("upstream_error", String(err)), 502);
  }
  if (!business) return c.json(errBody("not_found", `business '${slug}' not found`), 404);

  const { data: rows, error } = await supabase
    .from("business_assets")
    .select("id, asset_type, asset_url, task_run_id, created_at")
    .eq("business_id", business.id)
    .in("asset_type", ["logo", "website"])
    .order("created_at", { ascending: false });

  if (error) {
    log.error("get_brand_assets_failed", { err: error.message, business_id: business.id });
    return c.json(errBody("upstream_error", error.message), 502);
  }
  return c.json({ assets: rows ?? [] });
});

// ── GET /:slug/assets ─────────────────────────────────────────────────────
// Returns ALL business_assets for the business (all types) for the Asset Editor.
// Lock state is normalised from metadata JSONB (same convention as document-assets).
app.get("/:slug/assets", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  let business;
  try {
    business = await getBusinessBySlug(supabase, auth.user_id, slug);
  } catch (err) {
    return c.json(errBody("upstream_error", String(err)), 502);
  }
  if (!business) return c.json(errBody("not_found", `business '${slug}' not found`), 404);

  const { data: rows, error } = await supabase
    .from("business_assets")
    .select("id, asset_type, asset_subtype, asset_url, asset_text, task_run_id, is_current, metadata, created_at")
    .eq("business_id", business.id)
    .order("created_at", { ascending: false });

  if (error) {
    log.error("get_all_assets_failed", { err: error.message, business_id: business.id });
    return c.json(errBody("upstream_error", error.message), 502);
  }

  return c.json({
    assets: (rows ?? []).map((row) => {
      const meta = (row.metadata as Record<string, unknown>) ?? {};
      return {
        id: row.id,
        asset_type: row.asset_type,
        asset_subtype: row.asset_subtype ?? null,
        asset_url: row.asset_url ?? null,
        asset_text: row.asset_text ?? null,
        task_run_id: row.task_run_id ?? null,
        is_current: row.is_current,
        is_locked: meta.is_locked === true,
        locked_at: typeof meta.locked_at === "string" ? meta.locked_at : null,
        created_at: row.created_at,
      };
    }),
  });
});

// ── POST /:slug/assets ────────────────────────────────────────────────────
// Creates a new document business_asset (first edit or first lock).
// Validates that the task_run belongs to this business.
const CreateDocAssetBody = z.object({
  task_run_id: z.string().uuid(),
  asset_text: z.string().optional(),
  is_locked: z.boolean().optional(),
});

app.post("/:slug/assets", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  let parsed: z.infer<typeof CreateDocAssetBody>;
  try {
    parsed = CreateDocAssetBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", err instanceof Error ? err.message : String(err)), 400);
  }

  let business;
  try {
    business = await getBusinessBySlug(supabase, auth.user_id, slug);
  } catch (err) {
    return c.json(errBody("upstream_error", String(err)), 502);
  }
  if (!business) return c.json(errBody("not_found", `business '${slug}' not found`), 404);

  // Verify task_run belongs to this business
  const { data: run } = await supabase
    .from("task_runs")
    .select("id")
    .eq("id", parsed.task_run_id)
    .eq("business_id", business.id)
    .maybeSingle();
  if (!run) return c.json(errBody("not_found", "task_run not found for this business"), 404);

  const isLocked = parsed.is_locked ?? false;
  const nowIso = new Date().toISOString();
  const { data: raw, error } = await supabase
    .from("business_assets")
    .insert({
      business_id: business.id,
      task_run_id: parsed.task_run_id,
      asset_type: "document",
      asset_text: parsed.asset_text ?? null,
      metadata: { is_locked: isLocked, locked_at: isLocked ? nowIso : null },
    })
    .select("id, task_run_id, asset_text, metadata")
    .single();

  if (error) {
    log.error("create_doc_asset_failed", { err: error.message, business_id: business.id });
    return c.json(errBody("upstream_error", error.message), 502);
  }

  const asset = normalizeDocAsset(raw as { id: string; task_run_id: string | null; asset_text: string | null; metadata: Record<string, unknown> | null });
  log.info("[businesses] doc_asset_created", { asset_id: asset.id, business_id: business.id, is_locked: isLocked });
  return c.json({ asset }, 201);
});

// ── PATCH /:slug/assets/:assetId ─────────────────────────────────────────
// Updates asset_text (user edit) or is_locked (finalize) on a document asset.
// Per NO-FALLBACKS: editing a locked document is rejected with 403.
const PatchDocAssetBody = z.object({
  asset_text: z.string().optional(),
  is_locked: z.boolean().optional(),
  asset_url: z.string().optional(),
});

app.patch("/:slug/assets/:assetId", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const assetId = c.req.param("assetId");
  const supabase = createSupabaseClient(c.env);

  let parsed: z.infer<typeof PatchDocAssetBody>;
  try {
    parsed = PatchDocAssetBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", err instanceof Error ? err.message : String(err)), 400);
  }

  let business;
  try {
    business = await getBusinessBySlug(supabase, auth.user_id, slug);
  } catch (err) {
    return c.json(errBody("upstream_error", String(err)), 502);
  }
  if (!business) return c.json(errBody("not_found", `business '${slug}' not found`), 404);

  const { data: existing } = await supabase
    .from("business_assets")
    .select("id, metadata")
    .eq("id", assetId)
    .eq("business_id", business.id)
    .maybeSingle();
  if (!existing) return c.json(errBody("not_found", "asset not found"), 404);

  const existingMeta = existing as { id: string; metadata: Record<string, unknown> | null };
  const currentLock = docAssetMeta(existingMeta);

  // Block text edits on locked documents; allow lock/unlock operations
  if (currentLock.is_locked && parsed.asset_text !== undefined && parsed.is_locked !== false) {
    return c.json(errBody("forbidden", "document is locked and cannot be edited"), 403);
  }

  const updates: Record<string, unknown> = {};
  if (parsed.asset_text !== undefined) updates.asset_text = parsed.asset_text;
  if (parsed.asset_url !== undefined) updates.asset_url = parsed.asset_url.trim() || null;
  if (parsed.is_locked !== undefined) {
    const nowIso = new Date().toISOString();
    updates.metadata = {
      ...(existingMeta.metadata ?? {}),
      is_locked: parsed.is_locked,
      locked_at: parsed.is_locked ? nowIso : null,
    };
  }

  const { data: raw, error } = await supabase
    .from("business_assets")
    .update(updates)
    .eq("id", assetId)
    .select("id, task_run_id, asset_text, metadata")
    .single();

  if (error) {
    log.error("patch_doc_asset_failed", { err: error.message, asset_id: assetId });
    return c.json(errBody("upstream_error", error.message), 502);
  }

  const asset = normalizeDocAsset(raw as { id: string; task_run_id: string | null; asset_text: string | null; metadata: Record<string, unknown> | null });
  log.info("[businesses] doc_asset_updated", {
    asset_id: assetId,
    business_id: business.id,
    is_locked: parsed.is_locked,
    has_text_edit: parsed.asset_text !== undefined,
  });
  return c.json({ asset });
});

function extractOutputSummary(
  slug: string,
  data: Record<string, unknown>,
): string | null {
  const truncate = (s: string, n = 120) =>
    s.length > n ? s.slice(0, n) + "…" : s;

  switch (slug) {
    case "research-strategy":
      return typeof data.reasoning === "string"
        ? truncate(data.reasoning)
        : null;
    case "welcome-email":
      return typeof data.preview === "string"
        ? truncate(data.preview)
        : null;
    case "launch-tweet":
      return typeof data.tweet === "string" ? truncate(data.tweet) : null;
    case "business-landing-page":
      return typeof data.url === "string" ? `Live at ${data.url}` : null;
    case "mission-document":
      return typeof data.mission === "string"
        ? truncate(data.mission)
        : null;
    case "task-queue-built":
      return typeof data.message === "string" ? data.message : null;
    case "dashboard-briefing":
      return typeof data.briefing === "string"
        ? truncate(data.briefing)
        : null;
    case "personalized-pitch-email":
      return typeof data.body_summary === "string"
        ? truncate(data.body_summary)
        : null;
    case "tam-sam-som": {
      const tam = data.tam as Record<string, unknown> | undefined;
      return tam && typeof tam.label === "string"
        ? `TAM: ${tam.label} · SAM/SOM blurred until paid`
        : null;
    }
    case "find-a-unique-business-name":
      return typeof data.business_name === "string"
        ? `Business named: ${data.business_name}`
        : null;
    default:
      return null;
  }
}

// ── GET /:slug/context ───────────────────────────────────────────────────────
// Read-only: the saved business_context for the "Victora Context" page.
app.get("/:slug/context", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);
  const business = await getBusinessBySlug(supabase, auth.user_id, slug).catch(() => null);
  if (!business) return c.json(errBody("not_found", `business '${slug}' not found`), 404);
  const context = await getBusinessContext(supabase, business.id).catch(() => null);
  return c.json({ business: { slug: business.slug, name: business.name }, context });
});

// ── POST /:slug/context/rebuild ──────────────────────────────────────────────
// Refresh business_context from the business's documents. Source docs are chosen
// by tasks.is_context_source (+ tasks.context_fields = the fields that doc may
// own). Extract from EDITED prose (asset_text) first, falling back to the frozen
// asset_data only when a doc was never edited. Gate TIER-1 fields; merge with
// most-specific-source-wins; write a PARTIAL patch (fields no doc covers stay).
const RebuildContextBody = z.object({ source: z.enum(["get-started", "locked"]) });
const MAX_SOURCE_DOCS = 12;

interface RebuildTask {
  slug: string;
  is_context_source: boolean;
  context_fields: string[];
  execution_order: number | null;
}
interface RebuildDoc {
  id: string;
  asset_subtype: string | null;
  asset_text: string | null;
  asset_data: unknown;
  metadata: Record<string, unknown> | null;
  task_runs?: { task_id: string; tasks?: RebuildTask | null } | null;
}

// PostgREST types to-one embeds as arrays; at runtime a single-FK embed is an
// object. Coerce either shape to one value so the code is robust to both.
function toOne<T>(x: unknown): T | null {
  if (Array.isArray(x)) return (x[0] as T) ?? null;
  return (x as T) ?? null;
}

app.post("/:slug/context/rebuild", async (c) => {
  const auth = c.get("auth");
  const slug = c.req.param("slug");
  const supabase = createSupabaseClient(c.env);

  let parsed: z.infer<typeof RebuildContextBody>;
  try {
    parsed = RebuildContextBody.parse(await c.req.json());
  } catch (err) {
    return c.json(errBody("bad_request", "invalid body", err instanceof Error ? err.message : String(err)), 400);
  }

  const business = await getBusinessBySlug(supabase, auth.user_id, slug).catch(() => null);
  if (!business) return c.json(errBody("not_found", `business '${slug}' not found`), 404);

  const ctx = await getBusinessContext(supabase, business.id).catch(() => null);
  if (!ctx) return c.json(errBody("not_found", "no business_context to rebuild"), 404);

  // Candidate docs with their producing task (via task_run -> task).
  const { data: assetRows, error: aErr } = await supabase
    .from("business_assets")
    .select("id, asset_subtype, asset_text, asset_data, metadata, task_runs(task_id, tasks(slug, is_context_source, context_fields, execution_order))")
    .eq("business_id", business.id)
    .eq("asset_type", "document")
    .eq("is_current", true);
  if (aErr) return c.json(errBody("upstream_error", aErr.message), 502);

  // For the get-started choice, resolve the objective's task ids.
  let getStartedTaskIds: Set<string> | null = null;
  if (parsed.source === "get-started") {
    const obj = await supabase.from("objectives").select("id").eq("slug", "get-started").maybeSingle();
    const oid = (obj.data as { id?: string } | null)?.id ?? null;
    const links = oid
      ? await supabase.from("task_objectives").select("task_id").eq("objective_id", oid)
      : { data: [] as { task_id: string }[] };
    getStartedTaskIds = new Set(((links.data as { task_id: string }[]) ?? []).map((r) => r.task_id));
  }

  const docs: RebuildDoc[] = ((assetRows as Record<string, unknown>[]) ?? []).map((r) => {
    const tr = toOne<{ task_id: string; tasks: unknown }>(r.task_runs);
    const tk = tr ? toOne<RebuildTask>(tr.tasks) : null;
    return {
      id: r.id as string,
      asset_subtype: (r.asset_subtype as string | null) ?? null,
      asset_text: (r.asset_text as string | null) ?? null,
      asset_data: r.asset_data,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
      task_runs: tr ? { task_id: tr.task_id, tasks: tk } : null,
    };
  });

  const sources = docs.filter((d) => {
    const t = d.task_runs?.tasks;
    if (!t || t.is_context_source !== true) return false;
    if (!Array.isArray(t.context_fields) || t.context_fields.length === 0) return false;
    if (parsed.source === "locked") return d.metadata?.is_locked === true;
    return getStartedTaskIds!.has(d.task_runs!.task_id);
  });

  const truncated = sources.length > MAX_SOURCE_DOCS;
  const chosenDocs = sources.slice(0, MAX_SOURCE_DOCS);

  if (chosenDocs.length === 0) {
    return c.json({
      written: [], skipped: [], tier1_skipped: [], sources: [], conflicts: [], truncated,
      message: "No context-source documents matched this choice.",
    });
  }

  const anthropic = createAnthropicClient(c.env);
  const models = await loadModelConfig(supabase);

  interface Candidate { field: string; value: unknown; from: string; specificity: number; exec: number }
  const candidates: Candidate[] = [];
  const usedSources: { subtype: string | null; from: string; fields: string[] }[] = [];

  for (const d of chosenDocs) {
    const t = d.task_runs!.tasks!;
    const fields = t.context_fields;
    let extracted: Record<string, unknown> = {};
    let from = "";
    if (d.asset_text && d.asset_text.trim()) {
      extracted = await extractFromText(anthropic, models.sonnet, business.name, d.asset_subtype, d.asset_text, fields);
      from = "asset_text (edited prose)";
    } else {
      const structured = pickStructured(d.asset_data, fields);
      if (Object.keys(structured).length > 0) {
        extracted = structured;
        from = "asset_data (structured, unedited)";
      } else {
        extracted = await extractFromText(anthropic, models.sonnet, business.name, d.asset_subtype, flattenAssetData(d.asset_data), fields);
        from = "asset_data (text, unedited)";
      }
    }
    usedSources.push({ subtype: d.asset_subtype, from, fields: Object.keys(extracted) });
    for (const [field, value] of Object.entries(extracted)) {
      candidates.push({ field, value, from: d.asset_subtype ?? "?", specificity: fields.length, exec: t.execution_order ?? 999 });
    }
  }

  // Per field: most-specific source (smallest context_fields) wins; tie -> execution_order.
  const byField = new Map<string, Candidate[]>();
  for (const cnd of candidates) {
    const arr = byField.get(cnd.field) ?? [];
    arr.push(cnd);
    byField.set(cnd.field, arr);
  }

  const patch: Record<string, unknown> = {};
  const written: { field: string; from: string }[] = [];
  const skipped: { field: string; reason: string; from: string; tier: number }[] = [];
  const conflicts: { field: string; chosen: string; over: string[] }[] = [];

  for (const [field, cands] of byField.entries()) {
    cands.sort((x, y) => x.specificity - y.specificity || x.exec - y.exec);
    const chosen = cands[0];
    if (cands.length > 1) conflicts.push({ field, chosen: chosen.from, over: cands.slice(1).map((c2) => c2.from) });
    const verdict = validateField(field, chosen.value);
    const tier = CONTEXT_FIELD_SHAPES[field]?.tier ?? 3;
    if (verdict.ok) {
      patch[field] = chosen.value;
      written.push({ field, from: chosen.from });
    } else {
      skipped.push({ field, reason: verdict.reason ?? "invalid", from: chosen.from, tier });
    }
  }

  if (Object.keys(patch).length > 0) {
    try {
      await upsertBusinessContext(supabase, { business_id: business.id, user_id: ctx.user_id, ...patch });
    } catch (err) {
      return c.json(errBody("upstream_error", `context write failed: ${String(err)}`), 502);
    }
  }

  log.info("[businesses] context_rebuilt", {
    business_id: business.id, source: parsed.source,
    written: written.map((w) => w.field), skipped_count: skipped.length,
  });

  return c.json({
    written: written.map((w) => w.field),
    written_detail: written,
    skipped,
    tier1_skipped: skipped.filter((s) => s.tier === 1), // surfaced separately for prominent display
    sources: usedSources,
    conflicts,
    truncated,
  });
});

export default app;
