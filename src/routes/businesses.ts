import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { requireAuth } from "../lib/jwt";
import {
  createSupabaseClient,
  getBusinessesByUser,
  getBusinessBySlug,
  getBusinessContext,
  getAllActiveTasks,
  getTaskRunsForBusiness,
  countUserBusinesses,
  getUserSubscriptionPlan,
  createBusiness,
  createEmptyBusinessContext,
  setAgentName,
  type TaskRow,
  type TaskRunRow,
} from "../services/supabase";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";
import { pickAgentName } from "../lib/agentNames";

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

  let plan: { business_quota: number } | null = null;
  let businessCount = 0;
  try {
    [plan, businessCount] = await Promise.all([
      getUserSubscriptionPlan(supabase, auth.user_id),
      countUserBusinesses(supabase, auth.user_id),
    ]);
  } catch (err) {
    log.error("quota_check_failed", { err: String(err) });
    return c.json(errBody("upstream_error", String(err)), 502);
  }

  const quota = plan?.business_quota ?? 1;
  if (businessCount >= quota) {
    return c.json(
      errBody(
        "bad_request",
        `business quota reached (${quota} allowed on your current plan)`,
      ),
      400,
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
    const msg = String(err);
    if (msg.toLowerCase().includes("duplicate") || msg.includes("23505")) {
      return c.json(
        errBody("conflict", `slug '${parsed.slug}' is already taken`),
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

function normalizeDocAsset(row: {
  id: string;
  task_run_id: string | null;
  asset_text: string | null;
  metadata: Record<string, unknown> | null;
}) {
  const { is_locked, locked_at } = docAssetMeta(row);
  return { id: row.id, task_run_id: row.task_run_id, asset_text: row.asset_text, is_locked, locked_at };
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
    .select("id, task_run_id, asset_text, metadata")
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

export default app;
