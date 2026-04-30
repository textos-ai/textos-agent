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
  type TaskRow,
  type TaskRunRow,
} from "../services/supabase";
import { errBody } from "../lib/errors";
import { log } from "../lib/logger";

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
      output_type: task.output_type,
      is_default: task.is_default,
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

  return c.json({ tasks: taskList });
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

  return c.json({ business, context });
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
    return c.json(
      errBody(
        "bad_request",
        "invalid request body",
        err instanceof Error ? err.message : err,
      ),
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

  try {
    await createEmptyBusinessContext(supabase, business.id, auth.user_id);
  } catch (err) {
    log.warn("create_empty_context_failed", {
      err: String(err),
      business_id: business.id,
    });
    // Non-fatal
  }

  const context = await getBusinessContext(supabase, business.id).catch(
    () => null,
  );

  return c.json({ business, context }, 201);
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
    case "personal-landing-page":
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
    default:
      return null;
  }
}

export default app;
